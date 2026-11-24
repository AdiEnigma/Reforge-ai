/**
 * condition-assessment.js
 *
 * Image-based visual condition assessment for mechanical components.
 *
 * The language model only reports defects that are DIRECTLY VISIBLE in the
 * supplied photographs. All scoring, classification, defect tags and
 * verification guidance are derived deterministically here so the same photo
 * always produces the same assessment and no result is special-cased.
 */
import {
  createGeminiClient,
  createGeminiModel,
  getCandidateModels,
  stripFences,
} from "./gemini.js";
import { normalizeGearType } from "./src/gear-types.js";

const DEFECT_TYPES = [
  "corrosion",
  "rust",
  "surface_pitting",
  "tooth_wear",
  "chipping",
  "crack",
  "deformation",
  "scoring",
  "discoloration",
  "surface_roughness",
  "contamination",
];

const SEVERITIES = ["none", "minor", "moderate", "severe"];
const EXTENTS = ["localized", "widespread"];
const IMAGE_QUALITIES = ["adequate", "limited", "insufficient"];

const SEVERITY_RANK = { none: 0, minor: 1, moderate: 2, severe: 3 };
const SEVERITY_PENALTY = { none: 0, minor: 8, moderate: 22, severe: 45 };
const EXTENT_FACTOR = { localized: 0.6, widespread: 1 };

// Heatmap regions are emitted only for defects localised in a supplied image.
// They are deliberately bounded so a model error cannot flood the UI.
const MAX_DAMAGE_REGIONS = 24;
const MIN_REGION_CONFIDENCE = 0.5;
const MIN_REGION_SIZE = 0.01;
const DEFAULT_IMAGE_COUNT = 1;

const HEAT_LEVELS = {
  low: "low",
  moderate: "moderate",
  high: "high",
  severe: "severe",
};

// A pixel mask with fewer pixels than this is not enough evidence to reduce a
// health score. It must match the detector's MIN_DAMAGE_PIXELS floor.
const MIN_PIXEL_EVIDENCE = 12;

const DEFECT_LABELS = {
  corrosion: "Corrosion",
  rust: "Surface rust",
  surface_pitting: "Surface pitting",
  tooth_wear: "Tooth wear",
  chipping: "Chipping",
  crack: "Visible crack",
  deformation: "Deformation",
  scoring: "Scoring / abrasion",
  discoloration: "Discoloration",
  surface_roughness: "Surface deterioration",
  contamination: "Surface contamination",
};

const GEAR_VERIFICATION = {
  spur: "Measure tooth thickness and backlash against a known spur mating gear.",
  helical: "Inspect helix-direction contact pattern and measure lead and backlash against the mating helical gear.",
  bevel: "Check contact pattern on the pitch cone and verify mounting distance and backlash with the mating bevel gear.",
  worm: "Inspect the worm flight for polishing or scoring and verify axial backlash with the mating wheel.",
  rack: "Check straightness and measure tooth thickness at several positions along the rack.",
  internal: "Inspect internal flanks from multiple angles and measure tooth thickness with internal-gauge equipment.",
  compound: "Inspect each coaxial gear stage separately; compare wear between stages for alignment problems.",
  pinion: "Check the integral pinion teeth and adjacent journals together for concentricity and contact offset.",
  stepped: "Inspect each diameter stage separately for tooth wear and shoulder deformation.",
  flanged: "Check the gear teeth and the flange face together for alignment and fastener distortion.",
  unknown: "Confirm the gear type before applying tooth-form-specific wear limits.",
};

const VERIFICATION_BY_TYPE = {
  corrosion: [
    "Clean a representative area and measure remaining sound metal and tooth thickness.",
  ],
  rust: [
    "Remove loose oxide from a small area and inspect the underlying surface for pitting.",
  ],
  surface_pitting: [
    "Measure pit depth and check whether pitting is active before returning to service.",
  ],
  tooth_wear: [
    "Measure tooth thickness and backlash against the mating component.",
  ],
  chipping: [
    "Magnified inspection of affected tooth edges; reject if edge integrity is lost.",
  ],
  crack: [
    "Dye-penetrant or MPI inspection of the visible indication before any service.",
  ],
  deformation: [
    "Check runout and roundness on a surface plate or between centres.",
  ],
  scoring: [
    "Inspect lubrication and contact alignment for the cause of the scoring.",
  ],
  discoloration: [
    "Confirm whether discoloration is contamination or heat-related with a hardness check.",
  ],
  surface_roughness: [
    "Profile the surface finish and look for pitting initiation sites.",
  ],
  contamination: [
    "Clean the surface and re-inspect the underlying material.",
  ],
};

