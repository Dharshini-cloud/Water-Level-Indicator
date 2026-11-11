const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/smart_water_rep";
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;
const OPERATOR_KEY = process.env.OPERATOR_KEY || "aquasense_operator_key_2026";
const ENABLE_SIMULATOR = process.env.ENABLE_SIMULATOR !== "false";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

// Ensure Device Token is set
if (!DEVICE_TOKEN) {
  console.error("FATAL: DEVICE_TOKEN environment variable is not defined in .env!");
  process.exit(1);
}

// Restrict CORS to authorized frontend origin (or allow same-origin/localhost in dev)
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === CORS_ORIGIN || origin.includes("localhost") || origin.includes("127.0.0.1")) {
      callback(null, true);
    } else {
      callback(new Error("CORS blocked: Unauthorized origin"));
    }
  },
  credentials: true
}));
app.use(express.json());

// =========================================================================
// 1. Control & Safety State
// =========================================================================
let pumpControlMode = "AUTO"; // "AUTO" | "MANUAL"
let manualPumpTarget = false;

// Safety Layer State (Synchronized with ESP32 Flash Memory as source of truth)
let safetyLockout = false;
let safetyReason = null; // null | "MAX_RUNTIME_EXCEEDED" | "POSSIBLE_DRY_RUN" | "SENSOR_FAULT"
let resetSafetyPending = false;
let pumpStartTime = null;
let z0PumpStartTime = null;

// Configurable Safety Limits (Adjustable via environment)
const MAX_RUNTIME_MS = (parseInt(process.env.MAX_RUNTIME_MINUTES, 10) || 10) * 60 * 1000;
const DRY_RUN_THRESHOLD_MS = (parseInt(process.env.DRY_RUN_MINUTES, 10) || 3) * 60 * 1000;

// Zone State & Transition Tracking
let lastZone = null;
let zoneEnteredAt = Date.now();

// Helper: Convert water level or raw probes to Zone
function levelToZone(level, rawProbes) {
  if (rawProbes) {
    if (rawProbes.fullWet) return "Z2";
    if (rawProbes.lowWet) return "Z1";
    return "Z0";
  }
  if (level <= 0) return "Z0";
  if (level < 100) return "Z1";
  return "Z2";
}

// Reset reason dictionary for ESP32 esp_reset_reason()
const ESP_RESET_REASONS = {
  1: "POWERON_RESET",
  3: "SW_RESET",
  4: "OWDT_RESET",
  5: "DEEPSLEEP_RESET",
  6: "SDIO_RESET",
  7: "TG0WDT_SYS_RESET",
  8: "TG1WDT_SYS_RESET",
  9: "RTCWDT_SYS_RESET",
  10: "INTRUSION_RESET",
  11: "TGWDT_CPU_RESET",
  12: "SW_CPU_RESET",
  13: "RTCWDT_CPU_RESET",
  14: "EXT_CPU_RESET",
  15: "RTCWDT_BROWN_OUT_RESET",
  16: "RTCWDT_RTC_RESET"
};

// =========================================================================
// 2. MongoDB Database & Schemas
// =========================================================================
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected successfully at:", MONGO_URI);
    // Initialize zone tracker from latest persisted record
    try {
      const latest = await WaterData.findOne().sort({ createdAt: -1 });
      if (latest) {
        lastZone = latest.zone;
        zoneEnteredAt = new Date(latest.createdAt).getTime();
      }
    } catch {}
  })
  .catch((error) => {
    console.error("MongoDB connection warning:", error.message);
  });

// Collection 1: High-Frequency Telemetry (TTL 7 Days = 604800s)
const waterSchema = new mongoose.Schema({
  waterLevel: { type: Number, required: true, min: 0, max: 100 },
  zone: { type: String, enum: ["Z0", "Z1", "Z2"], required: true },
  rawProbes: {
    lowWet: { type: Boolean, default: false },
    fullWet: { type: Boolean, default: false }
  },
  pumpReported: { type: Boolean, required: true },
  pumpTarget: { type: Boolean, required: true },
  source: { type: String, enum: ["device", "simulator"], default: "device" },
  faultCode: { type: Number, default: 0 },
  safetyLocked: { type: Boolean, default: false },
  rssi: Number,
  freeHeap: Number,
  uptimeSeconds: Number,
  resetReason: Number,
  createdAt: { type: Date, default: Date.now, index: { expires: 604800 } }
});
const WaterData = mongoose.model("WaterData", waterSchema);

