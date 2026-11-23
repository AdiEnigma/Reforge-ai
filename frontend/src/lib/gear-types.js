/**
 * Canonical gear type handling for the workbench.
 *
 * The backend owns classification, but the viewer and exporters must agree on
 * the same value and on what "unknown" means. Unknown is never rendered as a
 * silent spur gear.
 */

export const GEAR_TYPES = Object.freeze([
  "spur",
  "helical",
  "bevel",
  "worm",
  "rack",
  "internal",
  "compound",
  "pinion",
  "stepped",
  "flanged",
  "unknown",
]);

export const UNKNOWN_GEAR_TYPE = "unknown";

const ALIASES = Object.freeze({
  spur: "spur",
  "spur gear": "spur",
  straight: "spur",
  helical: "helical",
  "helical gear": "helical",
  "helical pinion": "helical",
  "helical pinion shaft": "helical",
  bevel: "bevel",
  "bevel gear": "bevel",
  miter: "bevel",
  "miter gear": "bevel",
  mitre: "bevel",
  "mitre gear": "bevel",
  conical: "bevel",
  "conical gear": "bevel",
  worm: "worm",
  "worm gear": "worm",
  "worm spindle": "worm",
  "worm drive": "worm",
  "worm drive shaft": "worm",
  "precision worm drive shaft": "worm",
  rack: "rack",
  "rack gear": "rack",
  "linear gear": "rack",
  internal: "internal",
  "internal gear": "internal",
  "internal ring gear": "internal",
  annular: "internal",
  compound: "compound",
  "compound gear": "compound",
  cluster: "compound",
  "cluster gear": "compound",
  "two-stage gear": "compound",
  "two stage gear": "compound",
  pinion: "pinion",
  "pinion shaft": "pinion",
  "gear shaft": "pinion",
  stepped: "stepped",
  "stepped gear": "stepped",
  flanged: "flanged",
  "flanged gear": "flanged",
  "flanged shaft": "flanged",
  unknown: "unknown",
  unspecified: "unknown",
  uncertain: "unknown",
  other: "unknown",
});

export function normalizeGearType(value) {
  if (typeof value !== "string") return UNKNOWN_GEAR_TYPE;
  const key = value.trim().toLowerCase().replace(/[\s_/]+/g, " ");
  return ALIASES[key] || (GEAR_TYPES.includes(key) ? key : UNKNOWN_GEAR_TYPE);
}

export function resolvedGearType(analysis) {
  const explicit = normalizeGearType(
    analysis?.gearType || analysis?.geometryRecipe?.gear?.gearType || ""
  );
  if (explicit !== UNKNOWN_GEAR_TYPE) return explicit;
  return UNKNOWN_GEAR_TYPE;
}

export function isGearTypeUnconfirmed(analysis) {
  return Boolean(analysis?.requiresGearTypeConfirmation) || resolvedGearType(analysis) === UNKNOWN_GEAR_TYPE;
}

export function gearTypeConfirmationMessage(gearType = UNKNOWN_GEAR_TYPE) {
  if (normalizeGearType(gearType) !== UNKNOWN_GEAR_TYPE) return null;
  return "Gear type could not be identified from the available image evidence. Confirm spur, helical, bevel, worm, rack, internal, compound, pinion, stepped or flanged before accepting the reconstruction.";
}

const LABELS = {
  spur: "spur gear",
  helical: "helical gear",
  bevel: "bevel gear",
  worm: "worm gear",
  rack: "rack gear",
  internal: "internal gear",
  compound: "compound gear",
  pinion: "pinion shaft",
  stepped: "stepped gear",
  flanged: "flanged gear",
};

/**
 * Applies a user-confirmed gear type to the analysis object that is the single
 * source of truth for 3D, drawings, CAD, FEA, health and manufacturing.
 */
export function applyConfirmedGearType(analysis, rawGearType) {
  const gearType = normalizeGearType(rawGearType);
  if (gearType === UNKNOWN_GEAR_TYPE || !analysis || typeof analysis !== "object") return analysis || null;

  const next = {
    ...analysis,
    dimensions: { ...(analysis.dimensions || {}) },
    gearType,
    componentType: LABELS[gearType],
    classificationSource: "user_confirmed",
    requiresGearTypeConfirmation: false,
    uncertainties: (analysis.uncertainties || []).filter(
      (item) => !/gear (type|subtype)/i.test(String(item))
    ),
  };
  // Health evidence was scored against the old tooth form; force a re-fetch.
  delete next.conditionAssessment;

  const recipe = analysis.geometryRecipe && typeof analysis.geometryRecipe === "object"
    ? { ...analysis.geometryRecipe, gear: { ...(analysis.geometryRecipe.gear || {}) } }
    : { style: "gear", gear: {} };
  const dims = next.dimensions;
  const od = typeof dims.outerDiameter === "number" ? dims.outerDiameter : 100;
  const id = typeof dims.innerDiameter === "number" ? dims.innerDiameter : od * 0.28;
  const faceWidth = typeof dims.thickness === "number" && dims.thickness > 0
    ? dims.thickness
    : typeof dims.height === "number" && dims.height > 0 ? dims.height : od * 0.25;

  recipe.gear.gearType = gearType;
  recipe.gear.boreRadius = recipe.gear.boreRadius ?? id / 2;
  recipe.gear.faceWidth = recipe.gear.faceWidth ?? faceWidth;
  recipe.gear.outerDiameter = recipe.gear.outerDiameter ?? od;

  if (gearType === "helical") {
    next.helixAngle = Math.abs(Number(next.helixAngle) || 0) > 0.5 ? next.helixAngle : 20;
    recipe.gear.helixAngle = next.helixAngle;
  }
  if (gearType === "bevel") {
    next.coneAngle = Number(next.coneAngle) > 0 ? next.coneAngle : 45;
    recipe.gear.coneAngle = next.coneAngle;
  }
  if (gearType === "worm") {
    const pitch = Math.max(1, Number(next.pitch) || Math.round(od * 0.12));
    const starts = Math.max(1, Math.round(Number(next.starts) || 1));
    next.pitch = pitch;
    next.starts = starts;
    next.lead = pitch * starts;
    recipe.style = "gear";
    recipe.gear.pitch = pitch;
    recipe.gear.starts = starts;
    recipe.gear.rootRadius = recipe.gear.rootRadius ?? od * 0.32;
  }
  if (gearType === "rack") {
    const teeth = Math.max(6, Math.round(Number(next.teeth) || 20));
    const module = Math.max(0.5, Number(next.module) || od / (teeth + 2));
    next.teeth = teeth;
    next.module = module;
    recipe.style = "gear";
    recipe.gear.teeth = teeth;
    recipe.gear.module = module;
    recipe.gear.rackLength = teeth * Math.PI * module;
  }
  if (gearType === "internal") {
    const teeth = Math.max(12, Math.round(Number(next.teeth) || 36));
    next.teeth = teeth;
    recipe.style = "gear";
    recipe.gear.teeth = teeth;
    recipe.gear.innerRing = true;
  }

  next.geometryRecipe = recipe;
  next.features = Array.isArray(next.features)
    ? [...new Set([`Confirmed gear type: ${gearType}`, ...next.features])]
    : [`Confirmed gear type: ${gearType}`];
  return next;
}