const CONDITION_SCHEMA = {
  type: "OBJECT",
  properties: {
    imageQuality: { type: "STRING", enum: IMAGE_QUALITIES },
    observations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: DEFECT_TYPES },
          severity: { type: "STRING", enum: SEVERITIES },
          extent: { type: "STRING", enum: EXTENTS },
          location: { type: "STRING" },
          evidence: { type: "STRING" },
          confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
          regions: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                imageIndex: { type: "NUMBER", minimum: 0, maximum: 15 },
                x: { type: "NUMBER", minimum: 0, maximum: 1 },
                y: { type: "NUMBER", minimum: 0, maximum: 1 },
                width: { type: "NUMBER", minimum: 0, maximum: 1 },
                height: { type: "NUMBER", minimum: 0, maximum: 1 },
                confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
              },
              required: ["imageIndex", "x", "y", "width", "height", "confidence"],
            },
          },
        },
        required: ["type", "severity", "extent", "evidence", "confidence"],
      },
    },
    suspectedInternal: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          concern: { type: "STRING" },
          reason: { type: "STRING" },
        },
        required: ["concern", "reason"],
      },
    },
    summary: { type: "STRING" },
  },
  required: ["imageQuality", "observations", "suspectedInternal", "summary"],
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cleanText(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanConfidence(value) {
  return typeof value === "number" && isFinite(value)
    ? clamp(value, 0, 1)
    : 0.7;
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function cleanNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Four display levels derived from the observed severity and extent. This is
 * the only place the green/yellow/orange/red scale is decided.
 */
export function heatLevel(severity, extent) {
  if (severity === "minor") return HEAT_LEVELS.low;
  if (severity === "moderate") return HEAT_LEVELS.moderate;
  if (severity === "severe") {
    return extent === "widespread" ? HEAT_LEVELS.severe : HEAT_LEVELS.high;
  }
  return HEAT_LEVELS.low;
}

function normalizeRegions(raw, observation, imageCount) {
  if (!Array.isArray(raw)) return [];
  const maxIndex = Math.max(0, (imageCount || DEFAULT_IMAGE_COUNT) - 1);
  const clean = [];

  for (const region of raw) {
    if (!region || typeof region !== "object") continue;
    const rawIndex = cleanNumber(region.imageIndex);
    const rawX = cleanNumber(region.x);
    const rawY = cleanNumber(region.y);
    const rawWidth = cleanNumber(region.width);
    const rawHeight = cleanNumber(region.height);
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
    if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) continue;

    const confidence = cleanConfidence(region.confidence);
    if (confidence < MIN_REGION_CONFIDENCE) continue;

    clean.push({
      imageIndex,
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height),
      type: observation.type,
      severity: observation.severity,
      extent: observation.extent,
      level: heatLevel(observation.severity, observation.extent),
      label: DEFECT_LABELS[observation.type] || observation.type,
      confidence: round(confidence, 2),
    });
  }
  return clean;
}

function buildDamageRegions(observations) {
  const seen = new Set();
  const regions = [];
  for (const observation of observations) {
    for (const region of observation.regions || []) {
      const key = [
        region.imageIndex,
        region.x,
        region.y,
        region.width,
        region.height,
        region.type,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      regions.push(region);
    }
  }
  return regions.slice(0, MAX_DAMAGE_REGIONS);
}

function normalizeObservations(raw, imageCount = DEFAULT_IMAGE_COUNT) {
  if (!Array.isArray(raw)) return [];
  const clean = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (!DEFECT_TYPES.includes(item.type)) continue;
    if (!SEVERITIES.includes(item.severity) || item.severity === "none") continue;

    const observation = {
      type: item.type,
      severity: item.severity,
      extent: EXTENTS.includes(item.extent) ? item.extent : "localized",
      location: cleanText(item.location, 80),
      evidence: cleanText(item.evidence, 240),
      confidence: cleanConfidence(item.confidence),
    };
    observation.regions = normalizeRegions(item.regions, observation, imageCount);
    clean.push(observation);
  }
  return clean;
}