// Collection 2: Zone Transitions (For Explainable Predictor, with TTL 14 Days)
const transitionSchema = new mongoose.Schema({
  fromZone: { type: String, required: true },
  toZone: { type: String, required: true },
  durationMinutes: { type: Number, required: true },
  source: { type: String, default: "device" },
  createdAt: { type: Date, default: Date.now, index: { expires: 1209600 } }
});
const ZoneTransition = mongoose.model("ZoneTransition", transitionSchema);

// Collection 3: Persistent System & Safety Events (Audit Retention)
const eventSchema = new mongoose.Schema({
  eventType: { 
    type: String, 
    required: true,
    enum: ["SAFETY_TIMEOUT", "POSSIBLE_DRY_RUN", "MANUAL_OVERRIDE", "ALARM_RESET", "BOOT_EVENT", "INTERLOCK_ENGAGED", "SENSOR_FAULT"]
  },
  severity: { type: String, enum: ["INFO", "WARNING", "CRITICAL"], default: "INFO" },
  details: { type: String, required: true },
  source: { type: String, default: "device" },
  createdAt: { type: Date, default: Date.now, index: true }
});
const SystemEvent = mongoose.model("SystemEvent", eventSchema);

async function logSystemEvent(eventType, severity, details, source = "device") {
  try {
    const evt = new SystemEvent({ eventType, severity, details, source });
    await evt.save();
    console.log(`[SAFETY EVENT] [${severity}] ${eventType} (${source}): ${details}`);
  } catch (err) {
    console.error("Failed to log system event:", err.message);
  }
}

// =========================================================================
// 3. Constant-Time Cryptographic Authentication Middleware
// =========================================================================
function verifyDeviceAuth(req, res, next) {
  const token = req.headers["x-device-token"];

  // Strictly reject missing tokens; no query string fallback (prevents access-log leakage)
  if (!token || typeof token !== "string") {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Missing x-device-token header"
    });
  }

  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(DEVICE_TOKEN);

  // Constant-time comparison against timing attacks
  if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Invalid x-device-token"
    });
  }

  next();
}

function verifyOperatorAuth(req, res, next) {
  const opKey = req.headers["x-operator-key"] || req.headers["authorization"];
  // If authorization header sent with Bearer
  const keyToTest = opKey && opKey.startsWith("Bearer ") ? opKey.slice(7) : opKey;

  // If running in development without strict operator header, accept from localhost
  if (!keyToTest) {
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
      return next();
    }
    return res.status(403).json({ success: false, message: "Forbidden: Operator authentication required." });
  }

  const keyBuf = Buffer.from(keyToTest);
  const secretBuf = Buffer.from(OPERATOR_KEY);
  if (keyBuf.length !== secretBuf.length || !crypto.timingSafeEqual(keyBuf, secretBuf)) {
    return res.status(403).json({ success: false, message: "Forbidden: Invalid operator key." });
  }

  next();
}

