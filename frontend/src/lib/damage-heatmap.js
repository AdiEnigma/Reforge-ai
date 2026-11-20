/**
 * damage-heatmap.js
 *
 * Pure helpers for the image-space damage heatmap.
 *
 * The heatmap is drawn on the ORIGINAL uploaded photograph using the pixel
 * mask generated from that same photograph. Nothing here generates colours
 * from geometry, shaders or random values: the only painted pixels are those
 * segmented as rust, corrosion or pitting by the local detector.
 */

export const DAMAGE_LEVELS = [
  { key: 'low', label: 'Low', color: '#2ecc71', rgb: '46, 204, 113' },
  { key: 'moderate', label: 'Moderate', color: '#f1c40f', rgb: '241, 196, 15' },
  { key: 'high', label: 'High', color: '#f39c12', rgb: '243, 156, 18' },
  { key: 'severe', label: 'Severe', color: '#e74c3c', rgb: '231, 76, 60' },
];

const LEVEL_KEYS = new Set(DAMAGE_LEVELS.map((level) => level.key));
const MAX_REGIONS = 24;
const MIN_SIZE = 0.01;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Fallback for assessments produced before `level` was added by the backend. */
export function levelForSeverity(severity, extent) {
  if (severity === 'minor') return 'low';
  if (severity === 'moderate') return 'moderate';
  if (severity === 'severe') return extent === 'widespread' ? 'severe' : 'high';
  return 'low';
}

/**
 * Sanitizes backend regions before they reach the DOM. Invalid boxes are
 * dropped rather than approximated, so undetected areas stay unmarked.
 */
export function normalizeDamageRegions(regions, imageCount = 1) {
  if (!Array.isArray(regions)) return [];
  const maxIndex = Math.max(0, imageCount - 1);
  const clean = [];

  for (const region of regions) {
    if (!region || typeof region !== 'object') continue;
    const rawIndex = number(region.imageIndex);
    const rawX = number(region.x);
    const rawY = number(region.y);
    const rawWidth = number(region.width);
    const rawHeight = number(region.height);
    if (
      rawIndex == null ||
      rawX == null ||
      rawY == null ||
      rawWidth == null ||
      rawHeight == null
    ) {
      continue;
    }

    const imageIndex = clamp(Math.round(rawIndex), 0, maxIndex);
    const x = clamp(rawX, 0, 1);
    const y = clamp(rawY, 0, 1);
    const width = clamp(rawWidth, 0, 1 - x);
    const height = clamp(rawHeight, 0, 1 - y);
    if (width < MIN_SIZE || height < MIN_SIZE) continue;

    const level = LEVEL_KEYS.has(region.level)
      ? region.level
      : levelForSeverity(region.severity, region.extent);
    const confidenceRaw = number(region.confidence);
    const confidence = confidenceRaw == null ? 0.7 : clamp(confidenceRaw, 0, 1);

    clean.push({
      imageIndex,
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height),
      type: region.type || 'damage',
      severity: region.severity || 'moderate',
      extent: region.extent || 'localized',
      label: region.label || 'Detected damage',
      level,
      confidence: round(confidence, 2),
    });
  }

  return clean.slice(0, MAX_REGIONS);
}

const MASK_PREFIX = 'data:image/png;base64,';
const VALID_SEVERITIES = new Set(['minor', 'moderate', 'severe']);
const VALID_EXTENTS = new Set(['localized', 'widespread']);

function statsNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Sanitize backend pixel masks. Anything invalid is dropped, never painted. */
export function normalizeDamageMasks(masks, imageCount = 1) {
  if (!Array.isArray(masks)) return [];
  const maxIndex = Math.max(0, imageCount - 1);
  const clean = [];

  for (const mask of masks) {
    if (!mask || typeof mask.dataUrl !== 'string' || !mask.dataUrl.startsWith(MASK_PREFIX)) continue;
    const width = Math.round(statsNumber(mask.width));
    const height = Math.round(statsNumber(mask.height));
    const raw = mask.stats && typeof mask.stats === 'object' ? mask.stats : {};
    if (width <= 0 || height <= 0) continue;

    const maskedPixels = Math.max(0, Math.round(statsNumber(raw.maskedPixels)));
    const levelCounts = raw.levelCounts && typeof raw.levelCounts === 'object' ? raw.levelCounts : {};
    clean.push({
      imageIndex: clamp(Math.round(statsNumber(mask.imageIndex)), 0, maxIndex),
      width,
      height,
      dataUrl: mask.dataUrl,
      stats: {
        maskedPixels,
        severity: VALID_SEVERITIES.has(raw.severity) ? raw.severity : null,
        extent: VALID_EXTENTS.has(raw.extent) ? raw.extent : 'localized',
        damageRatioOfComponent: clamp(statsNumber(raw.damageRatioOfComponent), 0, 1),
        connectedRegions: Math.max(0, Math.round(statsNumber(raw.connectedRegions))),
        confidence: clamp(statsNumber(raw.confidence, 0.5), 0, 1),
        types: Array.isArray(raw.types) ? raw.types.filter((type) => typeof type === 'string') : [],
        levelCounts: {
          low: Math.max(0, Math.round(statsNumber(levelCounts.low))),
          moderate: Math.max(0, Math.round(statsNumber(levelCounts.moderate))),
          high: Math.max(0, Math.round(statsNumber(levelCounts.high))),
          severe: Math.max(0, Math.round(statsNumber(levelCounts.severe))),
        },
      },
    });
  }

  return clean.slice(0, 8);
}

/**
 * Converts an assessment + component images into everything the overlay needs.
 * Painting comes only from a pixel mask generated from the source photograph.
 */
export function getDamageHeatmapData(assessment, images) {
  const imageList = Array.isArray(images)
    ? images.filter((image) => image && typeof image.url === 'string' && image.url)
    : [];
  const blocked =
    !assessment ||
    assessment.imageQuality === 'insufficient' ||
    imageList.length === 0;
  const masks = blocked ? [] : normalizeDamageMasks(assessment.damageMasks, imageList.length);
  const paintedMasks = masks.filter((mask) => mask.stats.maskedPixels > 0);

  let message = '';
  if (!assessment) {
    message = 'No damage assessment available. Re-run analysis to generate a heatmap.';
  } else if (assessment.imageQuality === 'insufficient') {
    message = 'Image quality was insufficient for reliable damage detection.';
  } else if (imageList.length === 0) {
    message = 'No component image available for the heatmap.';
  } else if (assessment.damageMaskUnavailable || masks.length === 0) {
    const defectsReported =
      (Array.isArray(assessment.observedDefects) && assessment.observedDefects.length > 0) ||
      (typeof assessment.wearEvidenceCount === 'number' && assessment.wearEvidenceCount > 0);
    message = defectsReported
      ? 'Defects were reported but no pixel mask was returned. No areas are painted.'
      : 'Pixel-level segmentation was unavailable. No areas are painted.';
  } else if (paintedMasks.length === 0) {
    message = 'No visible rust, corrosion or pitting was segmented. Clean areas remain transparent.';
  }

  const preferredIndex = paintedMasks.length > 0 ? paintedMasks[0].imageIndex : 0;
  const image = imageList.find((_, index) => index === preferredIndex) || imageList[0] || null;
  const mask = masks.find((item) => item.imageIndex === preferredIndex) || null;

  return {
    available: paintedMasks.length > 0 && Boolean(image) && Boolean(mask),
    image,
    mask,
    masks,
    paintedMasks,
    preferredIndex,
    imageCount: imageList.length,
    message,
  };
}