function aggregateObservations(observations) {
  const byType = new Map();
  for (const observation of observations) {
    const existing = byType.get(observation.type);
    if (!existing) {
      byType.set(observation.type, { ...observation });
      continue;
    }
    if (SEVERITY_RANK[observation.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = observation.severity;
    }
    if (observation.extent === "widespread") existing.extent = "widespread";
    existing.confidence = Math.max(existing.confidence, observation.confidence);
    if (observation.location && !existing.location.includes(observation.location)) {
      existing.location = [existing.location, observation.location].filter(Boolean).join("; ");
    }
    if (observation.evidence && !existing.evidence.includes(observation.evidence)) {
      existing.evidence = [existing.evidence, observation.evidence].filter(Boolean).join(" ");
    }
    existing.regions = [...(existing.regions || []), ...(observation.regions || [])];
  }
  return [...byType.values()];
}

function normalizeSuspectedInternal(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const concern = cleanText(item.concern, 100);
    const reason = cleanText(item.reason, 200);
    if (!concern) continue;
    clean.push(
      `Unconfirmed — ${concern}${reason ? `: ${reason}` : ""}. Not established from photographs.`
    );
  }
  return clean.slice(0, 5);
}

function buildVerification(observations, suspectedInternal, imageQuality, gearType = null) {
  const recommendations = new Set();
  for (const observation of observations) {
    for (const recommendation of VERIFICATION_BY_TYPE[observation.type] || []) {
      recommendations.add(recommendation);
    }
  }
  const normalizedGearType = normalizeGearType(gearType);
  if (normalizedGearType !== "unknown" && observations.some((o) => ["tooth_wear", "chipping", "deformation", "scoring"].includes(o.type))) {
    recommendations.add(GEAR_VERIFICATION[normalizedGearType]);
  }
  if (normalizedGearType === "unknown" && observations.some((o) => ["tooth_wear", "chipping", "deformation", "scoring"].includes(o.type))) {
    recommendations.add(GEAR_VERIFICATION.unknown);
  }
  if (imageQuality === "limited") {
    recommendations.add(
      "Obtain additional well-lit, focused views before relying on this assessment."
    );
  }
  if (suspectedInternal.length > 0) {
    recommendations.add(
      "Verify unconfirmed internal concerns with NDT; photographs cannot establish subsurface condition."
    );
  }
  recommendations.add(
    "Correlate photograph findings with physical inspection before returning the component to service."
  );
  return [...recommendations].slice(0, 6);
}

/**
 * Turns raw model observations into the assessment consumed by the UI.
 * Exported so it can be unit-tested without a network call.
 */