// =========================================================================
// 4. Ingestion Endpoint (Strictly Authenticated Hardware Gateway)
// =========================================================================
app.post("/api/water-data", verifyDeviceAuth, async (req, res) => {
  let { 
    waterLevel, 
    pump, 
    rawProbes, 
    safetyLocked, 
    faultCode, 
    rssi, 
    freeHeap, 
    uptime, 
    resetReason,
    isBoot 
  } = req.body;

  // Validate raw data or probe booleans
  if (rawProbes && typeof rawProbes.lowWet === "boolean" && typeof rawProbes.fullWet === "boolean") {
    // Validate impossible physical state: full probe submerged while low probe is dry!
    if (rawProbes.fullWet && !rawProbes.lowWet) {
      faultCode = 3; // SENSOR_FAULT
      safetyLocked = true;
      safetyReason = "SENSOR_FAULT";
      logSystemEvent("SENSOR_FAULT", "CRITICAL", "Physically impossible state detected: Full probe wet while Low probe dry! Broken wire or probe fault.", "device");
    }
    waterLevel = rawProbes.fullWet ? 100 : rawProbes.lowWet ? 50 : 0;
  }

  if (typeof waterLevel !== "number" || isNaN(waterLevel)) {
    return res.status(400).json({ success: false, message: "Invalid payload: waterLevel must be a number" });
  }

  const pumpReported = Boolean(pump);
  const currentZone = levelToZone(waterLevel, rawProbes);
  const now = Date.now();

  // 1. Hardware is source of truth for safety lock state
  if (safetyLocked) {
    safetyLockout = true;
    if (faultCode === 1) safetyReason = "MAX_RUNTIME_EXCEEDED";
    else if (faultCode === 2) safetyReason = "POSSIBLE_DRY_RUN";
    else if (faultCode === 3) safetyReason = "SENSOR_FAULT";
  } else if (!resetSafetyPending) {
    // If hardware confirms it is unlocked and no reset command is in-flight, mirror unlocked state
    safetyLockout = false;
    safetyReason = null;
  }

  // Acknowledge reset command if hardware unlocked
  if (!safetyLocked && resetSafetyPending) {
    resetSafetyPending = false;
  }

  // 2. Supervisory Safety Checks on Server
  if (pumpReported) {
    if (!pumpStartTime) pumpStartTime = now;
    const runtimeElapsed = now - pumpStartTime;
    if (runtimeElapsed > MAX_RUNTIME_MS && !safetyLockout) {
      safetyLockout = true;
      safetyReason = "MAX_RUNTIME_EXCEEDED";
      logSystemEvent("SAFETY_TIMEOUT", "CRITICAL", `Server safety timeout: Pump runtime exceeded ${Math.round(MAX_RUNTIME_MS / 60000)} min limit.`, "device");
    }
  } else {
    pumpStartTime = null;
  }

  if (pumpReported && currentZone === "Z0") {
    if (!z0PumpStartTime) z0PumpStartTime = now;
    const dryRunElapsed = now - z0PumpStartTime;
    if (dryRunElapsed > DRY_RUN_THRESHOLD_MS && !safetyLockout) {
      safetyLockout = true;
      safetyReason = "POSSIBLE_DRY_RUN";
      logSystemEvent("POSSIBLE_DRY_RUN", "WARNING", `Server dry-run warning: Pump running in Z0 for ${Math.round(DRY_RUN_THRESHOLD_MS / 60000)} min with no level response.`, "device");
    }
  } else {
    z0PumpStartTime = null;
  }

  if (isBoot) {
    logSystemEvent("BOOT_EVENT", "INFO", `ESP32 Booted. Reset reason: ${ESP_RESET_REASONS[resetReason] || resetReason || "NORMAL"}. Detected level: ${waterLevel}% (${currentZone}).`, "device");
  }

  // 3. Determine Desired Actuator State
  let targetPump = false;
  if (!safetyLockout) {
    if (pumpControlMode === "MANUAL") {
      // Manual interlock: prevent pump start if already full
      if (manualPumpTarget && currentZone === "Z2") {
        targetPump = false;
        manualPumpTarget = false;
        logSystemEvent("INTERLOCK_ENGAGED", "INFO", "Manual override blocked: Tank is full (Z2).", "device");
      } else {
        targetPump = manualPumpTarget;
      }
    } else {
      // AUTO hysteresis: ON in Z0, hold in Z1, OFF in Z2
      if (currentZone === "Z0") targetPump = true;
      else if (currentZone === "Z2") targetPump = false;
      else targetPump = pumpReported; // Hold current state in Z1
    }
  }

  // 4. Compute Response First (guarantees ESP32 receives command even if DB is busy/slow)
  const commandResponse = {
    success: true,
    mode: pumpControlMode,
    targetPump: targetPump,
    expiresAt: now + 15000, // Desired state lease valid for 15s
    safetyLock: safetyLockout,
    safetyReason: safetyReason,
    resetSafety: resetSafetyPending
  };

  res.status(201).json(commandResponse);

  // 5. Best-Effort Persistence & Transition Tracking (Asynchronous, does not block command)
  (async () => {
    try {
      const record = new WaterData({
        waterLevel,
        zone: currentZone,
        rawProbes: rawProbes || { lowWet: waterLevel >= 50, fullWet: waterLevel >= 100 },
        pumpReported,
        pumpTarget: targetPump,
        source: "device",
        faultCode: faultCode || 0,
        safetyLocked: safetyLockout,
        rssi,
        freeHeap,
        uptimeSeconds: uptime,
        resetReason
      });
      await record.save();

      // Track Zone Transitions with accurate duration
      if (lastZone && lastZone !== currentZone) {
        const durationMin = Math.max(0.1, Number(((now - zoneEnteredAt) / 60000).toFixed(1)));
        const transition = new ZoneTransition({
          fromZone: lastZone,
          toZone: currentZone,
          durationMinutes: durationMin,
          source: "device"
        });
        await transition.save();
        zoneEnteredAt = now;
      }
      lastZone = currentZone;
    } catch (err) {
      console.error("Async telemetry persistence warning:", err.message);
    }
  })();
});

