/**
 * damage-mask-adapter.js
 * Runs python-engine/damage_mask.py to produce pixel-level damage masks from
 * the uploaded photographs. The mask is an RGBA PNG in the original image
 * coordinate system, so the UI can overlay it exactly on the source photo.
 *
 * No coordinates or damage locations are supplied to the Python stage. The
 * model's observed defect types are passed only as a weak semantic hint for
 * labelling/classifying pixels that the detector has already found.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../python-engine/damage_mask.py");
const TIMEOUT_MS = (Number(process.env.DAMAGE_MASK_TIMEOUT_SECONDS) || 60) * 1000;
const PNG_PREFIX = "data:image/png;base64,";
const SEVERITIES = new Set(["minor", "moderate", "severe"]);
const EXTENTS = new Set(["localized", "widespread"]);
const TYPES = new Set([
  "corrosion", "rust", "surface_pitting", "tooth_wear", "chipping", "crack",
  "deformation", "scoring", "discoloration", "surface_roughness", "contamination",
]);

function interpreterCandidates() {
  const candidates = [];
  if (process.env.DAMAGE_MASK_PYTHON) candidates.push(process.env.DAMAGE_MASK_PYTHON);
  if (process.env.CAD_EXPORT_PYTHON) candidates.push(process.env.CAD_EXPORT_PYTHON);
  candidates.push(path.resolve(__dirname, "../.venv/Scripts/python.exe"));
  candidates.push(path.resolve(__dirname, "../.venv/bin/python"));
  // On Windows, `python3` is often a Microsoft Store alias that cannot import
  // OpenCV. Prefer `python` there; keep the usual POSIX order elsewhere.
  if (process.platform === "win32") {
    candidates.push("python", "python3");
  } else {
    candidates.push("python3", "python");
  }
  return candidates;
}

function hasDetectorDependencies(python) {
  try {
    const probe = spawnSync(python, ["-c", "import cv2, numpy"], {
      stdio: "ignore",
      timeout: 10000,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

export function resolveDamageMaskInterpreter() {
  for (const candidate of interpreterCandidates()) {
    const isPath = candidate.includes("/") || candidate.includes("\\");
    if (isPath && !existsSync(candidate)) continue;
    if (hasDetectorDependencies(candidate)) return candidate;
  }
  return null;
}

export function isDamageMaskScriptPresent() {
  return existsSync(SCRIPT);
}

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStats(raw) {
  if (!raw || typeof raw !== "object") return null;
  const levelCounts = raw.levelCounts && typeof raw.levelCounts === "object" ? raw.levelCounts : {};
  const severity = SEVERITIES.has(raw.severity) ? raw.severity : null;
  return {
    componentPixels: Math.max(0, Math.round(finite(raw.componentPixels))),
    maskedPixels: Math.max(0, Math.round(finite(raw.maskedPixels))),
    componentPixelRatio: Math.min(1, Math.max(0, finite(raw.componentPixelRatio))),
    damagePixelRatio: Math.min(1, Math.max(0, finite(raw.damagePixelRatio))),
    damageRatioOfComponent: Math.min(1, Math.max(0, finite(raw.damageRatioOfComponent))),
    connectedRegions: Math.max(0, Math.round(finite(raw.connectedRegions))),
    largestRegionRatio: Math.min(1, Math.max(0, finite(raw.largestRegionRatio))),
    largestRegionPixels: Math.max(0, Math.round(finite(raw.largestRegionPixels))),
    spread: Math.min(1, Math.max(0, finite(raw.spread))),
    severity,
    extent: EXTENTS.has(raw.extent) ? raw.extent : "localized",
    confidence: Math.min(1, Math.max(0, finite(raw.confidence, 0.5))),
    levelCounts: {
      low: Math.max(0, Math.round(finite(levelCounts.low))),
      moderate: Math.max(0, Math.round(finite(levelCounts.moderate))),
      high: Math.max(0, Math.round(finite(levelCounts.high))),
      severe: Math.max(0, Math.round(finite(levelCounts.severe))),
    },
    types: Array.isArray(raw.types)
      ? [...new Set(raw.types.filter((type) => TYPES.has(type)))]
      : [],
  };
}

export function normalizeDamageMasks(result, imageCount = 1) {
  if (!result || result.ok !== true || !Array.isArray(result.masks)) return [];
  const maxIndex = Math.max(0, imageCount - 1);
  const clean = [];

  for (const mask of result.masks) {
    if (!mask || typeof mask.dataUrl !== "string" || !mask.dataUrl.startsWith(PNG_PREFIX)) continue;
    const stats = normalizeStats(mask.stats);
    if (!stats) continue;
    const width = Math.round(finite(mask.width));
    const height = Math.round(finite(mask.height));
    if (width <= 0 || height <= 0) continue;
    const rawIndex = Math.round(finite(mask.imageIndex));

    clean.push({
      imageIndex: Math.min(maxIndex, Math.max(0, rawIndex)),
      width,
      height,
      dataUrl: mask.dataUrl,
      stats,
    });
  }
  return clean.slice(0, 8);
}

function runDetector(python, payload) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(python, [SCRIPT], { cwd: path.dirname(SCRIPT), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`Could not start the damage mask detector: ${error.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish(reject, new Error("Pixel-level damage segmentation timed out."));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => { /* close handler reports failures */ });
    child.stdin.end(JSON.stringify(payload));

    child.on("error", (error) => {
      finish(reject, new Error(`Damage mask detector could not run: ${error.message}`));
    });
    child.on("close", () => {
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          parsed = JSON.parse(lines[i]);
          break;
        } catch {
          // keep looking for the JSON result line
        }
      }
      if (!parsed) {
        const detail = stderr.trim().split(/\r?\n/).slice(-2).join(" ").trim();
        finish(reject, new Error(detail ? `Damage detector produced no result: ${detail}` : "Damage detector produced no result."));
        return;
      }
      if (!parsed.ok) {
        finish(reject, new Error(parsed.error || "Pixel-level damage segmentation failed."));
        return;
      }
      finish(resolve, parsed);
    });
  });
}

export async function generateDamageMasks({ images, observedTypes = [] } = {}) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const python = resolveDamageMaskInterpreter();
  if (!isDamageMaskScriptPresent()) {
    throw new Error("The pixel damage detector script is missing (python-engine/damage_mask.py).");
  }
  if (!python) {
    throw new Error("Pixel damage detection needs Python with OpenCV and NumPy. Set DAMAGE_MASK_PYTHON.");
  }

  const raw = await runDetector(python, {
    images: images.map((image, index) => ({
      data: image.data,
      mimeType: image.mimeType,
      imageIndex: index,
    })),
    observedTypes,
  });
  return normalizeDamageMasks(raw, images.length);
}