export function deriveConditionAssessment(raw, context = {}) {
  const source = "visual-photograph";
  const imageQuality = IMAGE_QUALITIES.includes(raw?.imageQuality)
    ? raw.imageQuality
    : "insufficient";

  if (imageQuality === "insufficient") {
    return {
      status: "NEEDS INSPECTION",
      imageQuality,
      healthScore: null,
      wearEvidenceCount: 0,
      observedDefects: [],
      observedDefectTypes: [],
      damageRegions: [],
      suspectedInternal: normalizeSuspectedInternal(raw?.suspectedInternal),
      assessedGearType: context.gearType ? normalizeGearType(context.gearType) : null,
      summary:
        cleanText(raw?.summary, 400) ||
        "Image quality or visible evidence is insufficient for a reliable visual assessment.",
      recommendedVerification: [
        "Obtain clear, well-lit photographs of the whole component and re-run the assessment.",
      ],
      critical: false,
      source,
    };
  }

  const observations = aggregateObservations(
    normalizeObservations(raw?.observations, context.imageCount)
  );
  const damageRegions = buildDamageRegions(observations);
  const suspectedInternal = normalizeSuspectedInternal(raw?.suspectedInternal);

  let penalty = 0;
  for (const observation of observations) {
    penalty +=
      SEVERITY_PENALTY[observation.severity] *
      EXTENT_FACTOR[observation.extent] *
      (0.5 + 0.5 * observation.confidence);
  }
  const rawScore = clamp(Math.round(100 - penalty), 0, 100);
  const hasObservedCrack = observations.some(
    (observation) => observation.type === "crack"
  );

  const observedDefects = observations.map((observation) => {
    const parts = [
      capitalize(observation.severity),
      DEFECT_LABELS[observation.type] || observation.type,
    ];
    if (observation.extent === "widespread") parts.push("widespread");
    if (observation.location) parts.push(`on ${observation.location}`);
    return parts.join(" ");
  });

  let status;
  let healthScore = rawScore;
  if (observations.length === 0) {
    status =
      suspectedInternal.length > 0 || imageQuality === "limited"
        ? "NEEDS INSPECTION"
        : "NORMAL";
    if (status === "NEEDS INSPECTION") healthScore = null;
  } else if (hasObservedCrack || rawScore < 70) {
    status = "ACTION REQUIRED";
  } else {
    status = "ATTENTION ADVISED";
  }

  const defaultSummary = observations.length
    ? `Visible ${observations.map((o) => DEFECT_LABELS[o.type].toLowerCase()).join(", ")} observed in the supplied photographs.`
    : "No visible surface damage was identified in the supplied photographs.";

  const assessedGearType = context.gearType
    ? normalizeGearType(context.gearType)
    : null;

  return {
    status,
    imageQuality,
    healthScore,
    wearEvidenceCount: observations.length,
    observedDefects,
    observedDefectTypes: observations.map((observation) => observation.type),
    damageRegions,
    suspectedInternal,
    assessedGearType,
    summary: cleanText(raw?.summary, 400) || defaultSummary,
    recommendedVerification: buildVerification(
      observations,
      suspectedInternal,
      imageQuality,
      assessedGearType
    ),
    critical:
      hasObservedCrack ||
      (healthScore != null &&
        (healthScore < 40 ||
          observations.some(
            (observation) =>
              observation.severity === "severe" && observation.extent === "widespread"
          ))),
    source,
  };
}

/**
 * Replaces broad model-reported severity/extent with evidence measured from
 * the pixel-level damage mask. A single wide Gemini box can never by itself
 * label the whole component as moderately damaged: coverage of the isolated
 * component silhouette decides severity, extent and score.
 */
export function applyPixelEvidence(assessment, maskStats) {
  const base = assessment || unknownConditionAssessment();
  const stats = maskStats && typeof maskStats === "object" ? maskStats : {};
  const maskedPixels =
    typeof stats.maskedPixels === "number" && isFinite(stats.maskedPixels)
      ? Math.max(0, Math.round(stats.maskedPixels))
      : 0;
  const hasPixelEvidence = maskedPixels >= MIN_PIXEL_EVIDENCE;
  const reportedDefects = Array.isArray(base.observedDefects) ? base.observedDefects : [];

  if (!hasPixelEvidence) {
    if (reportedDefects.length === 0 || base.status === "NEEDS INSPECTION") return base;
    return {
      ...base,
      status: "NEEDS INSPECTION",
      healthScore: null,
      critical: false,
      summary:
        "Defects were reported but pixel-level segmentation did not confirm visible damage in the supplied image.",
      pixelEvidence: {
        confirmed: false,
        maskedPixels,
        severity: null,
        extent: "localized",
        damageRatioOfComponent: 0,
      },
    };
  }

  const severity = SEVERITIES.includes(stats.severity) && stats.severity !== "none"
    ? stats.severity
    : "minor";
  const extent = EXTENTS.includes(stats.extent) ? stats.extent : "localized";
  const ratio =
    typeof stats.damageRatioOfComponent === "number" && isFinite(stats.damageRatioOfComponent)
      ? clamp(stats.damageRatioOfComponent, 0, 1)
      : 0;
  const confidence =
    typeof stats.confidence === "number" && isFinite(stats.confidence)
      ? clamp(stats.confidence, 0, 1)
      : 0.7;

  const typesFromMask = Array.isArray(stats.types)
    ? stats.types.filter((type) => DEFECT_TYPES.includes(type))
    : [];
  const types = typesFromMask.length > 0
    ? [...new Set(typesFromMask)]
    : (Array.isArray(base.observedDefectTypes) ? base.observedDefectTypes : []).filter((type) => DEFECT_TYPES.includes(type));
  const effectiveTypes = types.length > 0 ? types : ["surface_roughness"];

  const penalty = SEVERITY_PENALTY[severity] * EXTENT_FACTOR[extent] * (0.5 + 0.5 * confidence);
  const healthScore = clamp(Math.round(100 - penalty), 0, 100);
  const hasPixelCrack = effectiveTypes.includes("crack");
  const status = hasPixelCrack || healthScore < 70 ? "ACTION REQUIRED" : "ATTENTION ADVISED";
  const observedDefects = effectiveTypes.map((type) => {
    const label = DEFECT_LABELS[type] || type;
    return `${capitalize(severity)} ${label}${extent === "widespread" ? " widespread" : ""}`;
  });
  const typeLabel = effectiveTypes.map((type) => (DEFECT_LABELS[type] || type).toLowerCase()).join(", ");
  const verification = buildVerification(
    effectiveTypes.map((type) => ({ type })),
    [],
    "adequate"
  );

  return {
    ...base,
    // A confirmed local mask means the photograph was usable for damage
    // detection even when the visual model call itself was unavailable.
    imageQuality: base.imageQuality === "insufficient" ? "limited" : base.imageQuality,
    status,
    healthScore,
    wearEvidenceCount: effectiveTypes.length,
    observedDefects,
    observedDefectTypes: effectiveTypes,
    summary: `Pixel-level segmentation found ${typeLabel} covering ${(ratio * 100).toFixed(1)}% of the component surface. Unmarked areas remain transparent.`,
    recommendedVerification: verification,
    critical:
      hasPixelCrack ||
      healthScore < 40 ||
      (severity === "severe" && extent === "widespread"),
    severity,
    extent,
    pixelEvidence: {
      confirmed: true,
      maskedPixels,
      severity,
      extent,
      damageRatioOfComponent: round(ratio, 5),
      connectedRegions:
        typeof stats.connectedRegions === "number" && isFinite(stats.connectedRegions)
          ? Math.round(stats.connectedRegions)
          : 0,
    },
  };
}

