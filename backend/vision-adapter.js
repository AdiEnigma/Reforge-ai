/**
 * vision-adapter.js
 * Communicates with the Python vision preprocessing service.
 * Supports dual-mode execution:
 * 1. Fast HTTP call to running vision service at VISION_SERVICE_URL (default http://127.0.0.1:8765)
 * 2. Automatic Direct CLI fallback (python cli_process.py) and background daemon auto-spawn if HTTP is offline.
 * Always resolves (never throws) adhering to fail-open safety.
 */
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISION_ENGINE_DIR = path.resolve(__dirname, '../vision-engine');

const VISION_PIPELINE_ENABLED = process.env.VISION_PIPELINE_ENABLED === 'true';
const VISION_SERVICE_URL = process.env.VISION_SERVICE_URL || 'http://127.0.0.1:8765';
const VISION_FAIL_OPEN = process.env.VISION_FAIL_OPEN !== 'false';
const VISION_REQUEST_TIMEOUT_MS = (Number(process.env.VISION_REQUEST_TIMEOUT_SECONDS) || 60) * 1000;

let isServerAutoSpawning = false;

/**
 * Spawns the python uvicorn vision engine in the background if not already running.
 */
export function ensureVisionServiceBackground() {
  if (isServerAutoSpawning) return;
  isServerAutoSpawning = true;
  try {
    const srv = spawn('python', ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8765'], {
      cwd: VISION_ENGINE_DIR,
      detached: true,
      stdio: 'ignore',
    });
    srv.unref();
  } catch (err) {
    console.warn('[vision-adapter] Background uvicorn spawn notice:', err.message);
  }
}

/** @returns {boolean} Whether vision pipeline is enabled */
export function isVisionEnabled() {
  return VISION_PIPELINE_ENABLED;
}

/**
 * Direct CLI fallback: executes python cli_process.py via child process IPC.
 */
