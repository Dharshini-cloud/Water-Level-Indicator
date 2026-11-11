/*
 * =========================================================================================
 * AquaSense Pro — Hardened Industrial 3-Probe Smart Water Controller & Telemetry Node
 * Target Hardware: ESP32 Dev Module (WROOM-32)
 *
 * ARCHITECTURAL HARDENING & SAFETY HIGHLIGHTS:
 *   1. LOCAL SAFETY LAYER: Local 15-minute runtime guard, 5-minute dry-run cutoff, and
 *      sensor plausibility verification (fullWet && !lowWet impossible state).
 *   2. FLASH PERSISTENCE: Safety lockout state is latched to non-volatile flash (Preferences)
 *      so motor fault state survives reboots until explicitly cleared by an operator.
 *   3. INDEPENDENT PROBE DEBOUNCE: Low and Full probes are debounced separately (2.5s)
 *      with pulsed pull-ups to minimize electrolytic corrosion on stainless steel probes.
 *   4. NON-BLOCKING NETWORK STACK: Wi-Fi reconnect and telemetry never stall control loops.
 *      HTTP timeout is capped at 2000ms. Local safety & cutoff run continuously every 50ms.
 *   5. DESIRED-STATE LEASE PROTOCOL: Executes remote manual commands with lease expirations;
 *      automatically falls back to local autonomous hysteresis if network is lost.
 *   6. DUAL CORE COMPATIBILITY: Hardware watchdog supports Arduino-ESP32 Core 2.x and 3.x.
 * =========================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>

// =========================================================================================
// 1. HARDWARE CONFIGURATION & PIN DEFINITIONS
// =========================================================================================
// Probes (Pulsed conduction sensing against tank floor GND)
#define FULL_PROBE       32   // Zone Z2: 100% Top cut-off threshold
#define LOW_PROBE        25   // Zone Z1: 50% Nominal / Refill trigger threshold

// Actuators & Indicators
#define RELAY_PIN        19   // Pump relay (GPIO 19)
#define LOW_LED          14   // Low/Critical Empty LED (Active only in Z0)
#define MEDIUM_LED       27   // Nominal Mid LED (GPIO 27; moved off strapping pin GPIO 12)
#define FULL_LED         33   // Full Capacity LED (Active in Z2)
#define BUZZER_PIN       23   // Audio alarm piezo

const bool RELAY_ACTIVE_LOW = true; // Set true for standard active-low 5V relay modules

// =========================================================================================
// 2. NETWORK CREDENTIALS & ENDPOINTS
// =========================================================================================
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL    = "http://YOUR_PC_IP:5000/api/water-data";

// Shared secret token (Must match DEVICE_TOKEN in backend .env)
const char* DEVICE_TOKEN  = "AQUASENSE_ESP32_SECURE_TOKEN_2026";

// =========================================================================================
// 3. SAFETY TIMING & LOCAL FAULT CODES
// =========================================================================================
#define WDT_TIMEOUT_SECONDS 8              // Watchdog triggers CPU reset if loop hangs > 8s
#define DEBOUNCE_HOLD_MS    2500           // Probe state must remain stable for 2.5s
const unsigned long SEND_INTERVAL = 5000;  // Telemetry heartbeat transmission interval

// Local hardware safety limits (independent of server availability)
const unsigned long LOCAL_MAX_RUNTIME_MS = 15UL * 60 * 1000; // 15 mins local ceiling
const unsigned long LOCAL_DRY_RUN_MS    =  5UL * 60 * 1000; // 5 mins in Z0 without refill

enum FaultCode : uint8_t {
  FAULT_NONE    = 0,
  FAULT_RUNTIME = 1,
  FAULT_DRY_RUN = 2,
  FAULT_SENSOR  = 3  // Impossible physical state: full probe wet while low is dry
};

// =========================================================================================
// 4. SYSTEM STATE & VOLATILE TRACKERS
// =========================================================================================
Preferences prefs;

bool isPumpActive   = false;
bool isSafetyLocked = false;
FaultCode activeFault = FAULT_NONE;
bool isBootPacket   = true;
bool initialStabilized = false;

// Desired state & remote lease
String remoteMode       = "AUTO";
bool remoteTargetPump   = false;
unsigned long remoteExpiresAt = 0;

// Debounce state for each individual probe
bool rawLowCandidate   = false;
bool rawFullCandidate  = false;
unsigned long lowCandidateStart  = 0;
unsigned long fullCandidateStart = 0;
bool debouncedLowWet   = false;
bool debouncedFullWet  = false;

// Timers
unsigned long pumpOnSince      = 0;
unsigned long bootTimestamp    = 0;
unsigned long lastSendTime     = 0;
unsigned long lastWifiAttempt  = 0;

// Non-blocking buzzer state
unsigned long buzzerOffTime    = 0;

// =========================================================================
// 5. ACTUATOR & ALARM CONTROLS
// =========================================================================
void setPump(bool state) {
  if (state && isSafetyLocked) {
    Serial.println(">> [SAFETY INTERLOCK] Blocked pump ON: Safety lock is engaged!");
    return;
  }

  if (state && !isPumpActive) {
    pumpOnSince = millis();
  }

  isPumpActive = state;
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, state ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, state ? HIGH : LOW);
  }
}

void triggerBeepNonBlocking(unsigned long durationMs) {
  digitalWrite(BUZZER_PIN, HIGH);
  buzzerOffTime = millis() + durationMs;
}

void updateBuzzer() {
  if (buzzerOffTime > 0 && millis() >= buzzerOffTime) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOffTime = 0;
  }
}

// =========================================================================
// 6. PERSISTENT SAFETY FAULT LATCH (FLASH MEMORY)
// =========================================================================
void latchFault(FaultCode code) {
  isSafetyLocked = true;
  activeFault = code;
  setPump(false); // Immediate hardware shut-off

  prefs.begin("aquasense", false);
  prefs.putUChar("fault", (uint8_t)code);
  prefs.end();

  triggerBeepNonBlocking(500);
  Serial.print(">> [LOCAL SAFETY TRIP] Latched fault code: ");
  Serial.println((int)code);
}

void clearSafetyFault() {
  isSafetyLocked = false;
  activeFault = FAULT_NONE;

  prefs.begin("aquasense", false);
  prefs.putUChar("fault", (uint8_t)FAULT_NONE);
  prefs.end();

  triggerBeepNonBlocking(150);
  Serial.println(">> [SAFETY RESET] Safety lock cleared in flash memory and RAM.");
}

// =========================================================================
// 7. SENSING WITH PULSED PULL-UPS (CORROSION RESISTANT)
// =========================================================================
// Pulses internal pull-up only during sampling to prevent galvanic probe corrosion
bool readProbePulsed(int pin) {
  pinMode(pin, INPUT_PULLUP);
  delayMicroseconds(60); // Allow capacitance to charge

  int detections = 0;
  for (int i = 0; i < 5; i++) {
    if (digitalRead(pin) == LOW) detections++;
    delayMicroseconds(200);
  }

  pinMode(pin, INPUT); // Return to high-impedance mode
  return (detections >= 3);
}

void sampleAndDebounceProbes() {
  bool currentRawLow  = readProbePulsed(LOW_PROBE);
  bool currentRawFull = readProbePulsed(FULL_PROBE);
  unsigned long now   = millis();

  // Debounce Low Probe independently
  if (currentRawLow != rawLowCandidate) {
    rawLowCandidate = currentRawLow;
    lowCandidateStart = now;
  }
  if (now - lowCandidateStart >= DEBOUNCE_HOLD_MS) {
    debouncedLowWet = rawLowCandidate;
  }

  // Debounce Full Probe independently
  if (currentRawFull != rawFullCandidate) {
    rawFullCandidate = currentRawFull;
    fullCandidateStart = now;
  }
  if (now - fullCandidateStart >= DEBOUNCE_HOLD_MS) {
    debouncedFullWet = rawFullCandidate;
  }

  if (!initialStabilized && (now - bootTimestamp >= DEBOUNCE_HOLD_MS)) {
    initialStabilized = true;
    Serial.println("[SYSTEM] Initial probe debounce stabilized. Automation armed.");
  }
}

// Compute level integer (0, 50, 100)
int getDebouncedLevel() {
  if (debouncedFullWet) return 100;
  if (debouncedLowWet)  return 50;
  return 0;
}

// =========================================================================
// 8. LOCAL AUTOMATION & SAFETY LOGIC
// =========================================================================
void evaluateLocalSafety() {
  // 1. Plausibility check: Cannot be wet at the top if dry at the bottom!
  if (debouncedFullWet && !debouncedLowWet) {
    if (activeFault != FAULT_SENSOR) {
      latchFault(FAULT_SENSOR);
    }
    return;
  }

  // 2. Continuous runtime guard
  if (isPumpActive) {
    unsigned long runDuration = millis() - pumpOnSince;
    if (runDuration > LOCAL_MAX_RUNTIME_MS) {
      if (activeFault != FAULT_RUNTIME) {
        latchFault(FAULT_RUNTIME);
      }
    } else if (!debouncedLowWet && runDuration > LOCAL_DRY_RUN_MS) {
      if (activeFault != FAULT_DRY_RUN) {
        latchFault(FAULT_DRY_RUN);
      }
    }
  }
}

void processPumpControl() {
  if (isSafetyLocked || !initialStabilized) {
    if (isPumpActive) setPump(false);
    return;
  }

  unsigned long now = millis();
  bool isRemoteLeaseActive = (remoteExpiresAt > now);

  // Check if remote MANUAL mode is active and leased
  if (remoteMode == "MANUAL" && isRemoteLeaseActive) {
    if (remoteTargetPump) {
      if (!debouncedFullWet) {
        setPump(true);
      } else {
        setPump(false); // Local overfill interlock
      }
    } else {
      setPump(false); // Manual stop commanded (does NOT lock safety!)
    }
  } else {
    // Autonomous local hysteresis (AUTO mode or expired lease)
    if (!debouncedLowWet) {
      // Water dropped below Low probe -> Start refill
      if (!isPumpActive) {
        Serial.println("[AUTO] Reservoir below Low probe (Z0). Starting pump.");
        setPump(true);
        triggerBeepNonBlocking(200);
      }
    } else if (debouncedFullWet) {
      // Water reached Full probe -> Cut-off
      if (isPumpActive) {
        Serial.println("[AUTO] Reservoir reached Full probe (Z2). Cut-off engaged.");
        setPump(false);
        triggerBeepNonBlocking(150);
      }
    }
  }
}

void updateLEDs() {
  int level = getDebouncedLevel();
  // Low LED: Active strictly when water is low (Z0)
  digitalWrite(LOW_LED,    (level <= 0)                  ? HIGH : LOW);
  // Medium LED: Active when at nominal mid level (Z1)
  digitalWrite(MEDIUM_LED, (level >= 50 && level < 100)  ? HIGH : LOW);
  // Full LED: Active when at full capacity (Z2)
  digitalWrite(FULL_LED,   (level >= 100)                ? HIGH : LOW);
}

// =========================================================================
// 9. NON-BLOCKING WI-FI & TELEMETRY CLIENT
// =========================================================================
void checkWiFiAsync() {
  if (WiFi.status() == WL_CONNECTED) return;

  unsigned long now = millis();
  if (now - lastWifiAttempt >= 10000) {
    lastWifiAttempt = now;
    Serial.println("[Wi-Fi] Attempting non-blocking connection to SSID...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

void parsePiggybackResponse(const String& json) {
  // 1. Safety reset command from operator
  if (json.indexOf("\"resetSafety\":true") >= 0) {
    if (isSafetyLocked) {
      clearSafetyFault();
    }
  }

  // 2. Remote safety lock directive
  if (json.indexOf("\"safetyLock\":true") >= 0) {
    if (!isSafetyLocked) {
      latchFault(FAULT_RUNTIME);
    }
  }

  // 3. Desired mode and target pump lease
  if (json.indexOf("\"mode\":\"MANUAL\"") >= 0) {
    remoteMode = "MANUAL";
    remoteTargetPump = (json.indexOf("\"targetPump\":true") >= 0);
    remoteExpiresAt = millis() + 15000; // 15-second local lease
  } else if (json.indexOf("\"mode\":\"AUTO\"") >= 0) {
    remoteMode = "AUTO";
  }
}

void transmitTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(2000); // 2000ms max timeout to prevent watchdog starvation
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-token", DEVICE_TOKEN);

  int level = getDebouncedLevel();

  String payload = "{";
  payload += "\"waterLevel\":" + String(level) + ",";
  payload += "\"rawProbes\":{\"lowWet\":" + String(debouncedLowWet ? "true" : "false") + ",\"fullWet\":" + String(debouncedFullWet ? "true" : "false") + "},";
  payload += "\"pump\":" + String(isPumpActive ? "true" : "false") + ",";
  payload += "\"safetyLocked\":" + String(isSafetyLocked ? "true" : "false") + ",";
  payload += "\"faultCode\":" + String((int)activeFault) + ",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"freeHeap\":" + String(ESP.getFreeHeap()) + ",";
  payload += "\"uptime\":" + String((millis() - bootTimestamp) / 1000) + ",";
  payload += "\"resetReason\":" + String((int)esp_reset_reason()) + ",";
  payload += "\"isBoot\":" + String(isBootPacket ? "true" : "false");
  payload += "}";

  int httpCode = http.POST(payload);
  if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
    String response = http.getString();
    parsePiggybackResponse(response);
    isBootPacket = false;
  } else {
    Serial.print("[HTTP] Telemetry post result: ");
    Serial.println(httpCode);
  }

  http.end();
}

// =========================================================================
// 10. SETUP & MAIN LOOP
// =========================================================================
void setup() {
  bootTimestamp = millis();

  // 1. BOOT-SAFE STATE: Guarantee relay is physically OFF before Wi-Fi or code init
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
  isPumpActive = false;

  Serial.begin(115200);
  delay(300);
  Serial.println("\n========================================================");
  Serial.println("  AquaSense Pro — Hardened REP Controller (Boot-Safe)    ");
  Serial.println("========================================================");

  // 2. Read Persistent Fault Lock from Non-Volatile Flash
  prefs.begin("aquasense", false);
  uint8_t storedFault = prefs.getUChar("fault", (uint8_t)FAULT_NONE);
  prefs.end();

  if (storedFault != (uint8_t)FAULT_NONE) {
    isSafetyLocked = true;
    activeFault = (FaultCode)storedFault;
    Serial.print("[WARNING] Restored latched safety lockout from flash. Fault code: ");
    Serial.println((int)storedFault);
  }

  // 3. Initialize Hardware Task Watchdog (Core 2.x & 3.x Dual Compatible)
#if defined(ESP_IDF_VERSION_MAJOR) && (ESP_IDF_VERSION_MAJOR >= 5)
  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  if (esp_task_wdt_init(&wdt_config) != ESP_OK) {
    esp_task_wdt_reconfigure(&wdt_config);
  }
  esp_task_wdt_add(NULL);
#else
  esp_task_wdt_init(WDT_TIMEOUT_SECONDS, true);
  esp_task_wdt_add(NULL);
#endif
  Serial.println("[SYSTEM] Hardware Task Watchdog initialized (8s timeout).");

  // 4. Configure Pins
  pinMode(FULL_PROBE, INPUT);
  pinMode(LOW_PROBE,  INPUT);
  pinMode(LOW_LED,    OUTPUT);
  pinMode(MEDIUM_LED, OUTPUT);
  pinMode(FULL_LED,   OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(LOW_LED, LOW);
  digitalWrite(MEDIUM_LED, LOW);
  digitalWrite(FULL_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  triggerBeepNonBlocking(150);

  // 5. Trigger Non-blocking Wi-Fi Begin
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttempt = millis();
}

void loop() {
  // 1. Hardware Sensing & Debouncing (Every 50ms)
  sampleAndDebounceProbes();

  // 2. Local Safety Checks (Sensor plausibility, dry-run, max runtime)
  evaluateLocalSafety();

  // 3. Actuator & Hysteresis Automation Control
  processPumpControl();

  // 4. LED & Buzzer Status Updates
  updateLEDs();
  updateBuzzer();

  // 5. Non-Blocking Wi-Fi Management
  checkWiFiAsync();

  // 6. Telemetry Dispatch (Event-Driven on Change, or Heartbeat Interval)
  static int lastTransmittedLevel = -1;
  static bool lastTransmittedPump = false;
  int currentLevel = getDebouncedLevel();
  unsigned long now = millis();

  bool stateChanged = (currentLevel != lastTransmittedLevel) || (isPumpActive != lastTransmittedPump);
  if (stateChanged || (now - lastSendTime >= SEND_INTERVAL)) {
    lastTransmittedLevel = currentLevel;
    lastTransmittedPump = isPumpActive;
    lastSendTime = now;
    transmitTelemetry();
  }

  // 7. Feed Hardware Task Watchdog
  esp_task_wdt_reset();

  delay(50); // 50ms fast responsive loop
}
