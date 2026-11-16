const LINEAR_KEYS = [
  "outerDiameter",
  "innerDiameter",
  "height",
  "length",
  "thickness",
  "width",
];
const COUNT_KEYS = ["teeth"];
const ANGLE_KEYS = ["helixAngle"];
const MODULE_KEYS = ["module"];

const ISO_MODULES = [
  0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16,
  20, 25, 32, 40, 50,
];
const BEARING_BORES = [
  3, 4, 5, 6, 8, 10, 12, 15, 17, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70,
  75, 80, 85, 90, 95, 100, 105, 110, 120, 130, 140, 150, 160, 170, 180, 190,
  200,
];
const BEARING_OUTER_DIAMETERS = [
  10, 11, 12, 13, 15, 17, 19, 20, 22, 24, 26, 28, 30, 32, 35, 37, 40, 42, 47,
  52, 55, 62, 68, 72, 80, 85, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180,
  190, 200, 215, 230, 240, 260, 280, 300, 320, 340, 360,
];
const BOLT_DIAMETERS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 30, 36];

const CALIBRATION_MIN_CONFIDENCE = 0.6;

function isPositiveNumber(value) {
  return typeof value === "number" && isFinite(value) && value > 0;
}

function isNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function snapToSeries(value, series, maxRelativeDifference) {
  if (!isPositiveNumber(value)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const candidate of series) {
    const diff = Math.abs(value - candidate) / candidate;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  if (best == null || bestDiff > maxRelativeDifference) return null;
  return { value: best, difference: bestDiff };
}

function unitForKey(key) {
  if (COUNT_KEYS.includes(key)) return "count";
  if (ANGLE_KEYS.includes(key)) return "deg";
  return "mm";
}

const NOTE_PATTERNS = {
  module: /^Gear module/,
  outerDiameter: /^(Outer diameter derived|Bearing outer diameter)/,
  innerDiameter: /^(Bearing bore|Bolt hole)/,
};

function noteForKey(key, assumptions) {
  const pattern = NOTE_PATTERNS[key];
  if (!pattern || !Array.isArray(assumptions)) return null;
  return assumptions.find((note) => pattern.test(String(note))) || null;
}

function isLockedSource(source) {
  return source === "user" || source === "measured";
}

function classifyPart(analysis) {
  const type = String(analysis?.componentType || "").toLowerCase();
  const style = analysis?.geometryRecipe?.style;
  const features = Array.isArray(analysis?.features)
    ? analysis.features.map((feature) => String(feature).toLowerCase())
    : [];
  return {
    isGear: style === "gear" || type.includes("gear"),
    isBearing: type.includes("bearing"),
    hasBoltHoles: features.some((feature) => /bolt|hole|mount/.test(feature)),
  };
}

export function applyReferenceDimensions(analysis, reference) {
  if (!analysis || typeof analysis !== "object") {
    return { analysis, dimensionSources: {} };
  }
  if (!reference || typeof reference !== "object") {
    return { analysis, dimensionSources: {} };
  }

  const next = {
    ...analysis,
    dimensions: { ...(analysis.dimensions || {}) },
  };
  const dimensionSources = {};
  const previousSources =
    analysis.dimensionSources && typeof analysis.dimensionSources === "object"
      ? analysis.dimensionSources
      : {};

  for (const key of LINEAR_KEYS) {
    if (isPositiveNumber(reference[key])) {
      next.dimensions[key] = reference[key];
      dimensionSources[key] = "user";
    }
  }

  for (const key of COUNT_KEYS) {
    const value = reference[key];
    if (isPositiveNumber(value) && value >= 4 && value <= 400) {
      next[key] = Math.round(value);
      dimensionSources[key] = "user";
    }
  }

  for (const key of MODULE_KEYS) {
    if (isPositiveNumber(reference[key]) && reference[key] <= 100) {
      next[key] = reference[key];
      dimensionSources[key] = "user";
    }
  }

  for (const key of ANGLE_KEYS) {
    const value = reference[key];
    if (isNumber(value) && value >= 0 && value <= 60) {
      next[key] = value;
      dimensionSources[key] = "user";
    }
  }

  const mergedSources = { ...previousSources, ...dimensionSources };
  next.dimensionSources = mergedSources;
  if (!next.anchorDimension) {
    next.anchorDimension = Object.keys(dimensionSources)[0] || null;
  }

  return { analysis: next, dimensionSources };
}

function calibrationFromVision(visionEvidence) {
  if (!visionEvidence || !Array.isArray(visionEvidence.images)) return null;
  let best = null;
  for (const image of visionEvidence.images) {
    const calibration = image?.calibration;
    if (!calibration || calibration.status !== "calibrated") continue;
    if (!isPositiveNumber(calibration.mm_per_pixel)) continue;
    const confidence = isNumber(calibration.confidence) ? calibration.confidence : 0;
    if (confidence < CALIBRATION_MIN_CONFIDENCE) continue;
    if (!best || confidence > best.confidence) {
      best = {
        status: "calibrated",
        mmPerPixel: calibration.mm_per_pixel,
        confidence,
        source: calibration.source || null,
      };
    }
  }
  return best;
}

function getValue(analysis, key) {
  if (LINEAR_KEYS.includes(key)) return analysis.dimensions?.[key] ?? null;
  return analysis[key] ?? null;
}

function setValue(analysis, key, value, sources, confidence, note) {
  if (LINEAR_KEYS.includes(key)) {
    analysis.dimensions = { ...(analysis.dimensions || {}), [key]: value };
  } else {
    analysis[key] = value;
  }
  sources[key] = "estimated";
  confidence[key] = clamp(Number(analysis.confidence) || 0.5, 0.1, 0.9);
  if (note) analysis.assumptions.push(note);
  return note || null;
}

function syncRecipeGear(analysis) {
  const recipe = analysis.geometryRecipe;
  if (!recipe || recipe.style !== "gear" || !recipe.gear) return;
  if (isPositiveNumber(analysis.module)) recipe.gear.module = analysis.module;
  if (isPositiveNumber(analysis.dimensions?.innerDiameter)) {
    recipe.gear.boreRadius = analysis.dimensions.innerDiameter / 2;
  }
  if (isPositiveNumber(analysis.teeth)) recipe.gear.teeth = Math.round(analysis.teeth);
  if (isPositiveNumber(analysis.helixAngle)) recipe.gear.helixAngle = analysis.helixAngle;
  if (isPositiveNumber(analysis.dimensions?.height) && !recipe.gear.faceWidth) {
    recipe.gear.faceWidth = analysis.dimensions.height;
  }
  if (!recipe.gear.faceWidth) {
    recipe.gear.faceWidth = isPositiveNumber(analysis.dimensions?.thickness)
      ? analysis.dimensions.thickness
      : 15;
  }
  if (!recipe.gear.module && isPositiveNumber(recipe.gear.teeth) && isPositiveNumber(analysis.dimensions?.outerDiameter)) {
    recipe.gear.module = Number((analysis.dimensions.outerDiameter / (recipe.gear.teeth + 2)).toFixed(3));
  }
}

function applyStandardSnapping(analysis, sources, confidence) {
  const part = classifyPart(analysis);

  if (part.isGear) {
    // If module is missing but OD and teeth are present, infer module: OD = (teeth + 2) * module
    if (
      !isLockedSource(sources.module) &&
      !isPositiveNumber(analysis.module) &&
      isPositiveNumber(analysis.teeth) &&
      isPositiveNumber(getValue(analysis, "outerDiameter"))
    ) {
      const rawModule = getValue(analysis, "outerDiameter") / (Math.round(analysis.teeth) + 2);
      const snapped = snapToSeries(rawModule, ISO_MODULES, 0.25) || { value: Number(rawModule.toFixed(3)) };
      setValue(
        analysis,
        "module",
        snapped.value,
        sources,
        confidence,
        `Gear module inferred from outer diameter ${getValue(analysis, "outerDiameter")} mm / (${Math.round(analysis.teeth)} + 2) teeth = ${snapped.value} mm.`
      );
    }

    if (!isLockedSource(sources.module) && isPositiveNumber(analysis.module)) {
      const snapped = snapToSeries(analysis.module, ISO_MODULES, 0.12);
      if (snapped && Math.abs(snapped.value - analysis.module) > 1e-9) {
        setValue(
          analysis,
          "module",
          snapped.value,
          sources,
          confidence,
          `Gear module ${analysis.module} mm snapped to ISO standard ${snapped.value} mm.`
        );
      }
    }

    if (
      !isLockedSource(sources.outerDiameter) &&
      isPositiveNumber(analysis.module) &&
      isPositiveNumber(analysis.teeth)
    ) {
      const derived = analysis.module * (Math.round(analysis.teeth) + 2);
      const current = getValue(analysis, "outerDiameter");
      if (!isPositiveNumber(current) || Math.abs(current - derived) / derived <= 0.25) {
        if (!isPositiveNumber(current) || Math.abs(current - derived) > 1e-9) {
          setValue(
            analysis,
            "outerDiameter",
            Number(derived.toFixed(3)),
            sources,
            confidence,
            `Outer diameter derived from module ${analysis.module} mm x ${Math.round(analysis.teeth) + 2} teeth = ${derived.toFixed(2)} mm.`
          );
        }
      }
    }
  }

  if (part.isBearing) {
    if (!isLockedSource(sources.innerDiameter)) {
      const current = getValue(analysis, "innerDiameter");
      const snapped = snapToSeries(current, BEARING_BORES, 0.06);
      if (snapped && Math.abs(snapped.value - current) > 1e-9) {
        setValue(
          analysis,
          "innerDiameter",
          snapped.value,
          sources,
          confidence,
          `Bearing bore ${current} mm snapped to standard ${snapped.value} mm.`
        );
      }
    }
    if (!isLockedSource(sources.outerDiameter)) {
      const current = getValue(analysis, "outerDiameter");
      const snapped = snapToSeries(current, BEARING_OUTER_DIAMETERS, 0.06);
      if (snapped && Math.abs(snapped.value - current) > 1e-9) {
        setValue(
          analysis,
          "outerDiameter",
          snapped.value,
          sources,
          confidence,
          `Bearing outer diameter ${current} mm snapped to standard ${snapped.value} mm.`
        );
      }
    }
  }

  if (part.hasBoltHoles && !part.isGear && !part.isBearing && !isLockedSource(sources.innerDiameter)) {
    const current = getValue(analysis, "innerDiameter");
    if (isPositiveNumber(current) && current <= 24) {
      const snapped = snapToSeries(current, BOLT_DIAMETERS, 0.1);
      if (snapped && Math.abs(snapped.value - current) > 1e-9) {
        setValue(
          analysis,
          "innerDiameter",
          snapped.value,
          sources,
          confidence,
          `Bolt hole ${current} mm snapped to standard M${snapped.value}.`
        );
      }
    }
  }
}

export function deriveAssumptions(analysis, { reference, visionEvidence } = {}) {
  if (!analysis || typeof analysis !== "object") {
    return {
      analysis,
      hasEstimates: false,
      anchorDimension: null,
      anchorSource: null,
      scale: null,
    };
  }

  const { analysis: withReference } = applyReferenceDimensions(analysis, reference);
  const next = {
    ...withReference,
    dimensions: { ...(withReference.dimensions || {}) },
    assumptions: Array.isArray(withReference.assumptions)
      ? [...withReference.assumptions]
      : [],
  };

  const sources = { ...(withReference.dimensionSources || {}) };
  const confidence = { ...(withReference.dimensionConfidence || {}) };
  const allKeys = [
    ...LINEAR_KEYS,
    ...COUNT_KEYS,
    ...MODULE_KEYS,
    ...ANGLE_KEYS,
  ];

  for (const key of allKeys) {
    const value = getValue(next, key);
    if (value == null) {
      delete sources[key];
      delete confidence[key];
      continue;
    }
    if (!sources[key]) sources[key] = "estimated";
    if (!isNumber(confidence[key])) {
      confidence[key] =
        sources[key] === "user"
          ? 1
          : sources[key] === "measured"
            ? 0.9
            : clamp(Number(next.confidence) || 0.5, 0.1, 0.9);
    }
  }

  applyStandardSnapping(next, sources, confidence);
  syncRecipeGear(next);

  const scale = calibrationFromVision(visionEvidence);
  const anchorKey =
    allKeys.find((key) => sources[key] === "user" && getValue(next, key) != null) ||
    allKeys.find((key) => sources[key] === "measured" && getValue(next, key) != null) ||
    null;

  const dimensionsDetail = allKeys
    .filter((key) => getValue(next, key) != null)
    .map((key) => ({
      key,
      value: getValue(next, key),
      unit: unitForKey(key),
      source: sources[key] || "estimated",
      confidence: confidence[key],
      anchor: key === anchorKey,
      note: noteForKey(key, next.assumptions),
    }));

  const hasEstimates = dimensionsDetail.some((dimension) => dimension.source === "estimated");
  const overallConfidence = dimensionsDetail.length
    ? clamp(
        dimensionsDetail.reduce(
          (total, dimension) => total + (isNumber(dimension.confidence) ? dimension.confidence : 0.5),
          0
        ) / dimensionsDetail.length,
        0,
        1
      )
    : 0;

  next.dimensionSources = sources;
  next.dimensionConfidence = confidence;
  next.dimensionsDetail = dimensionsDetail;
  next.hasEstimates = hasEstimates;
  next.overallConfidence = overallConfidence;
  next.anchorDimension = anchorKey;
  next.anchorSource = anchorKey ? sources[anchorKey] : null;
  next.scale = scale;

  return {
    analysis: next,
    hasEstimates,
    overallConfidence,
    anchorDimension: anchorKey,
    anchorSource: next.anchorSource,
    scale,
  };
}

export function buildCadDimensions(analysis) {
  if (Array.isArray(analysis?.dimensionsDetail)) return analysis.dimensionsDetail;
  const sources = analysis?.dimensionSources || {};
  const detail = [];
  for (const key of [...LINEAR_KEYS, ...COUNT_KEYS, ...MODULE_KEYS, ...ANGLE_KEYS]) {
    const value = getValue(analysis || {}, key);
    if (value == null) continue;
    detail.push({
      key,
      value,
      unit: unitForKey(key),
      source: sources[key] || "estimated",
      confidence: analysis?.dimensionConfidence?.[key] ?? null,
      anchor: key === analysis?.anchorDimension,
      note: null,
    });
  }
  return detail;
}

export function deriveUserDimensions(analysis) {
  const userDimensions = {};
  for (const dimension of buildCadDimensions(analysis)) {
    if (dimension.source !== "user" && dimension.source !== "measured") continue;
    if (!isNumber(dimension.value)) continue;
    userDimensions[dimension.key] = dimension.value;
  }
  return userDimensions;
}

export function hasAnchorDimension(dimensionSources) {
  if (Array.isArray(dimensionSources)) {
    return dimensionSources.some(
      (dimension) =>
        dimension && (dimension.source === "user" || dimension.source === "measured")
    );
  }
  if (!dimensionSources || typeof dimensionSources !== "object") return false;
  return Object.values(dimensionSources).some(
    (source) => source === "user" || source === "measured"
  );
}
