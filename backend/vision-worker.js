import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const engineDir = fileURLToPath(new URL("../vision-engine/", import.meta.url));

async function probe(url) {
  const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) });
  const health = response.ok && await response.json();
  if (health?.service !== "reforge-vision-engine") {
    throw new Error("The configured port is occupied by another service.");
  }
  return health;
}

export async function startLocalVision(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) return;
  try {
    const health = await probe(url);
    if (!health.device?.sam2_loaded || !health.device?.depth_loaded) {
      console.warn("The existing vision service has unloaded models. Stop its standalone terminal and restart the backend to use the managed worker.");
    }
    console.log("Using the running ReForge vision service at", url.origin);
    return;
  } catch (err) {
    if (err.cause?.code !== "ECONNREFUSED") throw err;
  }

  const executable = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  const python = [".venv", "../.venv"].map(dir => path.resolve(engineDir, dir, executable))
    .find(candidate => existsSync(candidate)) || "python";
  const child = spawn(python, ["-B", "app.py", "--parent-pid", String(process.pid)], {
    cwd: engineDir, windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, VISION_SERVICE_HOST: "127.0.0.1", VISION_SERVICE_PORT: url.port || "80" },
  });
  let stopped;
  child.once("error", err => { stopped = err; });
  child.once("exit", (code, signal) => { stopped = new Error("Vision worker exited (" + (signal || code) + ")."); });
  // The worker watches the backend PID so an abrupt parent exit also releases the port.
  const deadline = Date.now() + 120000;
  while (!stopped && Date.now() < deadline) {
    await delay(500);
    try { await probe(url); console.log("ReForge vision ready at", url.origin); return; } catch { /* model initialization */ }
  }
  child.kill();
  throw stopped || new Error("Vision worker startup timed out.");
}