export function unknownConditionAssessment(reason = "") {
  return {
    status: "NEEDS INSPECTION",
    imageQuality: "insufficient",
    healthScore: null,
    wearEvidenceCount: 0,
    observedDefects: [],
    observedDefectTypes: [],
    damageRegions: [],
    suspectedInternal: [],
    summary:
      cleanText(reason, 400) || "Visual condition could not be assessed from the supplied images.",
    recommendedVerification: [
      "Manual visual inspection required; automated image assessment was unavailable.",
    ],
    critical: false,
    source: "visual-photograph",
  };
}

export function conditionPrompt(analysis) {
  const lines = [
    "You are a mechanical visual condition inspector. Inspect the supplied photographs ONLY for visible surface condition.",
    "Do not assess geometry, dimensions, material grade, manufacturing process, or remaining life.",
    "Return a single JSON object matching the schema. Rules:",
    "- Report only defects that are directly visible in the photographs. Do not infer fatigue, internal cracking, heat damage, or mechanical failure.",
    '- Use "corrosion" or "rust" for visible orange/brown/red oxide, flaking scale, or oxidation. "surface_pitting" means small craters or depressions in the surface.',
    '- "tooth_wear" means rounded, polished, shortened, uneven, or step-worn tooth flanks/tips. "chipping" means a missing fragment at an edge. "deformation" means a bent, warped, or out-of-round silhouette.',
    '- "crack" means a clearly visible linear fracture with separation or defined edges. If a crack is merely suspected, do NOT put it in observations; put it in suspectedInternal instead.',
    '- "surface_roughness" covers visible surface deterioration such as flaking, pitting-prone texture, or heavy scoring.',
    '- severity: minor = slight or early; moderate = clearly present but limited; severe = extensive, deep, or likely to affect function.',
    '- extent: localized = one small area; widespread = across multiple surfaces or most of the component.',
    '- confidence: how certain you are that the observation is directly visible in the photographs.',
    '- For every visible defect, include a "regions" array with one tightly fitted bounding box per affected area. Image coordinates are normalized: 0 = left/top edge, 1 = right/bottom edge of that photograph. "imageIndex" is the zero-based index of the photograph, "x"/"y" are the top-left corner, and "width"/"height" are the box size.',
    '- Only add a region when that exact area is directly visible. If a defect cannot be localised, return an empty "regions" array for it. Never invent boxes and never cover the whole image unless damage is genuinely widespread across it.',
    '- Do not return any regions when imageQuality is "insufficient".',
    '- If no damage is visible, return observations: [] and say so in summary.',
    '- If images are blurry, dark, heavily occluded, or show too little of the component to judge condition, set imageQuality to "insufficient" and return no observations.',
    '- If only part of the condition is visible, set imageQuality to "limited" and report only what you can see.',
    "- Put anything that cannot be confirmed visually into suspectedInternal with careful, non-definitive wording.",
  ];
  if (analysis?.componentType) {
    lines.push(
      `The part has been classified as "${analysis.componentType}". Use this only for location vocabulary; it is not evidence of damage.`
    );
  }
  const gearType = normalizeGearType(analysis?.gearType);
  if (gearType !== "unknown") {
    const featureWarnings = {
      spur: "Describe damage on straight parallel tooth flanks and tips only where they are visible.",
      helical: "Describe damage on angled tooth flanks; inspect both ends of the helix when visible.",
      bevel: "Describe damage relative to the conical pitch surface and toe/heel of the teeth.",
      worm: "Describe damage on the continuous worm flight and root, not on spur-like teeth.",
      rack: "Describe damage along a linear run of teeth; do not assume a circular gear.",
      internal: "Describe damage on inward-facing internal teeth of a ring.",
      compound: "Describe which coaxial gear stage shows damage when the views allow it.",
      pinion: "Describe damage on the integral gear teeth and adjacent shaft journals separately.",
      stepped: "Describe damage per stepped gear diameter when the views allow it.",
      flanged: "Describe damage on gear teeth and flange face separately.",
    };
    lines.push(
      `Confirmed gear type: ${gearType}. ${featureWarnings[gearType]} Do not apply spur-gear vocabulary to other tooth forms.`
    );
  } else if (analysis?.requiresGearTypeConfirmation || analysis?.geometryRecipe?.gear) {
    lines.push(
      "The tooth form is unconfirmed. Report only directly visible surface damage; do not assume spur teeth or use tooth-form-specific conclusions."
    );
  }
  if (analysis?.geometryRecipe?.gear) {
    const g = analysis.geometryRecipe.gear;
    const details = [
      typeof g.teeth === "number" ? `${g.teeth} teeth` : null,
      typeof g.module === "number" ? `module ${g.module} mm` : null,
      typeof g.helixAngle === "number" && g.helixAngle !== 0 ? `helix ${g.helixAngle}°` : null,
      typeof g.coneAngle === "number" ? `cone ${g.coneAngle}°` : null,
    ].filter(Boolean);
    if (details.length) {
      lines.push(`Reconstructed gear geometry context: ${details.join(", ")}. Use this only to localise visible findings; it is not evidence of damage.`);
    }
  }
  return lines.join("\n");
}

