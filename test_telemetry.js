// Industrial simulation script to test the hardened backend & dashboard
// Run with: node test_telemetry.js

const http = require("http");

const DEVICE_TOKEN = "AQUASENSE_ESP32_SECURE_TOKEN_2026";

const sendReading = (waterLevel, pump, isBoot = false) => {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ waterLevel, pump, isBoot });
    const req = http.request(
      {
        hostname: "localhost",
        port: 5000,
        path: "/api/water-data",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-device-token": DEVICE_TOKEN
        }
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const zone = waterLevel >= 100 ? "Z2" : waterLevel <= 0 ? "Z0" : "Z1";
            console.log(
              `[POST ${res.statusCode}] Zone: ${zone} (${waterLevel}%) | Pump: ${pump ? "ON" : "OFF"} | Piggyback Command: ${parsed.command || "NONE"} | Safety Lock: ${parsed.safetyLock ? "LOCKED" : "CLEAR"}`
            );
          } catch {
            console.log(`[POST ${res.statusCode}] ${body}`);
          }
          resolve(body);
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
};

async function runDemo() {
  console.log("==================================================================");
  console.log("Starting AquaSense Hardened 3-Probe Simulation (Zones Z0, Z1, Z2)");
  console.log(`Using Device Auth Token: ${DEVICE_TOKEN.substring(0, 10)}...`);
  console.log("==================================================================\n");

  const sequence = [
    { level: 50, pump: false, isBoot: true, desc: "Boot event at Mid Zone Z1" },
    { level: 0, pump: true, desc: "Drop to Critical Zone Z0 -> Automatic Refill starts" },
    { level: 50, pump: true, desc: "Refill rising through Zone Z1 -> Hysteresis pump holds ON" },
    { level: 100, pump: false, desc: "Full Zone Z2 reached -> Cut-off triggers pump OFF" },
    { level: 50, pump: false, desc: "Draining through Zone Z1 -> Hysteresis pump holds OFF" }
  ];

  for (const step of sequence) {
    console.log(`>> Step: ${step.desc}`);
    try {
      await sendReading(step.level, step.pump, step.isBoot);
    } catch (e) {
      console.error("Connection failed. Is server.js running? (cd backend && node server.js)");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\nSimulation sequence complete! Check the web dashboard at http://localhost:5173");
}

runDemo();
