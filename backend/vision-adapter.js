/**
 * vision-adapter.js
 * Communicates with the optional Python vision preprocessing service.
 * Falls open by default: if the service is unavailable or disabled,
 * returns null so the existing Gemini-only path continues unchanged.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function visionConfig() {
  return {
    enabled: process.env.VISION_PIPELINE_ENABLED === 'true',
    serviceUrl: process.env.VISION_SERVICE_URL || 'http://127.0.0.1:8765',
    failOpen: process.env.VISION_FAIL_OPEN !== 'false',
    timeoutMs: (Number(process.env.VISION_REQUEST_TIMEOUT_SECONDS) || 60) * 1000,
  };
}

/** @returns {boolean} Whether vision pipeline is enabled */
export function isVisionEnabled() {
  return visionConfig().enabled;
}

/**
 * Call POST /process on the Python vision service.
 * Always resolves (never rejects) — returns null on any failure when VISION_FAIL_OPEN=true.
 * @param {Array<{data: string, mimeType: string}>} images - validated images
 * @param {Object} reference - sanitized reference dimensions
 * @returns {Promise<Object|null>}
 */
export async function callVisionService(images, reference) {
  const config = visionConfig();
  if (!config.enabled) return null;

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
      url = new URL('/process', config.serviceUrl);
    } catch {
      console.warn('[vision-adapter] Invalid VISION_SERVICE_URL:', config.serviceUrl);
      return resolve(null);
    }

    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

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

    req.setTimeout(config.timeoutMs, () => {
      console.warn('[vision-adapter] Vision service request timed out after', config.timeoutMs, 'ms');
      req.destroy();
      resolve(null);
    });

    req.on('error', (e) => {
      if (!config.failOpen) {
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

const OBSERVATION_LIMITS = {
  circles: 50,
  ellipses: 30,
  lines: 100,
  contours: 50,
};

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function contourBoundingBox(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = finiteOrNull(point[0]);
    const y = finiteOrNull(point[1]);
    if (x == null || y == null) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/**
 * Forward raw OpenCV observations (circles, ellipses, lines, contour geometry)
 * so the reconstruction solver can consume them. Heavy point arrays are
 * reduced to bounding boxes + counts; every list is capped to bound payloads.
 * All pixel values remain in original-image coordinates.
 * @param {Object|null} visionResult - full vision service response
 * @returns {Object|null}
 */
export function buildVisionObservations(visionResult) {
  if (!visionResult || !Array.isArray(visionResult.images)) return null;

  return {
    schema_version: visionResult.schema_version || '1.0',
    status: visionResult.status || null,
    device: visionResult.device || null,
    images: visionResult.images.map((img) => {
      const opencv = img.opencv || {};
      const circles = (Array.isArray(opencv.circles) ? opencv.circles : [])
        .slice(0, OBSERVATION_LIMITS.circles)
        .map((circle) => ({
          cx_px: finiteOrNull(circle.cx_px),
          cy_px: finiteOrNull(circle.cy_px),
          radius_px: finiteOrNull(circle.radius_px),
          confidence: finiteOrNull(circle.confidence),
        }))
        .filter((circle) => circle.radius_px != null);

      const ellipses = (Array.isArray(opencv.ellipses) ? opencv.ellipses : [])
        .slice(0, OBSERVATION_LIMITS.ellipses)
        .map((ellipse) => ({
          cx_px: finiteOrNull(ellipse.cx_px),
          cy_px: finiteOrNull(ellipse.cy_px),
          axes_px: Array.isArray(ellipse.axes_px)
            ? ellipse.axes_px.map(finiteOrNull).filter((value) => value != null)
            : null,
          angle_deg: finiteOrNull(ellipse.angle_deg),
          confidence: finiteOrNull(ellipse.confidence),
        }));

      const lines = (Array.isArray(opencv.lines) ? opencv.lines : [])
        .slice(0, OBSERVATION_LIMITS.lines)
        .map((line) => ({
          x1_px: finiteOrNull(line.x1_px),
          y1_px: finiteOrNull(line.y1_px),
          x2_px: finiteOrNull(line.x2_px),
          y2_px: finiteOrNull(line.y2_px),
          length_px: finiteOrNull(line.length_px),
          angle_deg: finiteOrNull(line.angle_deg),
          confidence: finiteOrNull(line.confidence),
        }));

      const contours = (Array.isArray(opencv.contours) ? opencv.contours : [])
        .slice(0, OBSERVATION_LIMITS.contours)
        .map((contour) => ({
          type: contour.type || null,
          bbox: contourBoundingBox(contour.points_px),
          area_px2: finiteOrNull(contour.area_px2),
          perimeter_px: finiteOrNull(contour.perimeter_px),
          circularity: finiteOrNull(contour.circularity),
          solidity: finiteOrNull(contour.solidity),
          point_count: Array.isArray(contour.points_px) ? contour.points_px.length : 0,
          confidence: finiteOrNull(contour.confidence),
        }));

      return {
        image_index: img.image_index,
        width: img.width ?? null,
        height: img.height ?? null,
        calibration: img.calibration || null,
        segmentation: img.segmentation
          ? {
              status: img.segmentation.status,
              bbox_xyxy_px: img.segmentation.bbox_xyxy_px ?? null,
              mask_area_ratio: finiteOrNull(img.segmentation.mask_area_ratio),
              score: finiteOrNull(img.segmentation.score),
            }
          : null,
        opencv: {
          circles,
          ellipses,
          lines,
          contours,
          bounding_box: opencv.bounding_box || null,
          symmetry_hints: opencv.symmetry_hints || null,
        },
      };
    }),
    warnings: Array.isArray(visionResult.warnings) ? visionResult.warnings : [],
  };
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
