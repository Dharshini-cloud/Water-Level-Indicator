# AquaSense Pro — Hardened IoT Water Level & Safety Management System

An industrial-grade, full-stack IoT water automation controller engineered for reliability, safety, and explainable predictive analytics.

---

## 1. System Architecture

```text
                 ┌────────────────────────────────┐
                 │       WATER RESERVOIR          │
                 │   Stainless-Steel Probes       │
                 │   (P1: GND, P2: Z1, P3: Z2)   │
                 └───────────────┬────────────────┘
                                 │ External 10kΩ Pull-Ups to 3.3V
                                 ▼
                     ┌───────────────────────┐
                     │     ESP32 DEV MODULE  │
                     │  - Boot-Safe Relay    │
                     │  - Task Watchdog (8s) │
                     │  - 2.5s Debounce      │
                     │  - Token Auth Client  │
                     └───────────┬───────────┘
                                 │ Authenticated HTTP POST (Piggyback Command ACK)
                                 ▼
                     ┌───────────────────────┐
                     │     NODE.JS BACKEND   │
                     │  - Safety Timeout     │
                     │  - Dry-Run Detection  │
                     │  - Zone Crossing AI   │
                     │  - Interlock Engine   │
                     └───────────┬───────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   ▼                           ▼
        ┌─────────────────────┐     ┌─────────────────────┐
        │  MONGODB MULTI-TIER │     │  AQUASENSE COCKPIT  │
        │ - WaterData (TTL)   │     │ - Zone Visualizer   │
        │ - SystemEvents      │     │ - Safety Cockpit    │
        │ - AuditLogs         │     │ - Trend Area SVG    │
        └─────────────────────┘     └─────────────────────┘
```

---

## 2. The 5 Core Industrial Hardening Modules

### 🛡️ Module 1: Safety Layer & Watchdog
* **Continuous Runtime Timeout**: If the pump runs continuously without reaching the Full probe (`Z2`) for longer than the configured limit (10 minutes default), the safety engine cuts off the pump and latches **`CRITICAL SAFETY LOCKOUT`**.
* **Possible Dry-Run Detection**: If the pump operates in the Empty zone (`Z0`) for $> 3$ minutes without detecting a rising level transition, the system detects a lack of inflow, shuts off the pump, and flags **`POSSIBLE DRY-RUN`**.
* **Manual Mode Interlock**: Manual activation commands are blocked if the tank is already at $100\%$ (`Z2`) or if an unresolved safety alarm is active.
* **Boot-Safe State**: On power-up or reboot, the ESP32 drives the relay strictly **`OFF`** before initializing Wi-Fi, preventing accidental motor pulsing.
* **Hardware Task Watchdog (ESP-WDT)**: Configured with an 8-second timeout (`esp_task_wdt.h`). Recovers the controller automatically if a network block or socket freeze occurs.
* **Alarm Reset Endpoint**: `POST /api/safety/reset` allowing operators to verify physical conditions and safely clear cut-off latches.

### 🔩 Module 2: Probe Hardening
* **Stainless-Steel Probes (SS316)**: Eliminates copper oxidation, galvanic corrosion, and mineral buildup.
* **Time-Based Debounce (2.5 Seconds)**: Probe transitions must hold continuously for $2500\,\text{ms}$ before being committed as a new level, filtering out water slosh and surface agitation.
* **External 10kΩ Pull-Up Resistors**: Provides noise immunity over long cable runs from roof tanks.

```text
       +3.3V (ESP32 Rail)
          │
         [10kΩ Resistor]
          │
          ├───► ESP32 GPIO Pin (GPIO 25 or 32)
          │
      [SS316 Probe Wire]
          │
        (Water)
          │
   [Common SS316 Probe]
          │
       GND (ESP32 Ground)
```

### 🔮 Module 3: Zone Architecture & Explainable Event Prediction
Replaced raw percentage noise with structured operational zones:

| Zone Code | Label | Level | Physical Condition | Controller Action |
| :---: | :---: | :---: | :--- | :--- |
| **`Z0`** | **CRITICAL EMPTY** | `0%` | Water below Probe 2 (`GPIO 25`) | Pump latches **ON** (Automatic Refill) |
| **`Z1`** | **NOMINAL MID** | `50%` | Water touching Probe 2 (`GPIO 25`) | Hysteresis: Maintain prior state |
| **`Z2`** | **FULL CUT-OFF** | `100%` | Water touching Probe 3 (`GPIO 32`) | Pump latches **OFF** (Cut-off) |

* **Event-Based Prediction**: Measures elapsed time between physical zone crossing events ($Z_2 \to Z_1 \to Z_0$), projecting arrival at the next zone with a confidence rating (`HIGH`, `MEDIUM`, `LOW`).

