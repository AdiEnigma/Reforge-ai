/**
 * vision-adapter.js
 * Communicates with the optional Python vision preprocessing service.
 * Falls open by default: if the service is unavailable or disabled,
 * returns null so the existing Gemini-only path continues unchanged.
 */
import { request } from 'node:http';

const VISION_PIPELINE_ENABLED = process.env.VISION_PIPELINE_ENABLED === 'true';
const VISION_SERVICE_URL = process.env.VISION_SERVICE_URL || 'http://127.0.0.1:8765';
const VISION_FAIL_OPEN = process.env.VISION_FAIL_OPEN !== 'false'; // default true
const VISION_REQUEST_TIMEOUT_MS = (Number(process.env.VISION_REQUEST_TIMEOUT_SECONDS) || 60) * 1000;

/** @returns {boolean} Whether vision pipeline is enabled */
export function isVisionEnabled() {
  return VISION_PIPELINE_ENABLED;
}

/**
 * Call POST /process on the Python vision service.
 * Always resolves (never rejects) — returns null on any failure when VISION_FAIL_OPEN=true.
 * @param {Array<{data: string, mimeType: string}>} images - validated images
 * @param {Object} reference - sanitized reference dimensions
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

  return new Promise((resolve) => {
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
              console.warn('[vision-adapter] Malformed vision service response (missing schema_version or images)');
              resolve(null);
            }
          } catch (e) {
            console.warn('[vision-adapter] Invalid JSON from vision service:', e.message);
            resolve(null);
          }
        });
      }
    );

    req.setTimeout(VISION_REQUEST_TIMEOUT_MS, () => {
      console.warn('[vision-adapter] Vision service request timed out after', VISION_REQUEST_TIMEOUT_MS, 'ms');
      req.destroy();
      resolve(null);
    });

    req.on('error', (e) => {
      if (!VISION_FAIL_OPEN) {
        console.error('[vision-adapter] VISION_FAIL_OPEN=false but service is unreachable:', e.message);
      } else {
        console.warn('[vision-adapter] Vision service unreachable (continuing without vision):', e.message);
      }
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Build a compact summary of vision evidence for Gemini prompt injection.
 * Strips large arrays to counts only. Safe to JSON.stringify.
 * @param {Object|null} visionResult - full vision service response
 * @returns {Object|null}
 */
export function buildVisionEvidenceSummary(visionResult) {
  if (!visionResult || !Array.isArray(visionResult.images)) return null;

  return {
    schema_version: visionResult.schema_version,
    status: visionResult.status,
    device: visionResult.device,
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