// =========================================================================
// 5. Separate Simulator Route (Isolated from Real Device Telemetry & Safety)
// =========================================================================
app.post("/api/simulate/water-data", async (req, res) => {
  if (!ENABLE_SIMULATOR) {
    return res.status(403).json({ success: false, message: "Simulator is disabled on this server." });
  }

  try {
    let { waterLevel, pump } = req.body;
    if (typeof waterLevel !== "number") {
      return res.status(400).json({ success: false, message: "waterLevel must be a number" });
    }

    const currentZone = levelToZone(waterLevel);
    const now = Date.now();
    const pumpReported = Boolean(pump);

    // Track transitions for simulation
    if (lastZone && lastZone !== currentZone) {
      const durationMin = Math.max(0.1, Number(((now - zoneEnteredAt) / 60000).toFixed(1)));
      const transition = new ZoneTransition({
        fromZone: lastZone,
        toZone: currentZone,
        durationMinutes: durationMin,
        source: "simulator"
      });
      await transition.save();
      zoneEnteredAt = now;
    }
    lastZone = currentZone;

    const record = new WaterData({
      waterLevel,
      zone: currentZone,
      rawProbes: { lowWet: waterLevel >= 50, fullWet: waterLevel >= 100 },
      pumpReported,
      pumpTarget: pumpReported,
      source: "simulator",
      safetyLocked: false,
      faultCode: 0
    });
    await record.save();

    res.status(201).json({
      success: true,
      simulated: true,
      waterLevel,
      zone: currentZone,
      pump: pumpReported
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Backward compatibility redirect for dashboard simulator
app.post("/api/water-data-simulate", (req, res) => {
  req.url = "/api/simulate/water-data";
  app.handle(req, res);
});

// =========================================================================
// 6. Explainable Predictive Analytics Engine (State & Historical Transitions)
// =========================================================================
app.get("/api/prediction", async (req, res) => {
  try {
    const latest = await WaterData.findOne().sort({ createdAt: -1 });
    if (!latest) {
      return res.json({
        currentZone: "Z1",
        nextZone: "Z0",
        timeToNext: "—",
        trend: "STABLE",
        confidence: "LOW",
        rate: "STABLE",
        prediction: "NORMAL"
      });
    }

    const currentZone = latest.zone;
    const isPumping = latest.pumpReported;
    const now = Date.now();
    const timeInCurrentZoneMin = Math.max(0, (now - zoneEnteredAt) / 60000);

    let trend = "STABLE";
    let nextZone = currentZone;
    let predictionStatus = "NORMAL";
    let estimatedMinutes = null;
    let confidence = "MEDIUM";

    if (isPumping) {
      trend = "↑ REFILLING";
      nextZone = currentZone === "Z0" ? "Z1" : "Z2";
      predictionStatus = "REFILLING";

      // Query historical filling transitions for this specific jump
      const history = await ZoneTransition.find({ fromZone: currentZone, toZone: nextZone }).limit(10);
      if (history.length > 0) {
        const durations = history.map(h => h.durationMinutes).sort((a, b) => a - b);
        const median = durations[Math.floor(durations.length / 2)];
        estimatedMinutes = Math.max(1, Math.round(median - timeInCurrentZoneMin));
        confidence = "HIGH";
      } else {
        // Fallback realistic pump fill estimate (~10 min per zone)
        estimatedMinutes = Math.max(1, Math.round(10 - timeInCurrentZoneMin));
        confidence = "MEDIUM";
      }
    } else if (currentZone === "Z2" || currentZone === "Z1") {
      trend = "↓ DEPLETING";
      nextZone = currentZone === "Z2" ? "Z1" : "Z0";
      predictionStatus = currentZone === "Z1" ? "LOW LEVEL" : "NORMAL";

      // Query historical draining transitions
      const history = await ZoneTransition.find({ fromZone: currentZone, toZone: nextZone }).limit(10);
      if (history.length > 0) {
        const durations = history.map(h => h.durationMinutes).sort((a, b) => a - b);
        const median = durations[Math.floor(durations.length / 2)];
        estimatedMinutes = Math.max(1, Math.round(median - timeInCurrentZoneMin));
        confidence = "HIGH";
      } else {
        // Fallback realistic drain estimate (~45 min nominal consumption)
        estimatedMinutes = Math.max(2, Math.round(45 - timeInCurrentZoneMin));
        confidence = "MEDIUM";
      }
    } else {
      // Tank is in Z0 and pump is OFF -> Critical empty
      trend = "STABLE";
      nextZone = "Z0";
      predictionStatus = "CRITICAL (BELOW LOW PROBE)";
      estimatedMinutes = null;
      confidence = "HIGH";
    }

    let timeToNextStr = "—";
    if (estimatedMinutes !== null) {
      if (estimatedMinutes > 60) {
        const h = Math.floor(estimatedMinutes / 60);
        const m = estimatedMinutes % 60;
        timeToNextStr = `${h}h ${m}m`;
      } else {
        timeToNextStr = `${estimatedMinutes}m`;
      }
    } else if (currentZone === "Z0") {
      timeToNextStr = "REFILL REQUIRED";
    }

    res.json({
      currentZone,
      nextZone,
      timeToNext: timeToNextStr,
      trend,
      confidence,
      rate: isPumping ? "REFILLING" : currentZone === "Z0" ? "EMPTY" : "DEPLETING",
      prediction: predictionStatus
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// =========================================================================
// 7. Safety Management & Alarm Reset Endpoints (Operator Authenticated)
// =========================================================================
app.get("/api/safety/status", (req, res) => {
  const now = Date.now();
  const currentRuntimeSeconds = pumpStartTime ? Math.round((now - pumpStartTime) / 1000) : 0;
  const currentDryRunSeconds = z0PumpStartTime ? Math.round((now - z0PumpStartTime) / 1000) : 0;

  res.json({
    safetyLockout,
    safetyReason,
    resetSafetyPending,
    currentRuntimeSeconds,
    maxRuntimeSeconds: Math.round(MAX_RUNTIME_MS / 1000),
    currentDryRunSeconds,
    dryRunThresholdSeconds: Math.round(DRY_RUN_THRESHOLD_MS / 1000),
    isPumpActive: pumpStartTime !== null
  });
});

app.post("/api/safety/reset", verifyOperatorAuth, async (req, res) => {
  const previousReason = safetyReason;
  safetyLockout = false;
  safetyReason = null;
  pumpStartTime = null;
  z0PumpStartTime = null;
  resetSafetyPending = true; // Signal hardware in next HTTP response to clear Preferences flash

  await logSystemEvent("ALARM_RESET", "INFO", `Operator cleared safety alarm. Hardware flash clear queued. Previous fault: ${previousReason || "NONE"}`);

  res.json({
    success: true,
    message: "Safety lockout cleared on server; flash clear command dispatched to hardware.",
    safetyLockout: false,
    resetSafetyPending: true
  });
});

// =========================================================================
// 8. Pump Mode & Remote Controls (Operator Authenticated)
// =========================================================================
app.post("/api/pump/mode", verifyOperatorAuth, async (req, res) => {
  const { mode, state } = req.body;

  if (safetyLockout) {
    return res.status(403).json({
      success: false,
      message: "Safety Lockout is active. You must inspect tank and reset alarm first."
    });
  }

  // Interlock check before changing mode or state
  if (state === true) {
    const latest = await WaterData.findOne().sort({ createdAt: -1 });
    if (latest && latest.zone === "Z2") {
      return res.status(400).json({
        success: false,
        message: "Interlock Guard: Cannot activate pump when reservoir is 100% full (Z2)."
      });
    }
  }

  if (mode === "AUTO" || mode === "MANUAL") {
    pumpControlMode = mode;
  }

  if (typeof state === "boolean") {
    manualPumpTarget = state;
    await logSystemEvent("MANUAL_OVERRIDE", "INFO", `Manual pump override set to: ${state ? "ON" : "OFF"}`);
  }

  res.json({
    success: true,
    mode: pumpControlMode,
    state: manualPumpTarget,
    targetPumpState: manualPumpTarget
  });
});

// Accurate Pump Runtime & Cycles (Capping gaps at 15s to exclude offline periods)
app.get("/api/pump/performance", async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayRecords = await WaterData.find({ createdAt: { $gte: startOfDay } }).sort({ createdAt: 1 });
    let totalRuntimeSeconds = 0;
    let cycleCount = 0;
    let lastActivated = null;

    for (let i = 0; i < todayRecords.length; i++) {
      const rec = todayRecords[i];
      if (i > 0) {
        const prev = todayRecords[i - 1];
        // If pump was running between prev and rec, calculate delta
        if (rec.pumpReported && prev.pumpReported) {
          const deltaSec = (new Date(rec.createdAt) - new Date(prev.createdAt)) / 1000;
          // Cap at 15 seconds to prevent network downtime from inflating runtime
          totalRuntimeSeconds += Math.min(15, Math.max(0, deltaSec));
        }

        // Count actual OFF -> ON edges
        if (rec.pumpReported && !prev.pumpReported) {
          cycleCount++;
          lastActivated = rec.createdAt;
        }
      } else if (rec.pumpReported) {
        cycleCount++;
        lastActivated = rec.createdAt;
      }
    }

    const totalRuntimeMinutes = Math.round(totalRuntimeSeconds / 60);
    const latest = await WaterData.findOne().sort({ createdAt: -1 });

    res.json({
      mode: pumpControlMode,
      todayRuntime: `${totalRuntimeMinutes} min`,
      lastActivated: lastActivated ? new Date(lastActivated).toLocaleTimeString() : "None today",
      cycleCount,
      isPumpActive: latest ? latest.pumpReported : false,
      safetyLockout
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch pump performance" });
  }
});

// =========================================================================
// 9. System Health & Diagnostic Endpoints (Real Hardware Diagnostics)
// =========================================================================
app.get("/api/health", async (req, res) => {
  try {
    const latest = await WaterData.findOne().sort({ createdAt: -1 });
    const latestDevice = await WaterData.findOne({ source: "device" }).sort({ createdAt: -1 });
    const now = Date.now();

    const isDeviceOnline = latestDevice ? (now - new Date(latestDevice.createdAt).getTime() < 15000) : false;
    const secondsSinceSync = latest ? Math.max(0, Math.round((now - new Date(latest.createdAt).getTime()) / 1000)) : null;

    let probeHealth = "NORMAL";
    if (latestDevice && latestDevice.rawProbes) {
      if (latestDevice.rawProbes.fullWet && !latestDevice.rawProbes.lowWet) {
        probeHealth = "FAULT_IMPOSSIBLE_STATE";
      }
    }

    res.json({
      esp32: isDeviceOnline ? "ONLINE" : "OFFLINE",
      watchdog: isDeviceOnline ? "ACTIVE" : "STANDBY",
      sensors: probeHealth,
      wifi: isDeviceOnline ? "CONNECTED" : "OFFLINE",
      backend: "CONNECTED",
      mongodb: mongoose.connection.readyState === 1 ? "CONNECTED" : "DISCONNECTED",
      security: "AUTHENTICATED",
      safetyLockout,
      rssi: isDeviceOnline && latestDevice.rssi ? `${latestDevice.rssi} dBm` : "—",
      freeHeap: isDeviceOnline && latestDevice.freeHeap ? `${Math.round(latestDevice.freeHeap / 1024)} KB` : "—",
      uptime: isDeviceOnline && latestDevice.uptimeSeconds ? `${Math.round(latestDevice.uptimeSeconds / 60)}m` : "—",
      resetReason: latestDevice && latestDevice.resetReason ? (ESP_RESET_REASONS[latestDevice.resetReason] || `CODE_${latestDevice.resetReason}`) : "NORMAL",
      lastSyncSeconds: secondsSinceSync,
      serverUptime: Math.round(process.uptime())
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/water-data/latest", async (req, res) => {
  try {
    const latest = await WaterData.findOne().sort({ createdAt: -1 });
    if (!latest) {
      return res.json({
        waterLevel: 0,
        zone: "Z0",
        pump: false,
        pumpReported: false,
        rawProbes: { lowWet: false, fullWet: false },
        createdAt: new Date(),
        isEmpty: true
      });
    }
    res.json({
      ...latest.toObject(),
      pump: latest.pumpReported // Ensure backward compatibility with UI
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/water-data/history", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const data = await WaterData.find().sort({ createdAt: -1 }).limit(limit);
    const mapped = data.map(d => ({
      ...d.toObject(),
      pump: d.pumpReported
    }));
    res.json(mapped.reverse());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const events = await SystemEvent.find().sort({ createdAt: -1 }).limit(15);
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

// =========================================================================
// 10. Start Server
// =========================================================================
app.listen(PORT, () => {
  console.log(`AquaSense Pro Hardened Backend running on port ${PORT}`);
  console.log(`Device Ingestion: POST /api/water-data (Requires x-device-token header)`);
  console.log(`Simulator Endpoint: POST /api/simulate/water-data (Enabled: ${ENABLE_SIMULATOR})`);
  console.log(`Safety Limits: Max Runtime = ${Math.round(MAX_RUNTIME_MS / 60000)}m | Dry-Run Threshold = ${Math.round(DRY_RUN_THRESHOLD_MS / 60000)}m`);
});
