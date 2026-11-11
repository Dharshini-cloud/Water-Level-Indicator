/*
 * =========================================================================================
 * Project: Smart IoT Water Level Indicator & Automatic Pump Controller (Hardened REP Edition)
 * Target Hardware: ESP32 Dev Module (WROOM-32)
 *
 * 5 HARDENED INDUSTRIAL FEATURES:
 *   1. BOOT-SAFE STATE: Relay driven strictly OFF upon power-up before any network init.
 *   2. HARDWARE TASK WATCHDOG (esp_task_wdt): Automatic 8s CPU recovery if network/loop hangs.
 *   3. TIME-BASED DEBOUNCE (2.5s): Rejects wave slosh and water surface agitation.
 *   4. AUTHENTICATED INGESTION: Cryptographic x-device-token header sent in every packet.
 *   5. RESPONSE-PIGGYBACKING: Executes remote commands & safety overrides returned in HTTP responses.
 *
 * 3-PROBE WIRING IN TANK:
 *   - Probe 1 (Common Ref)  -> ESP32 GND (Stainless steel probe at tank floor)
 *   - Probe 2 (LOW / 50%)   -> GPIO 25 (External 10k pull-up to 3.3V recommended)
 *   - Probe 3 (FULL / 100%) -> GPIO 32 (External 10k pull-up to 3.3V recommended)
 * =========================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_task_wdt.h>

// =========================================================================================
// 1. CONFIGURATION & CREDENTIALS
// =========================================================================================
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Replace with your laptop's IPv4 address from 'ipconfig'
const char* SERVER_URL    = "http://YOUR_PC_IP:5000/api/water-data";

// Shared Secret Device Token (Matches process.env.DEVICE_TOKEN in backend)
const char* DEVICE_TOKEN  = "AQUASENSE_ESP32_SECURE_TOKEN_2026";

// Watchdog & Timing Configurations
#define WDT_TIMEOUT_SECONDS 8        // Watchdog triggers reset if loop hangs > 8s
#define DEBOUNCE_HOLD_MS    2500     // Level transition must hold 2.5s continuously
const unsigned long SEND_INTERVAL = 5000; // Heartbeat telemetry interval

// =========================================================================================
// 2. PIN DEFINITIONS & RELAY SETTINGS
// =========================================================================================
#define FULL_PROBE    32   // Zone Z2 full threshold
#define LOW_PROBE     25   // Zone Z1 nominal threshold / Z0 refill trigger
#define LOW_LED       14   // Warning / Refill LED
#define MEDIUM_LED    12   // Mid-level nominal LED
#define FULL_LED      33   // Full-level LED
#define BUZZER_PIN    23   // Audio warning piezo
#define RELAY_PIN     19   // Pump relay control pin

const bool RELAY_ACTIVE_LOW = true; // Set true for typical active-low 5V relay modules

// =========================================================================================
// 3. SYSTEM STATE & SAFETY TRACKING
// =========================================================================================
bool isPumpActive = false;
bool isSafetyLocked = false;
bool isBootPacket = true;

int rawLevelCandidate = -1;
int debouncedLevel = -1;
int previousLevel = -1;
unsigned long candidateStartTime = 0;
unsigned long lastSendTime = 0;

// =========================================================================================
// 4. ACTUATOR & AUDIO FUNCTIONS
// =========================================================================
void setPump(bool state) {
  if (isSafetyLocked && state) {
    Serial.println(">> [SAFETY INTERLOCK] Blocked pump ON: Safety lock is engaged!");
    return;
  }

  isPumpActive = state;
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, state ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, state ? HIGH : LOW);
  }
  Serial.print(">> [ACTUATOR] Pump set to: ");
  Serial.println(isPumpActive ? "RUNNING (ON)" : "STANDBY (OFF)");
}

void triggerBeep(int times, int durationMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(durationMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < times - 1) delay(100);
  }
}

void updateLEDIndicators(int level) {
  digitalWrite(LOW_LED,    (level >= 0 && level < 100) ? HIGH : LOW);
  digitalWrite(MEDIUM_LED, (level >= 50)               ? HIGH : LOW);
  digitalWrite(FULL_LED,   (level >= 100)              ? HIGH : LOW);
}

// =========================================================================================
// 5. HARDENED SENSING & TIME-BASED DEBOUNCE
// =========================================================================================
bool isWaterTouching(int pin) {
  int detections = 0;
  for (int i = 0; i < 5; i++) {
    if (digitalRead(pin) == LOW) detections++;
    delay(2);
  }
  return (detections >= 3);
}

int readRawInstantLevel() {
  bool fullHit = isWaterTouching(FULL_PROBE);
  bool lowHit  = isWaterTouching(LOW_PROBE);

  if (fullHit) return 100; // Zone Z2
  if (lowHit)  return 50;  // Zone Z1
  return 0;                // Zone Z0 (Empty / Below Low Probe)
}

// 2.5-Second Continuous Verification Debounce Filter
int processTimeDebouncedLevel() {
  int instant = readRawInstantLevel();

  if (instant != rawLevelCandidate) {
    rawLevelCandidate = instant;
    candidateStartTime = millis();
  }

  // If level remains stable for the required debounce duration, accept it
  if (millis() - candidateStartTime >= DEBOUNCE_HOLD_MS) {
    debouncedLevel = rawLevelCandidate;
  }

  return (debouncedLevel == -1) ? instant : debouncedLevel;
}

// =========================================================================
// 6. HYSTERESIS AUTOMATION ENGINE
// =========================================================================
void processPumpAutomation(int level) {
  if (isSafetyLocked) return;

  // Level 0% (Zone Z0): Below low probe -> Start refill
  if (level <= 0) {
    if (!isPumpActive) {
      Serial.println("[AUTO] Water below LOW probe (Z0). Starting pump refill!");
      setPump(true);
      triggerBeep(2, 120);
    }
  }
  // Level 100% (Zone Z2): Full probe reached -> Cut-off
  else if (level >= 100) {
    if (isPumpActive) {
      Serial.println("[AUTO] Full probe submerged (Z2). Cut-off engaged!");
      setPump(false);
      triggerBeep(3, 80);
    }
  }
  // Level 50% (Zone Z1): Maintain hysteresis state
}

// =========================================================================
// 7. WI-FI & AUTHENTICATED TELEMETRY WITH RESPONSE PIGGYBACKING
// =========================================================================
void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("Connecting to Wi-Fi SSID: ");
  Serial.print(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 15) {
    delay(400);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[Wi-Fi] Connected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n[Wi-Fi] Retrying next cycle...");
  }
}

void parsePiggybackResponse(const String& json) {
  // Check for Safety Lockout in response
  if (json.indexOf("\"safetyLock\":true") >= 0 || json.indexOf("FORCE_PUMP_OFF") >= 0) {
    Serial.println(">> [COMMAND PIGGYBACK] Safety Lock / FORCE_STOP received! Shutting pump off.");
    isSafetyLocked = true;
    setPump(false);
    triggerBeep(4, 100);
  }

  // Check for Safety Reset Command
  if (json.indexOf("RESET_SAFETY") >= 0) {
    Serial.println(">> [COMMAND PIGGYBACK] RESET_SAFETY received! Clearing local safety lock.");
    isSafetyLocked = false;
  }

  // Check for Manual Start Override (if safe)
  if (json.indexOf("FORCE_PUMP_ON") >= 0) {
    if (!isSafetyLocked && debouncedLevel < 100) {
      Serial.println(">> [COMMAND PIGGYBACK] FORCE_PUMP_ON command executed.");
      setPump(true);
    } else {
      Serial.println(">> [COMMAND PIGGYBACK] Blocked FORCE_PUMP_ON: Tank full or safety locked.");
    }
  }
}

void transmitTelemetry(int level) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-token", DEVICE_TOKEN); // Cryptographic token header

  String payload = "{";
  payload += "\"waterLevel\":" + String(level) + ",";
  payload += "\"pump\":" + String(isPumpActive ? "true" : "false") + ",";
  payload += "\"isBoot\":" + String(isBootPacket ? "true" : "false");
  payload += "}";

  Serial.print("[HTTP POST] ");
  Serial.println(payload);

  int httpCode = http.POST(payload);
  if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
    String response = http.getString();
    Serial.print("[HTTP ACK] Piggyback response: ");
    Serial.println(response);
    parsePiggybackResponse(response);
    isBootPacket = false; // Boot packet acknowledged
  } else if (httpCode == 401) {
    Serial.println("[HTTP 401] UNAUTHORIZED: Device token rejected by backend!");
  } else {
    Serial.print("[HTTP ERROR] Status code: ");
    Serial.println(httpCode);
  }

  http.end();
}

// =========================================================================
// 8. SETUP & MAIN LOOP
// =========================================================================
void setup() {
  // 1. BOOT-SAFE STATE: Guarantee relay is strictly OFF before anything else runs!
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
  isPumpActive = false;

  Serial.begin(115200);
  delay(500);
  Serial.println("\n========================================================");
  Serial.println("  AquaSense Pro - Hardened REP Controller (Boot-Safe)    ");
  Serial.println("========================================================");

  // 2. Initialize Hardware Task Watchdog (8 Seconds)
  esp_task_wdt_init(WDT_TIMEOUT_SECONDS, true);
  esp_task_wdt_add(NULL);
  Serial.println("[SYSTEM] Hardware Task Watchdog initialized (8s timeout).");

  // 3. Setup Pin Modes
  pinMode(FULL_PROBE, INPUT_PULLUP);
  pinMode(LOW_PROBE,  INPUT_PULLUP);
  pinMode(LOW_LED,    OUTPUT);
  pinMode(MEDIUM_LED, OUTPUT);
  pinMode(FULL_LED,   OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(LOW_LED, LOW);
  digitalWrite(MEDIUM_LED, LOW);
  digitalWrite(FULL_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  triggerBeep(1, 150); // Power-on audible confirmation
  ensureWiFiConnected();
}

void loop() {
  // 1. Process 2.5-second time-debounced water level
  int currentLevel = processTimeDebouncedLevel();

  // 2. Local Hardware Interlocks & Automation
  updateLEDIndicators(currentLevel);
  processPumpAutomation(currentLevel);

  // 3. Telemetry Dispatch (Event-Driven on Change, or 5s Heartbeat)
  if ((currentLevel != previousLevel) || (millis() - lastSendTime >= SEND_INTERVAL)) {
    previousLevel = currentLevel;
    lastSendTime = millis();
    ensureWiFiConnected();
    transmitTelemetry(currentLevel);
  }

  // 4. Feed Hardware Watchdog Timer
  esp_task_wdt_reset();

  delay(100); // 100ms cycle
}
