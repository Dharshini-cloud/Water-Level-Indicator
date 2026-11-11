import { useEffect, useState, useCallback, useMemo } from "react";
import "./App.css";

const API = "http://localhost:5000";

export default function App() {
  const [data, setData] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [history, setHistory] = useState([]);
  const [health, setHealth] = useState(null);
  const [pumpPerf, setPumpPerf] = useState(null);
  const [safetyStatus, setSafetyStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [controlMode, setControlMode] = useState("AUTO");
  const [manualPump, setManualPump] = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState(Date.now());
  const [secondsAgo, setSecondsAgo] = useState(0);

  // 1. Data Fetching Functions
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/water-data/latest`);
      if (res.ok) {
        const result = await res.json();
        setData(result);
        setBackendOnline(true);
      } else {
        setBackendOnline(false);
      }
    } catch {
      setBackendOnline(false);
    }
  }, []);

  const fetchPrediction = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/prediction`);
      if (res.ok) {
        const result = await res.json();
        setPrediction(result);
      }
    } catch {}
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/water-data/history?limit=30`);
      if (res.ok) {
        const result = await res.json();
        setHistory(result);
      }
    } catch {}
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) {
        const result = await res.json();
        setHealth(result);
      }
    } catch {}
  }, []);

  const fetchPumpPerf = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/pump/performance`);
      if (res.ok) {
        const result = await res.json();
        setPumpPerf(result);
        if (result.mode) setControlMode(result.mode);
      }
    } catch {}
  }, []);

  const fetchSafetyStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/safety/status`);
      if (res.ok) {
        const result = await res.json();
        setSafetyStatus(result);
      }
    } catch {}
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/events`);
      if (res.ok) {
        const result = await res.json();
        setEvents(result);
      }
    } catch {}
  }, []);

  const syncAll = useCallback(async () => {
    await Promise.all([
      fetchData(),
      fetchPrediction(),
      fetchHistory(),
      fetchHealth(),
      fetchPumpPerf(),
      fetchSafetyStatus(),
      fetchEvents()
    ]);
    setLastSyncTime(Date.now());
    setSecondsAgo(0);
  }, [fetchData, fetchPrediction, fetchHistory, fetchHealth, fetchPumpPerf, fetchSafetyStatus, fetchEvents]);

  // Periodic polling every 3s
  useEffect(() => {
    syncAll();
    const interval = setInterval(syncAll, 3000);
    return () => clearInterval(interval);
  }, [syncAll]);

  // Sync timer tick
  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastSyncTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [lastSyncTime]);

