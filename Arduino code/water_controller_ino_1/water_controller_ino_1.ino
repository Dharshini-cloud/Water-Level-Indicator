/*
 * =========================================================================================
 * Project: Smart Water Level Indicator & Automatic Pump Controller
 * Hardware: ESP32 Dev Module (WROOM-32)
 *
 * ── HARDWARE WIRING SPECIFICATION ────────────────────────────────────────────────────────
 *  1. LEDs (Connect with 220Ω or 330Ω current-limiting resistors to GND):
 *     - WHITE LED   (Low Level)    : Anode (+) -> GPIO 18, Cathode (-) -> 330Ω -> ESP32 GND
 *     - YELLOW LED  (Medium Level) : Anode (+) -> GPIO 17, Cathode (-) -> 330Ω -> ESP32 GND
 *     - GREEN LED   (High/Full)    : Anode (+) -> GPIO 16, Cathode (-) -> 330Ω -> ESP32 GND
 *
 *  2. BUZZER:
 *     - Positive (+) -> GPIO 19, Negative (-) -> ESP32 GND
 *
 *  3. MOTOR RELAY (via BC547 NPN Transistor):
 *     - ESP32 GPIO 23 -> 1kΩ Resistor -> BC547 Base (B)
 *     - BC547 Collector (C) -> Relay IN
 *     - BC547 Emitter (E)   -> ESP32 GND
 *     - Relay VCC -> 5V, Relay GND -> ESP32 GND
 *     - Relay COM -> Motor Pump (+) wire
 *     - Relay NO  -> Power Supply (+) for Motor Pump
 *
 * ── EXACT TIMING & SEQUENCE OPERATION ─────────────────────────────────────────────────────
 *  1. First 4 seconds (0s - 4s)   : ONLY LEDs remain OFF. MOTOR IS ON!
 *
 *  2. Next 4 seconds (4s - 8s)    : White (Low) LED turns ON. Motor remains ON.
 *                                   (Yellow LED OFF, Green LED OFF, Buzzer OFF)
 *
 *  3. Next 4 seconds (8s - 12s)   : White LED OFF, Yellow (Mid) LED turns ON. Motor remains ON.
 *                                   (Green LED OFF, Buzzer OFF)
 *
 *  4. High Level (12s onward)     : Yellow LED OFF, Green (High) LED turns ON, Buzzer ON,
 *                                   MOTOR TURNS OFF AND STAYS OFF!
 * =========================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>

// =========================================================================================
// 1. PIN DEFINITIONS
// =========================================================================================
#define PIN_LED_WHITE         18   // White LED (Low level indicator)
#define PIN_LED_YELLOW        17   // Yellow LED (Medium level indicator)
#define PIN_LED_GREEN         16   // Green LED (High / Full level indicator)
#define PIN_BUZZER            19   // Piezo Buzzer pin
#define PIN_MOTOR_RELAY       23   // Motor Pump Relay Control Pin (via BC547 Base)

// =========================================================================================
// 2. WI-FI & WEBSITE DASHBOARD TELEMETRY SETTINGS
// =========================================================================================
const char* WIFI_SSID     = "Kuttyyy";
const char* WIFI_PASSWORD = "jaya162007";
const char* SERVER_URL    = "http://10.157.61.118:5000/api/water-data";
const char* DEVICE_TOKEN  = "AQUASENSE_ESP32_SECURE_TOKEN_2026";

// =========================================================================================
// 3. 4-SECOND TIMING CONFIGURATION
// =========================================================================================
const unsigned long STAGE_INIT_TIME = 4000;   // 0s to 4s:   Only LEDs OFF, Motor ON!
const unsigned long STAGE_LOW_TIME  = 8000;   // 4s to 8s:   White (Low) LED ON, Motor ON
const unsigned long STAGE_MID_TIME  = 12000;  // 8s to 12s:  Yellow (Mid) LED ON, Motor remains ON
// After 12s: High (Green) LED ON, Buzzer ON, Motor turns OFF and stays OFF!

// REPEAT_CYCLE: false ensures motor stays OFF once tank reaches High/Full
const bool REPEAT_CYCLE = false; 

// Relay polarity with BC547 driver: HIGH turns relay ON
const bool RELAY_ACTIVE_HIGH = true;

// =========================================================================================
// 4. STATE TRACKING VARIABLES
// =========================================================================================
unsigned long sequenceStartTime = 0;
bool isMotorRunning = false;
unsigned long lastPrintTime = 0;

// Non-blocking telemetry state shared with Core 0 background task
volatile int telemetryWaterPercent = 0;
volatile bool telemetryPumpState = false;
volatile bool telemetryTrigger = false;

void setMotor(bool turnOn) {
  isMotorRunning = turnOn;
  digitalWrite(PIN_MOTOR_RELAY, (RELAY_ACTIVE_HIGH ? turnOn : !turnOn) ? HIGH : LOW);
}

void setBuzzer(bool turnOn) {
  digitalWrite(PIN_BUZZER, turnOn ? HIGH : LOW);
}

// Background FreeRTOS task on Core 0 so Wi-Fi/HTTP NEVER blocks the timing
void backgroundTelemetryTask(void * pvParameters) {
  unsigned long lastSync = 0;
  for(;;) {
    if (WiFi.status() == WL_CONNECTED) {
      if (telemetryTrigger || (millis() - lastSync >= 3000)) {
        telemetryTrigger = false;
        lastSync = millis();

        HTTPClient http;
        http.begin(SERVER_URL);
        http.setTimeout(1000);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("x-device-token", DEVICE_TOKEN);

        String payload = "{";
        payload += "\"waterLevel\":" + String(telemetryWaterPercent) + ",";
        payload += "\"pump\":" + String(telemetryPumpState ? "true" : "false");
        payload += "}";

        http.POST(payload);
        http.end();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// =========================================================================================
// 5. SETUP FUNCTION
// =========================================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n=================================================================");
  Serial.println("  Smart Water Level Controller Initialized                       ");
  Serial.println("=================================================================");
  Serial.println("  1. 0s - 4s   : LEDs OFF | MOTOR IS ON (Initial 4 Seconds)      ");
  Serial.println("  2. 4s - 8s   : White (Low) LED ON  | Motor REMAINS ON          ");
  Serial.println("  3. 8s - 12s  : Yellow (Mid) LED ON | Motor REMAINS ON          ");
  Serial.println("  4. 12s onward: Green (High) LED ON | Buzzer ON | MOTOR OFF     ");
  Serial.println("=================================================================\n");

  pinMode(PIN_LED_WHITE,   OUTPUT);
  pinMode(PIN_LED_YELLOW,  OUTPUT);
  pinMode(PIN_LED_GREEN,   OUTPUT);
  pinMode(PIN_BUZZER,      OUTPUT);
  pinMode(PIN_MOTOR_RELAY, OUTPUT);

  // Initially: ONLY LEDs are OFF, Motor is ON!
  digitalWrite(PIN_LED_WHITE,  LOW);
  digitalWrite(PIN_LED_YELLOW, LOW);
  digitalWrite(PIN_LED_GREEN,  LOW);
  setBuzzer(false);
  setMotor(true); // Motor starts ON immediately!

  // Start background Wi-Fi without blocking
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Spawn non-blocking background telemetry task on Core 0
  xTaskCreatePinnedToCore(backgroundTelemetryTask, "telemetryTask", 4096, NULL, 1, NULL, 0);

  Serial.println(">> [INITIAL 0s - 4s] Only LEDs are OFF | MOTOR IS ON...\n");
  sequenceStartTime = millis();
}

// =========================================================================================
// 6. MAIN LOOP (Runs on Core 1)
// =========================================================================================
void loop() {
  unsigned long elapsed = millis() - sequenceStartTime;

  // Optional cycle repeat if enabled
  if (REPEAT_CYCLE && elapsed >= 16000) {
    sequenceStartTime = millis();
    elapsed = 0;
    Serial.println("\n>> [CYCLE REPEAT] Restarting sequence...\n");
  }

  // ── STAGE 0 (0 to 4 Seconds): ONLY LEDs OFF, MOTOR IS ON! ────────────────────────────
  if (elapsed < STAGE_INIT_TIME) {
    digitalWrite(PIN_LED_WHITE,  LOW);   // White LED OFF
    digitalWrite(PIN_LED_YELLOW, LOW);   // Yellow LED OFF
    digitalWrite(PIN_LED_GREEN,  LOW);   // Green LED OFF
    setBuzzer(false);                    // Buzzer OFF
    setMotor(true);                      // MOTOR IS ON!

    telemetryWaterPercent = 0;
    telemetryPumpState = true;
  }
  // ── STAGE 1 (4 to 8 Seconds): White (Low) LED turns ON, Motor remains ON ─────────────
  else if (elapsed < STAGE_LOW_TIME) {
    digitalWrite(PIN_LED_WHITE,  HIGH);  // White (Low) LED ON
    digitalWrite(PIN_LED_YELLOW, LOW);   // Yellow LED OFF
    digitalWrite(PIN_LED_GREEN,  LOW);   // Green LED OFF
    setBuzzer(false);                    // Buzzer OFF
    setMotor(true);                      // Motor continues running

    telemetryWaterPercent = 35;
    telemetryPumpState = true;
  }
  // ── STAGE 2 (8 to 12 Seconds): Yellow (Mid) LED ON, Motor remains ON ──────────────────
  else if (elapsed < STAGE_MID_TIME) {
    digitalWrite(PIN_LED_WHITE,  LOW);   // White LED OFF
    digitalWrite(PIN_LED_YELLOW, HIGH);  // Yellow (Mid) LED ON
    digitalWrite(PIN_LED_GREEN,  LOW);   // Green LED OFF
    setBuzzer(false);                    // Buzzer OFF
    setMotor(true);                      // Motor continues running

    telemetryWaterPercent = 70;
    telemetryPumpState = true;
  }
  // ── STAGE 3 (12 Seconds onward): Green (High) LED ON, Buzzer ON, MOTOR OFF ────────────
  else {
    digitalWrite(PIN_LED_WHITE,  LOW);   // White LED OFF
    digitalWrite(PIN_LED_YELLOW, LOW);   // Yellow LED OFF
    digitalWrite(PIN_LED_GREEN,  HIGH);  // Green (High) LED ON
    setBuzzer(true);                     // Buzzer ON (Tank is Full!)
    setMotor(false);                     // Motor turns OFF and stays OFF!

    telemetryWaterPercent = 100;
    telemetryPumpState = false;
  }

  // Status printout to Serial Monitor every 500ms
  unsigned long currentMillis = millis();
  if (currentMillis - lastPrintTime >= 500) {
    lastPrintTime = currentMillis;
    Serial.print("[TIME: ");
    Serial.print(elapsed / 1000.0, 1);
    Serial.print("s] ");

    if (elapsed < STAGE_INIT_TIME) {
      Serial.println("STAGE 0 (0-4s)      -> ONLY LEDS: OFF | MOTOR: ON (RUNNING)");
    } else if (elapsed < STAGE_LOW_TIME) {
      Serial.println("STAGE 1 (4-8s)      -> WHITE (LOW): ON | YELLOW: OFF | GREEN: OFF | MOTOR: ON");
    } else if (elapsed < STAGE_MID_TIME) {
      Serial.println("STAGE 2 (8-12s)     -> WHITE: OFF | YELLOW (MID): ON | GREEN: OFF | MOTOR: ON");
    } else {
      Serial.println("STAGE 3 (TANK FULL) -> WHITE: OFF | YELLOW: OFF | GREEN (HIGH): ON | BUZZER: ON | MOTOR: OFF");
    }
  }

  // Interactive Serial shortcut: press 'r' to restart sequence from 0s
  if (Serial.available()) {
    char c = (char)Serial.read();
    if (c == 'r' || c == 'R') {
      sequenceStartTime = millis();
      Serial.println("\n>> [RESTART] Sequence restarted from 0s!\n");
    }
  }

  delay(20);
}
