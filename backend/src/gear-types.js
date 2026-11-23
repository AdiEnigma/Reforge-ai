/**
 * Canonical gear type contract shared by classification, reconstruction and export.
 *
 * `unknown` is deliberately a valid value: an image that only proves "toothed
 * component" must not be silently recorded as a spur gear.
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
  straight: "spur",
  "spur gear": "spur",
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

/** Highest-evidence-first text classification. */
export function gearTypeFromText(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return UNKNOWN_GEAR_TYPE;
  if (/worm|screw\s*flight|archimedean\s*flight/.test(value)) return "worm";
  if (/internal\s*(gear|ring)|annular\s*gear|ring\s*gear/.test(value)) return "internal";
  if (/\brack\b|linear\s*(gear|tooth)|toothed\s*rail/.test(value)) return "rack";
  if (/bevel|miter|mitre|conical|pitch\s*cone/.test(value)) return "bevel";
  if (/compound|cluster|two[- ]stage|dual[- ]stage|double\s*gear/.test(value)) return "compound";
  if (/helical|helix|angled\s*teeth|slant(ed|ing)?\s*teeth/.test(value)) return "helical";
  if (/pinion\s*shaft|gear\s*shaft|integral\s*pinion/.test(value)) return "pinion";
  if (/stepped\s*(gear|shaft)|multi[- ]stage\s*shaft/.test(value)) return "stepped";
  if (/flanged\s*(gear|shaft)/.test(value)) return "flanged";
  if (/\bspur\b|straight[- ]cut\s*teeth|straight\s*teeth/.test(value)) return "spur";
  return UNKNOWN_GEAR_TYPE;
}

/**
 * Combines explicit metadata, text and deterministic vision observations.
 * A periodic tooth count by itself is NOT evidence of a spur tooth form.
 */
export function inferGearType({ reference = {}, observations = null, text = "" } = {}) {
  const ref = reference && typeof reference === "object" ? reference : {};

  const explicit = normalizeGearType(ref.gearType);
  if (explicit !== UNKNOWN_GEAR_TYPE) return { gearType: explicit, source: "user_reference" };
  // An explicit "unknown" is a confirmed statement of uncertainty, not a
  // missing value that other weak evidence may overwrite.
  if (typeof ref.gearType === "string") {
    return { gearType: UNKNOWN_GEAR_TYPE, source: "explicit_unknown" };
  }

  const fromText = gearTypeFromText(text);
  if (fromText !== UNKNOWN_GEAR_TYPE) return { gearType: fromText, source: "text_metadata" };

  if (typeof ref.helixAngle === "number" && Math.abs(ref.helixAngle) > 0.5) {
    return { gearType: "helical", source: "helix_angle" };
  }

  const hints = Array.isArray(observations?.symmetryHints)
    ? observations.symmetryHints.map((hint) => String(hint)).join(" ")
    : "";
  const fromHints = gearTypeFromText(hints);
  if (fromHints !== UNKNOWN_GEAR_TYPE) return { gearType: fromHints, source: "vision_observation" };

  const aspectRatios = Array.isArray(observations?.aspectRatios) ? observations.aspectRatios : [];
  const maxAspect = aspectRatios.length ? Math.max(...aspectRatios) : 1;
  if (maxAspect >= 2.2) return { gearType: "pinion", source: "aspect_ratio" };

  return { gearType: UNKNOWN_GEAR_TYPE, source: "insufficient_evidence" };
}

export function gearTypeConfirmationMessage(gearType = UNKNOWN_GEAR_TYPE) {
  const normalized = normalizeGearType(gearType);
  if (normalized !== UNKNOWN_GEAR_TYPE) return null;
  return "Gear type could not be identified from the available image evidence. Confirm spur, helical, bevel, worm, rack, internal, compound, pinion, stepped or flanged before accepting the reconstruction.";
}