export async function executeDirectVisionCli(images, reference) {
  return new Promise((resolve) => {
    let tmpIn = null;
    let tmpOut = null;
    try {
      const payload = JSON.stringify({
        images: images.map((img, idx) => ({
          data: img.data,
          mimeType: img.mimeType,
          image_index: idx,
        })),
        reference: reference || {},
      });

      const tmpDir = os.tmpdir();
      const runId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      tmpIn = path.join(tmpDir, `reforge_vis_in_${runId}.json`);
      tmpOut = path.join(tmpDir, `reforge_vis_out_${runId}.json`);
      fs.writeFileSync(tmpIn, payload, 'utf-8');

      const child = spawn('python', ['cli_process.py', tmpIn, tmpOut], {
        cwd: VISION_ENGINE_DIR,
        env: { ...process.env, VISION_DEVICE: process.env.VISION_DEVICE || 'cpu', PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });

      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        try { if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
        try { if (tmpOut && fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        console.warn('[vision-adapter] Direct CLI timed out');
        resolve(null);
      }, VISION_REQUEST_TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(timeout);
        let result = null;
        try {
          if (tmpOut && fs.existsSync(tmpOut)) {
            const raw = fs.readFileSync(tmpOut, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.images)) {
              result = parsed;
            }
          }
        } catch (e) {
          console.warn('[vision-adapter] Direct CLI parse error:', e.message);
        } finally {
          try { if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
          try { if (tmpOut && fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        }

        if (code !== 0 && !result) {
          console.warn('[vision-adapter] Direct CLI exited with code', code, stderr);
          return resolve(null);
        }
        resolve(result);
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        try { if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
        try { if (tmpOut && fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        console.warn('[vision-adapter] Failed to spawn python cli_process:', err.message);
        resolve(null);
      });
    } catch (err) {
      try { if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
      try { if (tmpOut && fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
      console.warn('[vision-adapter] Direct CLI invocation error:', err.message);
      resolve(null);
    }
  });
}

/**
 * Call POST /process on the Python vision service with transparent CLI fallback.
 * @param {Array<{data: string, mimeType: string}>} images
 * @param {Object} reference
 * @returns {Promise<Object|null>}
 */
export async function callVisionService(images, reference) {
  if (!VISION_PIPELINE_ENABLED) return null;

  const body = JSON.stringify({
    images: images.map((img, idx) => ({
      data: img.data,
      mimeType: img.mimeType,
      image_index: idx,
    })),
    reference: reference || {},
  });

  const httpResult = await new Promise((resolve) => {
    let url;
    try {
      url = new URL('/process', VISION_SERVICE_URL);
    } catch {
      console.warn('[vision-adapter] Invalid VISION_SERVICE_URL:', VISION_SERVICE_URL);
      return resolve(null);
    }

    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 8765,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.schema_version && Array.isArray(parsed.images)) {
              resolve(parsed);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.setTimeout(VISION_REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', (e) => {
      // Service offline — trigger background spawn and resolve null for CLI fallback
      ensureVisionServiceBackground();
      resolve(null);
    });

    req.write(body);
    req.end();
  });

  if (httpResult) {
    return httpResult;
  }

  // Fallback to direct Python CLI invocation
  return await executeDirectVisionCli(images, reference);
}

import { storeSpatialEvidence } from './src/spatial-evidence-store.js';

/**
 * Build a compact summary of vision evidence for Gemini prompt injection,
 * while anchoring it to the full uncompressed spatial evidence artifact ID.
 */
export function buildVisionEvidenceSummary(visionResult, evidenceRef = null) {
  if (!visionResult || !Array.isArray(visionResult.images)) return null;

  const actualRef = evidenceRef || storeSpatialEvidence(visionResult);

  return {
    schema_version: visionResult.schema_version,
    status: visionResult.status,
    device: visionResult.device,
    evidenceRef: actualRef,
    images: visionResult.images.map((img) => ({
      image_index: img.image_index,
      width: img.width,
      height: img.height,
      quality: img.quality,
      segmentation: img.segmentation
        ? {
            status: img.segmentation.status,
            bbox_xyxy_px: img.segmentation.bbox_xyxy_px,
            mask_area_ratio: img.segmentation.mask_area_ratio,
            candidate_count: img.segmentation.candidate_count,
            score: img.segmentation.score,
            needs_user_selection: img.segmentation.needs_user_selection,
          }
        : null,
      opencv: img.opencv
        ? {
            contour_count: Array.isArray(img.opencv.contours) ? img.opencv.contours.length : 0,
            circle_count: Array.isArray(img.opencv.circles) ? img.opencv.circles.length : 0,
            ellipse_count: Array.isArray(img.opencv.ellipses) ? img.opencv.ellipses.length : 0,
            line_count: Array.isArray(img.opencv.lines) ? img.opencv.lines.length : 0,
            bounding_box: img.opencv.bounding_box,
            symmetry_hints: img.opencv.symmetry_hints,
            tooth_count: img.opencv.tooth_count
              ? {
                  status: img.opencv.tooth_count.status,
                  count: img.opencv.tooth_count.count ?? null,
                  confidence: img.opencv.tooth_count.confidence ?? 0,
                  methods: Array.isArray(img.opencv.tooth_count.methods)
                    ? img.opencv.tooth_count.methods.map((method) => ({
                        method: method.method,
                        count: method.count ?? null,
                        confidence: method.confidence ?? 0,
                      }))
                    : [],
                  tooth_marker_count: Array.isArray(img.opencv.tooth_count.teeth)
                    ? img.opencv.tooth_count.teeth.length
                    : 0,
                  warnings: img.opencv.tooth_count.warnings || [],
                }
              : null,
            warnings: img.opencv.warnings,
          }
        : null,
      depth: img.depth
        ? {
            status: img.depth.status,
            depth_type: img.depth.depth_type,
            metric: img.depth.metric,
            warnings: img.depth.warnings,
          }
        : null,
      calibration: img.calibration,
    })),
    warnings: visionResult.warnings,
  };
}