### 🔐 Module 4: Authentication & Response-Piggybacking
* **Device Token Ingestion**: Every ESP32 HTTP transmission requires the `x-device-token: AQUASENSE_ESP32_SECURE_TOKEN_2026` cryptographic header. Unauthenticated requests are rejected (`401 Unauthorized`).
* **HTTP Response-Piggybacking**: Remote commands (`FORCE_PUMP_OFF`, `RESET_SAFETY`, `FORCE_PUMP_ON`) are queued in the backend and returned inside the HTTP POST response when the ESP32 reports telemetry. Requires zero inbound port forwarding or firewall adjustments.

### 💾 Module 5: Database & Multi-Collection Architecture (TTL)
* **`WaterData`**: High-frequency operational readings configured with a MongoDB **TTL Index** (`expireAfterSeconds: 604800` = 7 days automatic pruning).
* **`SystemEvents`**: Permanent audit collection recording safety timeouts, dry-run detections, boot events, and alarm resets.
* **`AuditLogs`**: Tracks operator overrides and configuration updates.

---

## 3. Hardware Pin Mapping & Wiring (3-Probe Edition)

| Component | ESP32 Pin | Mode | Threshold / Active State | Notes |
| :--- | :---: | :---: | :---: | :--- |
| **Probe 1: Common Ref** | **`GND`** | Ground Reference | **0%** | Stainless probe at reservoir floor |
| **Probe 2: Low Level** | **`GPIO 25`** | `INPUT_PULLUP` (Pulsed) | **50% (Z1)** | Low water mark / Refill trigger |
| **Probe 3: Full Level** | **`GPIO 32`** | `INPUT_PULLUP` (Pulsed) | **100% (Z2)** | High water mark / Cut-off trigger |
| **Low / Refill LED** | **`GPIO 14`** | `OUTPUT` | Active `HIGH` (in Z0) | Lights when reservoir is critical low |
| **Medium / Nominal LED**| **`GPIO 27`** | `OUTPUT` | Active `HIGH` (in Z1) | Moved to GPIO 27 (off strapping pin GPIO 12) |
| **Full Capacity LED** | **`GPIO 33`** | `OUTPUT` | Active `HIGH` (in Z2) | Full 100% cut-off indicator |
| **Piezo Buzzer** | **`GPIO 23`** | `OUTPUT` | Active `HIGH` | Non-blocking acoustic warning pulses |
| **Pump Relay** | **`GPIO 19`** | `OUTPUT` | Active `LOW` | Controls 0.75 kW (1.0 HP) pump relay |

---

## 4. Fault Tolerance & Safety Matrix

| Scenario | Local ESP32 Response | Server Supervisory Response |
| :--- | :--- | :--- |
| **Wi-Fi Dropped / PC Offline** | Local 15m runtime guard & 5m dry-run cutoff still active; hysteresis runs locally | Server detects heartbeat timeout after 15s; marks ESP32 `OFFLINE` |
| **Full probe wet while Low probe dry** | Latches `FAULT_SENSOR` (Code 3); shuts pump off; writes to Flash `Preferences` | Flags `SENSOR_FAULT` in audit ledger; blocks pump restart |
| **Manual STOP clicked in dashboard** | Turns pump OFF; does NOT latch safety lock | Enforces `manualPumpTarget = false` |
| **Power loss / Sudden reboot** | Relay driven strictly OFF in `setup()`; restores safety lockout from Flash | Logs `BOOT_EVENT` with hardware `esp_reset_reason()` |
| **Operator clears safety alarm** | `resetSafety: true` command clears Flash & RAM; restores operation | Logs `ALARM_RESET` in persistent audit ledger |

---

## 5. How to Run the Project

### Step 1: Start MongoDB
Ensure MongoDB is running locally:
```powershell
Get-Service -Name "*mongo*"
```

### Step 2: Start the Backend Server
```powershell
cd backend
npm start
```
*(Server listens on `http://localhost:5000`)*

### Step 3: Start the React Dashboard
Open a new terminal:
```powershell
cd frontend
npm run dev
```
*(Open browser at `http://localhost:5173`)*

### Step 4: Run the Isolated Test Simulation
To test level transitions, zone calculations, and hysteresis without physical water or risking real hardware state:
* Click the **3-Probe Hardware Simulator & Testbench** buttons (`0% Z0`, `50% Z1`, `100% Z2`) directly at the bottom of the dashboard.
* Simulated telemetry is isolated under `source: "simulator"` via `POST /api/simulate/water-data` and never tampers with real hardware safety locks.