const OPERATOR_KEY = "aquasense_operator_key_2026";

  // 2. Control Mode & Manual Overrides
  const toggleControlMode = async (mode) => {
    setControlMode(mode);
    try {
      await fetch(`${API}/api/pump/mode`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-operator-key": OPERATOR_KEY 
        },
        body: JSON.stringify({ mode, state: manualPump })
      });
      syncAll();
    } catch (e) {
      console.error(e);
    }
  };

  const toggleManualPump = async () => {
    const nextState = !manualPump;
    setManualPump(nextState);
    try {
      const res = await fetch(`${API}/api/pump/mode`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-operator-key": OPERATOR_KEY 
        },
        body: JSON.stringify({ mode: "MANUAL", state: nextState })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.message || "Pump command blocked by safety interlock.");
      }
      syncAll();
    } catch (e) {
      console.error(e);
    }
  };

  // Reset Safety Lockout Alarm
  const handleResetAlarm = async () => {
    try {
      const res = await fetch(`${API}/api/safety/reset`, { 
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-operator-key": OPERATOR_KEY 
        }
      });
      if (res.ok) {
        await syncAll();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // 3. Isolated Test Simulation Injector
  const injectLevel = async (lvl) => {
    setSimulating(true);
    const pumpShouldRun = controlMode === "MANUAL" 
      ? manualPump 
      : (lvl <= 0 ? true : lvl >= 100 ? false : isPumpActive);
    try {
      await fetch(`${API}/api/simulate/water-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waterLevel: lvl, pump: pumpShouldRun })
      });
      await syncAll();
    } catch (e) {
      console.error(e);
    } finally {
      setSimulating(false);
    }
  };

  const currentLevel = data?.waterLevel ?? 0;
  const isPumpActive = data?.pump ?? data?.pumpReported ?? false;
  const isFullWet = data?.rawProbes?.fullWet ?? (currentLevel >= 100);
  const isLowWet = data?.rawProbes?.lowWet ?? (currentLevel >= 50);
  const currentZone = prediction?.currentZone || (currentLevel >= 100 ? "Z2" : currentLevel <= 0 ? "Z0" : "Z1");
  const isSafetyLocked = safetyStatus?.safetyLockout || pumpPerf?.safetyLockout || false;

  const getZoneBadge = (zone, val) => {
    if (zone === "Z0" || val <= 0) return { label: "ZONE Z0 • CRITICAL (EMPTY)", color: "badge-danger" };
    if (zone === "Z2" || val >= 100) return { label: "ZONE Z2 • FULL (CUT-OFF)", color: "badge-success" };
    return { label: "ZONE Z1 • NOMINAL LEVEL", color: "badge-info" };
  };

  const zoneBadge = getZoneBadge(currentZone, currentLevel);

  // 4. SVG Large Trend Graph Coordinates
  const graphData = useMemo(() => {
    if (!history || history.length === 0) return { path: "", area: "", points: [] };
    const width = 1200;
    const height = 180;
    const paddingLeft = 105; // Generous space so "100% (FULL)" is never cut off
    const paddingRight = 30;
    const paddingTop = 20;
    const paddingBottom = 25;

    const plotWidth = width - paddingLeft - paddingRight;
    const plotHeight = height - paddingTop - paddingBottom;

    const points = history.map((item, idx) => {
      const x = history.length > 1 
        ? paddingLeft + (idx / (history.length - 1)) * plotWidth 
        : paddingLeft + plotWidth / 2;
      const y = paddingTop + plotHeight * (1 - Math.min(100, Math.max(0, item.waterLevel)) / 100);
      return {
        x,
        y,
        level: item.waterLevel,
        zone: item.zone || (item.waterLevel >= 100 ? "Z2" : item.waterLevel <= 0 ? "Z0" : "Z1"),
        pump: item.pump,
        time: item.createdAt
      };
    });

    const path = `M ${points.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")}`;
    const area = `${path} L ${points[points.length - 1].x.toFixed(1)} ${paddingTop + plotHeight} L ${points[0].x.toFixed(1)} ${paddingTop + plotHeight} Z`;

    return { path, area, points, plotHeight, paddingTop, paddingLeft, width, height };
  }, [history]);

  return (
    <div className="cockpit-container">
      {/* ── TOP HEADER (CLEAN & READABLE) ── */}
      <header className="master-header">
        <div className="brand-badge">
          <div className="brand-logo-gem">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
            </svg>
          </div>
          <div>
            <h1 className="brand-main-title">AQUASENSE</h1>
          </div>
        </div>

        <div className="master-header-meta">
          <div className={`meta-pill ${backendOnline ? "online" : "offline"}`}>
            <span className="pulsing-led"></span>
            {backendOnline ? "ONLINE" : "OFFLINE"}
          </div>
          <button className="icon-sync-btn" onClick={syncAll} title="Force Telemetry Sync">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19" />
            </svg>
            REFRESH
          </button>
        </div>
      </header>

      {/* ── CRITICAL SAFETY LOCKOUT BANNER (WHEN TRIGGERED) ── */}
      {isSafetyLocked && (
        <div className="safety-alert-banner">
          <div className="safety-banner-left">
            <span className="banner-alert-icon">⚠️</span>
            <div>
              <strong>SAFETY INTERLOCK ENGAGED: PUMP SHUTDOWN ACTIVE</strong>
              <p>
                {safetyStatus?.safetyReason === "MAX_RUNTIME_EXCEEDED"
                  ? "Automatic shutoff: Pump exceeded continuous runtime limit to protect motor."
                  : "Automatic shutoff: Possible dry-run or no level response detected in empty zone."}
              </p>
            </div>
          </div>
          <button className="btn-reset-alarm-prominent" onClick={handleResetAlarm}>
            ✓ RESET SAFETY ALARM
          </button>
        </div>
      )}

      {/* ── ROW 1: TWO MASTER CONTROL CARDS (55% / 45% BALANCED SPLIT) ── */}
      <section className="master-two-col-grid">
        {/* Card 1: Reservoir Tank & Live Water Telemetry Cockpit */}
        <div className="deck-card reservoir-master-card">
          <div className="deck-card-header">
            <span className="card-tag">WATER RESERVOIR MONITOR</span>
            <span className={`pill-badge ${zoneBadge.color}`}>{zoneBadge.label}</span>
          </div>

          <div className="reservoir-content-layout">
            {/* Left: The 3D Glass Cylinder */}
            <div className="cylinder-stage-wrap">
              <div className="glass-cylinder">
                <div className="sheen-reflection"></div>

                <div className="probe-scale">
                  {[
                    { pct: 100, label: "Z2: 100% (FULL)" },
                    { pct: 50, label: "Z1: 50% (MID)" },
                    { pct: 0, label: "Z0: 0% (GND)" }
                  ].map((probe) => (
                    <div
                      key={probe.pct}
                      className={`probe-tick ${currentLevel >= probe.pct ? "submerged" : ""}`}
                      style={{ bottom: `${probe.pct}%` }}
                    >
                      <span className="tick-notch"></span>
                      <span className="tick-dot"></span>
                      <span className="tick-label">{probe.label}</span>
                    </div>
                  ))}
                </div>

                <div className="liquid-fluid" style={{ height: `${Math.max(4, currentLevel)}%` }}>
                  <div className="liquid-wave wave-1"></div>
                  <div className="liquid-wave wave-2"></div>
                </div>

                <div className="center-hud-badge">
                  <span className="hud-val">{currentLevel}</span>
                  <span className="hud-unit">%</span>
                </div>
              </div>
            </div>

            {/* Right: Telemetry Readout & Probe Diagnostics */}
            <div className="reservoir-telemetry-side">
              {/* Level Hero Stat */}
              <div className="level-hero-block">
                <div className="level-hero-num-wrap">
                  <span className="hero-stat-label">CURRENT WATER LEVEL</span>
                  <div className="hero-stat-num">
                    {currentLevel}<small>%</small>
                  </div>
                </div>
                <div className="level-hero-meta">
                  <span className="hero-stat-label">OPERATIONAL STATE</span>
                  <strong className="hero-state-val">
                    {currentLevel >= 100 ? "FULL CAPACITY (100%)" : currentLevel <= 0 ? "CRITICAL EMPTY (REFILL)" : "NOMINAL RANGE"}
                  </strong>
                </div>
              </div>

              {/* Calibrated 3-Zone Horizontal Progress Track */}
              <div className="track-section">
                <div className="horizontal-bar-track">
                  <div className="horizontal-bar-fill" style={{ width: `${currentLevel}%` }}></div>
                </div>
                <div className="horizontal-bar-ticks">
                  <span className={currentLevel <= 0 ? "active" : ""}>Z0: 0% (CRITICAL)</span>
                  <span className={currentLevel >= 50 && currentLevel < 100 ? "active" : ""}>Z1: 50% (NOMINAL)</span>
                  <span className={currentLevel >= 100 ? "active" : ""}>Z2: 100% (FULL)</span>
                </div>
              </div>

              {/* 3 Probe Hardware Conduction Status Cards */}
              <div className="probes-status-grid">
                <div className="probe-diag-card">
                  <div className="pdc-top">
                    <span className={`p-dot ${isFullWet ? "active" : ""}`}></span>
                    <strong>PROBE 3 (FULL)</strong>
                  </div>
                  <span className="pdc-pin">GPIO 32 • Top Cut-off</span>
                  <span className={`pdc-badge ${isFullWet ? "submerged" : "open"}`}>
                    {isFullWet ? "SUBMERGED" : "DRY / OPEN"}
                  </span>
                </div>

                <div className="probe-diag-card">
                  <div className="pdc-top">
                    <span className={`p-dot ${isLowWet ? "active" : ""}`}></span>
                    <strong>PROBE 2 (LOW)</strong>
                  </div>
                  <span className="pdc-pin">GPIO 25 • Refill Point</span>
                  <span className={`pdc-badge ${isLowWet ? "submerged" : "open"}`}>
                    {isLowWet ? "SUBMERGED" : "DRY / OPEN"}
                  </span>
                </div>

                <div className="probe-diag-card">
                  <div className="pdc-top">
                    <span className="p-dot active"></span>
                    <strong>PROBE 1 (GND)</strong>
                  </div>
                  <span className="pdc-pin">ESP32 GND • Baseline</span>
                  <span className="pdc-badge grounded">GROUNDED</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: Pump Actuation, Controls & Safety Interlock */}
        <div className={`deck-card pump-master-card ${isPumpActive ? "active" : ""} ${isSafetyLocked ? "locked" : ""}`}>
          <div className="deck-card-header">
            <span className="card-tag">PUMP ACTUATION & CONTROLS</span>
            <span className={`pill-badge ${isSafetyLocked ? "badge-danger" : isPumpActive ? "badge-success" : "badge-neutral"}`}>
              {isSafetyLocked ? "SAFETY LOCKED" : isPumpActive ? "PUMP ACTIVE (RUNNING)" : "PUMP STANDBY (OFF)"}
            </span>
          </div>

          <div className="pump-content-layout">
            {/* Actuator Status Header */}
            <div className="pump-hero-card">
              <div className={`pump-impeller-icon ${isPumpActive ? "spin" : ""}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <div className="pump-hero-titles">
                <strong>{isSafetyLocked ? "SAFETY CUT-OFF LATCHED" : isPumpActive ? "WATER PUMP ACTIVE" : "WATER PUMP STANDBY"}</strong>
                <span>{controlMode === "AUTO" ? "AUTOMATIC HYSTERESIS CONTROL (0% START → 100% STOP)" : "MANUAL OPERATOR OVERRIDE ACTIVE"}</span>
              </div>
            </div>

            {/* 4-Item Performance Metrics Grid */}
            <div className="pump-quad-metrics">
              <div className="pq-tile">
                <span className="pq-label">TODAY'S RUNTIME</span>
                <strong className="pq-value">{pumpPerf?.todayRuntime || "0 min"}</strong>
                <small className="pq-sub">Accumulated motor runtime</small>
              </div>
              <div className="pq-tile">
                <span className="pq-label">ACTIVATION CYCLES</span>
                <strong className="pq-value">{pumpPerf?.cycleCount || 0} cycles</strong>
                <small className="pq-sub">Starts recorded today</small>
              </div>
              <div className="pq-tile">
                <span className="pq-label">LAST ACTIVATED</span>
                <strong className="pq-value">{pumpPerf?.lastActivated || "None today"}</strong>
                <small className="pq-sub">Timestamp of last cycle</small>
              </div>
              <div className="pq-tile">
                <span className="pq-label">MOTOR SPECIFICATION</span>
                <strong className="pq-value">0.75 kW (1.0 HP)</strong>
                <small className="pq-sub">Active-LOW 5V Relay</small>
              </div>
            </div>

            {/* Mode Controls Bar */}
            <div className="pump-controls-bar">
              <div className="mode-toggle-group">
                <span className="mode-title-tag">OPERATING MODE</span>
                <div className="segmented-control">
                  <button
                    className={`seg-btn ${controlMode === "AUTO" ? "active" : ""}`}
                    onClick={() => toggleControlMode("AUTO")}
                    disabled={isSafetyLocked}
                  >
                    AUTO PILOT
                  </button>
                  <button
                    className={`seg-btn ${controlMode === "MANUAL" ? "active" : ""}`}
                    onClick={() => toggleControlMode("MANUAL")}
                    disabled={isSafetyLocked}
                  >
                    MANUAL MODE
                  </button>
                </div>
              </div>

              {controlMode === "MANUAL" && (
                <button
                  className={`btn-override-action ${manualPump ? "btn-stop" : "btn-start"}`}
                  onClick={toggleManualPump}
                  disabled={isSafetyLocked}
                >
                  {manualPump ? "■ STOP PUMP (MANUAL)" : "▶ START PUMP (MANUAL)"}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── ROW 2: PREDICTIVE ANALYTICS & SYSTEM SAFETY (50% / 50% BALANCED) ── */}
      <section className="master-two-col-grid">
        {/* Card 1: Explainable Zone-Crossing Predictive Engine */}
        <div className="deck-card predictive-master-card">
          <div className="deck-card-header">
            <span className="card-tag">EXPLAINABLE ZONE-CROSSING ANALYTICS</span>
            <span className="pill-badge badge-primary">PREDICTIVE AI</span>
          </div>

          <div className="predictive-content-layout">
            {/* Visual Step Progress Across Zones */}
            <div className="zone-stepper-bar">
              <div className={`step-node ${currentZone === "Z0" ? "active" : ""}`}>
                <strong>ZONE Z0</strong>
                <span>CRITICAL (0%)</span>
                <small>Refill Threshold</small>
              </div>
              <div className="step-connector">──►</div>
              <div className={`step-node ${currentZone === "Z1" ? "active" : ""}`}>
                <strong>ZONE Z1</strong>
                <span>NOMINAL (50%)</span>
                <small>Hysteresis Mid</small>
              </div>
              <div className="step-connector">──►</div>
              <div className={`step-node ${currentZone === "Z2" ? "active" : ""}`}>
                <strong>ZONE Z2</strong>
                <span>FULL (100%)</span>
                <small>Cut-off Trigger</small>
              </div>
            </div>

            {/* 4-Item Analytics Metrics Grid */}
            <div className="predictive-quad-grid">
              <div className="pred-stat-card">
                <span className="psc-label">CURRENT ACTIVE ZONE</span>
                <strong className="psc-val highlight-cyan">{currentZone} ({currentLevel}%)</strong>
                <small className="psc-sub">Active Reservoir Status</small>
              </div>
              <div className="pred-stat-card">
                <span className="psc-label">NEXT TARGET ZONE</span>
                <strong className="psc-val text-amber">{prediction?.nextZone || "Z0"}</strong>
                <small className="psc-sub">Next Physical Trigger</small>
              </div>
              <div className="pred-stat-card">
                <span className="psc-label">ESTIMATED TIME TO NEXT</span>
                <strong className="psc-val highlight-cyan">{prediction?.timeToNext || "—"}</strong>
                <small className="psc-sub">Probe Crossing Delta Calculation</small>
              </div>
              <div className="pred-stat-card">
                <span className="psc-label">RATE OF CHANGE</span>
                <strong className="psc-val">{prediction?.rate || "STABLE"}</strong>
                <small className="psc-sub">Depletion Velocity</small>
              </div>
            </div>

            {/* Bottom Summary Bar */}
            <div className="pred-footer-bar">
              <div className="pf-item">
                <span>TRANSITION TREND:</span>
                <strong className={prediction?.trend?.includes("DEPLETING") ? "text-amber" : prediction?.trend?.includes("REFILLING") ? "text-green" : ""}>
                  {prediction?.trend || "STABLE"}
                </strong>
              </div>
              <div className="pf-item">
                <span>PREDICTION CONFIDENCE:</span>
                <span className={`pred-badge ${prediction?.confidence === "HIGH" ? "pred-ok" : "pred-warn"}`}>
                  {prediction?.confidence || "MEDIUM"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: System Safety & Hardware Diagnostics */}
        <div className="deck-card safety-master-card">
          <div className="deck-card-header">
            <span className="card-tag">SYSTEM SAFETY & HARDWARE GUARD</span>
            <span className="pill-badge badge-info">DIAGNOSTICS</span>
          </div>

          <div className="safety-content-layout">
            <div className="safety-six-grid">
              <div className="safety-tile">
                <div className="st-head">
                  <span className="h-dot green"></span>
                  <span>TASK WATCHDOG</span>
                </div>
                <strong>ACTIVE (8s WDT)</strong>
                <small>Hardware CPU recovery</small>
              </div>

              <div className="safety-tile">
                <div className="st-head">
                  <span className="h-dot green"></span>
                  <span>DEBOUNCE FILTER</span>
                </div>
                <strong>2.5s STABLE HOLD</strong>
                <small>Wave slosh protection</small>
              </div>

              <div className="safety-tile">
                <div className="st-head">
                  <span className={`h-dot ${isSafetyLocked ? "red" : "green"}`}></span>
                  <span>RUNTIME GUARD</span>
                </div>
                <strong>{isSafetyLocked ? "CUT-OFF" : "NORMAL (10m Limit)"}</strong>
                <small>{safetyStatus?.currentRuntimeSeconds || 0}s elapsed</small>
              </div>

              <div className="safety-tile">
                <div className="st-head">
                  <span className={`h-dot ${safetyStatus?.safetyReason === "POSSIBLE_DRY_RUN" ? "amber" : "green"}`}></span>
                  <span>DRY-RUN MONITOR</span>
                </div>
                <strong>{safetyStatus?.safetyReason === "POSSIBLE_DRY_RUN" ? "TRIGGERED" : "CLEAR"}</strong>
                <small>Inflow verification</small>
              </div>

              <div className="safety-tile">
                <div className="st-head">
                  <span className="h-dot green"></span>
                  <span>BOOT-SAFE STATE</span>
                </div>
                <strong>ENGAGED (RELAY OFF)</strong>
                <small>Power-loss protection</small>
              </div>

              <div className="safety-tile">
                <div className="st-head">
                  <span className="h-dot green"></span>
                  <span>INTERLOCK GUARD</span>
                </div>
                <strong>ACTIVE</strong>
                <small>Overfill & dry lock</small>
              </div>
            </div>

            {isSafetyLocked ? (
              <button className="btn-reset-safety-card" onClick={handleResetAlarm}>
                RESET SAFETY ALARM
              </button>
            ) : (
              <div className="safety-status-bar">
                <span className="h-dot green"></span>
                <span>All automated safety interlocks and hardware watchdog loops operating normally.</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── ROW 3: WATER LEVEL TREND TELEMETRY (WIDE GRAPH) ── */}
      <section className="deck-card trend-wide-card">
        <div className="deck-card-header">
          <div className="trend-header-left">
            <span className="card-tag">WATER LEVEL TREND TELEMETRY 📈</span>
            <span className="trend-stat-pill">
              CURRENT: <strong>{currentLevel}% ({currentZone})</strong> | TREND: <strong>{prediction?.trend || "STABLE"}</strong> | SAMPLES: <strong>{history.length}</strong>
            </span>
          </div>
          <div className="trend-legend-pills">
            <span className="leg-item"><span className="leg-dot cyan"></span> Level (%)</span>
            <span className="leg-item"><span className="leg-dot green"></span> Pump Active Marker</span>
            <span className="leg-item"><span className="leg-line dashed"></span> Zone Thresholds</span>
          </div>
        </div>

        <div className="trend-graph-viewport">
          {history.length < 2 ? (
            <div className="chart-empty-placeholder">
              Collecting data points to plot trend graph...
            </div>
          ) : (
            <svg
              className="trend-svg"
              viewBox={`0 0 ${graphData.width} ${graphData.height}`}
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="largeWaterGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.30" />
                  <stop offset="60%" stopColor="#0284c7" stopOpacity="0.08" />
                  <stop offset="100%" stopColor="#0284c7" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* 3-Probe Horizontal Calibration Gridlines with Readable Labels */}
              {[
                { lvl: 100, label: "100% (FULL)" },
                { lvl: 50, label: "50% (NOMINAL)" },
                { lvl: 0, label: "0% (CRITICAL)" }
              ].map((tier) => {
                const y = graphData.paddingTop + graphData.plotHeight * (1 - tier.lvl / 100);
                return (
                  <g key={tier.lvl}>
                    <line
                      x1={graphData.paddingLeft}
                      y1={y}
                      x2={graphData.width - 25}
                      y2={y}
                      stroke={tier.lvl === 0 ? "rgba(239,68,68,0.3)" : tier.lvl === 100 ? "rgba(16,185,129,0.3)" : "rgba(255,255,255,0.08)"}
                      strokeDasharray={tier.lvl === 0 ? "none" : "4 4"}
                    />
                    <text
                      x={graphData.paddingLeft - 12}
                      y={y + 4}
                      className="svg-y-label"
                      textAnchor="end"
                    >
                      {tier.label}
                    </text>
                  </g>
                );
              })}

              {/* Shaded Area & Clean Cyan Line */}
              <path d={graphData.area} fill="url(#largeWaterGrad)" />
              <path d={graphData.path} fill="none" stroke="#38bdf8" strokeWidth="2.5" />

              {/* Data Node Dots (With Pump Active Halos) */}
              {graphData.points.map((pt, i) => (
                <g key={i}>
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={pt.pump ? 6 : 4}
                    className={`svg-data-node ${pt.pump ? "node-pump-active" : ""}`}
                  />
                  <title>
                    {`Level: ${pt.level}% (${pt.zone}) | Pump: ${pt.pump ? "ON (ACTIVE)" : "OFF"} | ${new Date(pt.time).toLocaleTimeString()}`}
                  </title>
                </g>
              ))}

              {/* X-Axis Timestamps */}
              <text x={graphData.paddingLeft} y={graphData.height - 6} className="svg-x-label" textAnchor="start">
                {new Date(history[0].createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </text>
              <text x={graphData.width - 25} y={graphData.height - 6} className="svg-x-label" textAnchor="end">
                {new Date(history[history.length - 1].createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </text>
            </svg>
          )}
        </div>
      </section>

      {/* ── ROW 4: CONNECTIVITY & AUDIT TRAIL (50% / 50% BALANCED) ── */}
      <section className="master-two-col-grid">
        {/* Connectivity & Infrastructure Card */}
        <div className="deck-card health-master-card">
          <div className="deck-card-header">
            <span className="card-tag">SYSTEM INFRASTRUCTURE & CONNECTIVITY</span>
            <span className="health-sync-counter">Last Heartbeat: {secondsAgo}s ago</span>
          </div>

          <div className="health-checklist">
            <div className="health-row">
              <div className="hr-left">
                <strong>ESP32 Microcontroller Node</strong>
                <span>{health?.esp32 === "ONLINE" ? `RSSI: ${health?.rssi} • Free Heap: ${health?.freeHeap} • Uptime: ${health?.uptime}` : "Physical telemetry node via Wi-Fi"}</span>
              </div>
              <div className="health-status">
                <span className={`h-dot ${health?.esp32 === "ONLINE" ? "green" : "amber"}`}></span>
                <strong>{health?.esp32 || "OFFLINE"}</strong>
              </div>
            </div>

            <div className="health-row">
              <div className="hr-left">
                <strong>Hardware Task Watchdog & Reboot Diagnostic</strong>
                <span>esp_task_wdt (8s) • Boot: {health?.resetReason || "NORMAL"}</span>
              </div>
              <div className="health-status">
                <span className="h-dot green"></span>
                <strong>ACTIVE</strong>
              </div>
            </div>

            <div className="health-row">
              <div className="hr-left">
                <strong>Probe Sensor Plausibility</strong>
                <span>{health?.sensors === "NORMAL" ? "Independent debounced dual-probe validation" : "IMPOSSIBLE STATE: Full probe wet while Low dry!"}</span>
              </div>
              <div className="health-status">
                <span className={`h-dot ${health?.sensors === "NORMAL" ? "green" : "red"}`}></span>
                <strong>{health?.sensors || "NORMAL"}</strong>
              </div>
            </div>

            <div className="health-row">
              <div className="hr-left">
                <strong>Node.js Ingestion Gateway</strong>
                <span>REST API & Desired-State Lease (Port 5000)</span>
              </div>
              <div className="health-status">
                <span className="h-dot green"></span>
                <strong>CONNECTED</strong>
              </div>
            </div>

            <div className="health-row">
              <div className="hr-left">
                <strong>MongoDB Time-Series DB</strong>
                <span>7-Day TTL Auto-Pruning Active</span>
              </div>
              <div className="health-status">
                <span className={`h-dot ${health?.mongodb === "CONNECTED" ? "green" : "red"}`}></span>
                <strong>ONLINE</strong>
              </div>
            </div>
          </div>
        </div>

        {/* Safety Audit Trail & Event Ledger Card */}
        <div className="deck-card audit-master-card">
          <div className="deck-card-header">
            <span className="card-tag">SAFETY AUDIT TRAIL & LOG LEDGER</span>
            <span className="history-count">{events.length} LOGGED EVENTS</span>
          </div>

          <div className="audit-records-list">
            {events.length === 0 ? (
              <div className="log-empty-msg">No safety incidents or override events logged yet</div>
            ) : (
              events.slice(0, 5).map((evt, idx) => (
                <div key={evt._id || idx} className="audit-record-row">
                  <span className="record-time">
                    {new Date(evt.createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`event-type-badge ${evt.severity === "CRITICAL" ? "tag-crit" : evt.severity === "WARNING" ? "tag-warn" : "tag-info"}`}>
                    {evt.eventType}
                  </span>
                  <span className="event-details-text" title={evt.details}>{evt.details}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* ── FOOTER: HARDWARE SIMULATION & TESTBENCH ── */}
      <footer className="deck-card sim-footer-bar">
        
        <div className="sim-buttons-array">
          {[
            { lvl: 0, label: "0% — ZONE Z0 (PUMP STARTS)" },
            { lvl: 50, label: "50% — ZONE Z1 (NOMINAL HOLD)" },
            { lvl: 100, label: "100% — ZONE Z2 (CUT-OFF STOPS PUMP)" }
          ].map((tier) => (
            <button
              key={tier.lvl}
              disabled={simulating}
              className={`btn-sim-seg ${currentLevel === tier.lvl ? "active" : ""}`}
              onClick={() => injectLevel(tier.lvl)}
            >
              [{tier.label}]
            </button>
          ))}
          {isSafetyLocked && (
            <button className="btn-sim-seg btn-sim-reset" onClick={handleResetAlarm}>
              [RESET SAFETY ALARM]
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
