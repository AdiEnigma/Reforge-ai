/**
 * analysis-log.js
 * Opt-in, consent-gated logging of analyses for a future evaluation dataset.
 *
 * Privacy rules:
 * - Off unless ANALYSIS_LOG_ENABLED=true.
 * - Requires explicit per-request consent.
 * - Raw photos are NOT stored by default; only SHA-256 hashes + metadata.
 *   Set ANALYSIS_LOG_INCLUDE_IMAGES=true only with a reviewed consent notice.
 * - Logs expire after ANALYSIS_LOG_RETENTION_DAYS (default 30).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, appendFile } from "node:fs/promises";

const DEFAULT_RETENTION_DAYS = 30;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function loggingEnabled() {
  return process.env.ANALYSIS_LOG_ENABLED === "true";
}

function includeImages() {
  return process.env.ANALYSIS_LOG_INCLUDE_IMAGES === "true";
}

function logDir() {
  const configured = process.env.ANALYSIS_LOG_DIR;
  return path.resolve(configured || path.join(MODULE_DIR, "var", "analysis-log"));
}

function retentionDays() {
  const value = Number(process.env.ANALYSIS_LOG_RETENTION_DAYS);
  return Math.max(Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS, 1);
}

function imageMetadata(images) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, 8).map((image) => {
    const data = typeof image?.data === "string" ? image.data : "";
    const buffer = Buffer.from(data, "base64");
    return {
      mimeType: typeof image?.mimeType === "string" ? image.mimeType : null,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  });
}

function compactAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") return null;
  const dimensions =
    analysis.dimensions && typeof analysis.dimensions === "object"
      ? Object.fromEntries(
          Object.entries(analysis.dimensions).filter(([, value]) =>
            typeof value === "number" && Number.isFinite(value)
          )
        )
      : {};
  return {
    componentType: analysis.componentType ?? analysis.component_type ?? null,
    dimensions,
    dimensionSources: analysis.dimensionSources || {},
    dimensionConfidence: analysis.dimensionConfidence || {},
    anchorDimension: analysis.anchorDimension || null,
    anchorSource: analysis.anchorSource || null,
    material: analysis.material ?? null,
    manufacturingProcess: analysis.manufacturingProcess ?? null,
  };
}

function compactCorrections(corrections) {
  if (!corrections || typeof corrections !== "object") return null;
  return Object.fromEntries(
    Object.entries(corrections).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value)
    )
  );
}

async function pruneOldLogs(directory, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    try {
      const info = await stat(filePath);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await unlink(filePath);
        removed += 1;
      }
    } catch {
      // ignore races/permission issues; retention is best-effort
    }
  }
  return removed;
}

/**
 * Append one consent-gated record. Never throws; returns a small status object.
 */
export async function logAnalysis({ images, analysis, reference, corrections, consent } = {}) {
  if (!loggingEnabled()) {
    return { logged: false, reason: "disabled" };
  }
  if (consent !== true) {
    return { logged: false, reason: "no_consent" };
  }

  const directory = logDir();
  try {
    await mkdir(directory, { recursive: true });
    await pruneOldLogs(directory, retentionDays());

    const record = {
      schema: "reforge-analysis-log/v1",
      recordedAt: new Date().toISOString(),
      consent: true,
      retentionDays: retentionDays(),
      reference:
        reference && typeof reference === "object" ? reference : {},
      analysis: compactAnalysis(analysis),
      userCorrections: compactCorrections(corrections),
      images: imageMetadata(images),
    };
    if (includeImages() && Array.isArray(images)) {
      record.imageData = images.slice(0, 8).map((image) => ({
        mimeType: image?.mimeType ?? null,
        data: image?.data ?? null,
      }));
    }

    const day = record.recordedAt.slice(0, 10);
    await appendFile(path.join(directory, `${day}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
    return { logged: true, file: `${day}.jsonl` };
  } catch (error) {
    console.warn("[analysis-log] Could not write analysis log:", error?.message);
    return { logged: false, reason: "write_failed" };
  }
}

export function analysisLogConfig() {
  return {
    enabled: loggingEnabled(),
    includeImages: includeImages(),
    retentionDays: retentionDays(),
  };
}
