/**
 * dimensions.js
 * Normalises dimension provenance coming from the backend into rows the
 * viewport can render. Estimated values are always labelled; anchored values
 * (user / measured) are highlighted so the export gate is understandable.
 */

export const DIMENSION_META = {
  outerDiameter: { label: 'OUTER Ø', unit: 'mm' },
  innerDiameter: { label: 'INNER Ø', unit: 'mm' },
  height: { label: 'HEIGHT', unit: 'mm' },
  length: { label: 'LENGTH', unit: 'mm' },
  thickness: { label: 'THICKNESS', unit: 'mm' },
  width: { label: 'WIDTH', unit: 'mm' },
  teeth: { label: 'TEETH', unit: 'count' },
  module: { label: 'MODULE', unit: 'mm' },
  helixAngle: { label: 'HELIX ANGLE', unit: 'deg' },
};

const FALLBACK_SOURCE_KEYS = {
  outerDiameter: (analysis) => analysis?.dimensions?.outerDiameter,
  innerDiameter: (analysis) => analysis?.dimensions?.innerDiameter,
  height: (analysis) => analysis?.dimensions?.height,
  length: (analysis) => analysis?.dimensions?.length,
  thickness: (analysis) => analysis?.dimensions?.thickness,
  width: (analysis) => analysis?.dimensions?.width,
  teeth: (analysis) => analysis?.teeth,
  module: (analysis) => analysis?.module,
  helixAngle: (analysis) => analysis?.helixAngle,
};

export function dimensionSourceLabel(source) {
  if (source === 'user') return 'USER';
  if (source === 'measured') return 'MEASURED';
  return 'ESTIMATED';
}

export function formatDimensionValue(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (unit === 'count') return String(Math.round(value));
  return Number(value.toFixed(2)).toString();
}

function normaliseRow(key, value, source, confidence, anchor, note) {
  const meta = DIMENSION_META[key] || { label: key.toUpperCase(), unit: 'mm' };
  return {
    key,
    label: meta.label,
    unit: meta.unit,
    value,
    source: source || 'estimated',
    confidence: typeof confidence === 'number' ? confidence : null,
    anchor: Boolean(anchor),
    note: typeof note === 'string' ? note : null,
  };
}

export function dimensionRows(analysis) {
  if (Array.isArray(analysis?.dimensionsDetail) && analysis.dimensionsDetail.length) {
    return analysis.dimensionsDetail
      .filter((dimension) => dimension && typeof dimension.value === 'number')
      .map((dimension) =>
        normaliseRow(
          dimension.key,
          dimension.value,
          dimension.source,
          dimension.confidence,
          dimension.anchor ??
            dimension.key === analysis.anchorDimension,
          dimension.note
        )
      );
  }

  const sources = analysis?.dimensionSources || {};
  const confidence = analysis?.dimensionConfidence || {};
  const rows = [];
  for (const [key, getValue] of Object.entries(FALLBACK_SOURCE_KEYS)) {
    const value = getValue(analysis);
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    rows.push(
      normaliseRow(
        key,
        value,
        sources[key],
        confidence[key],
        key === analysis?.anchorDimension,
        null
      )
    );
  }
  return rows;
}

export function bboxDimensionRows(bbox) {
  if (!bbox || typeof bbox !== 'object') return [];
  const axes = [
    ['X', bbox.xlen],
    ['Y', bbox.ylen],
    ['Z', bbox.zlen],
  ];
  return axes
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([axis, value]) => ({
      key: `bbox_${axis.toLowerCase()}`,
      label: `SOLID ${axis}`,
      unit: 'mm',
      value,
      source: 'measured',
      confidence: null,
      anchor: false,
      note: 'Measured from the generated solid bounding box.',
    }));
}