/**
 * Calls Gemini for visible condition observations. Never throws: a failure
 * returns a NEEDS INSPECTION assessment so the main analysis still succeeds.
 */
export async function assessVisualCondition({ images, analysis } = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    return unknownConditionAssessment("No component images were supplied for condition assessment.");
  }

  let genAI;
  try {
    genAI = createGeminiClient();
  } catch (error) {
    return unknownConditionAssessment(error?.message || "Visual assessment unavailable.");
  }

  const parts = images.map((image) => ({
    inlineData: { data: image.data, mimeType: image.mimeType },
  }));
  parts.push({ text: conditionPrompt(analysis) });

  const candidateModels = getCandidateModels();
  let lastError = null;

  for (const modelName of candidateModels) {
    try {
      const targetModel = createGeminiModel(genAI, modelName);
      const result = await targetModel.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          responseSchema: CONDITION_SCHEMA,
        },
      });
      const raw = JSON.parse(stripFences(result.response.text()));
      return deriveConditionAssessment(raw, {
        componentType: analysis?.componentType,
        gearType: analysis?.gearType,
        requiresGearTypeConfirmation: analysis?.requiresGearTypeConfirmation,
        imageCount: images.length,
      });
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (
        message.includes("404") ||
        message.includes("429") ||
        message.includes("500") ||
        message.includes("502") ||
        message.includes("503") ||
        message.includes("504") ||
        message.includes("no longer available") ||
        message.includes("high demand") ||
        message.includes("overloaded") ||
        message.includes("temporarily unavailable")
      ) {
        continue;
      }
      break;
    }
  }

  return unknownConditionAssessment(
    lastError ? `Visual assessment unavailable: ${String(lastError.message || lastError)}` : ""
  );
}
