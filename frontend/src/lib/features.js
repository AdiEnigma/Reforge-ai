/**
 * features.js
 * Normalized Feature Identification & Extraction System for ReForge AI.
 * Deterministic extraction from recipe, dimensions, and analysis.
 */

export const FEATURE_TYPES = {
  bore: "bore",
  mounting_hole: "mounting_hole",
  keyway: "keyway",
  gear_teeth: "gear_teeth",
  shoulder: "shoulder",
  flange: "flange",
  shaft: "shaft",
  boss: "boss",
  slot: "slot",
  pocket: "pocket",
  groove: "groove",
  chamfer: "chamfer",
  fillet: "fillet",
  thread: "thread",
  other: "other",
};

export const FEATURE_LABELS = {
  bore: "Central Bore",
  mounting_hole: "Mounting Holes",
  keyway: "Keyway",
  gear_teeth: "Gear Teeth",
  shoulder: "Shaft Shoulder",
  flange: "Mounting Flange",
  shaft: "Cylindrical Shaft",
  boss: "Hub / Boss",
  slot: "Machined Slot",
  pocket: "Recessed Pocket",
  groove: "Retention Groove",
  chamfer: "Edge Chamfer",
  fillet: "Corner Fillet",
  thread: "Machined Threads",
  other: "Geometric Feature",
};

export const FEATURE_DESCRIPTIONS = {
  bore: "Central cylindrical through-hole along the primary axis.",
  mounting_hole: "Repeated holes used for fastening and mounting the component.",
  keyway: "Machined axial slot used to transmit torque via a drive key.",
  gear_teeth: "External tooth profile designed for positive mechanical engagement.",
  shoulder: "Radial step between two shaft or profile diameters.",
  flange: "External protruding rim used for mounting or structural attachment.",
  shaft: "Main cylindrical body or spindle section.",
  boss: "Raised cylindrical protrusion or bearing hub.",
  slot: "Elongated opening or channel for alignment or clamping.",
  pocket: "Internal cavity or recessed milled area.",
  groove: "Circumferential or internal recess for seals, snap rings, or balls.",
  chamfer: "Angled transitional edge removing sharp 90-degree corners.",
  fillet: "Smooth rounded internal transition to reduce stress concentration.",
  thread: "Helical ridge for threaded fastener engagement.",
  other: "Geometric feature identified from component analysis.",
};

export const FEATURE_PRIORITY = {
  bore: 1,
  mounting_hole: 2,
  keyway: 3,
  gear_teeth: 4,
  shoulder: 5,
  flange: 6,
  shaft: 7,
  boss: 8,
  slot: 9,
  pocket: 10,
  groove: 11,
  chamfer: 12,
  fillet: 13,
  thread: 14,
  other: 15,
};

// Named threshold for shoulder step detection on revolved profiles
export const SHOULDER_THRESHOLD_MM = 1.0;
export const SHOULDER_RELATIVE_RATIO = 0.06;

const SYNONYM_MAP = [
  { match: ["central bore", "central hole", "center hole", "centre hole", "bore", "through hole", "inner bore", "inner hole", "inner diameter", "center bore"], type: "bore" },
  { match: ["mounting hole", "mounting holes", "bolt hole", "bolt holes", "mount hole", "mount holes", "fastener hole", "fastener holes", "screw hole", "screw holes", "drilled holes", "perimeter holes"], type: "mounting_hole" },
  { match: ["keyway", "key way", "key seat", "key slot", "drive key"], type: "keyway" },
  { match: ["gear teeth", "teeth", "tooth profile", "spur teeth", "helical teeth", "cog teeth", "splines", "pinion teeth"], type: "gear_teeth" },
  { match: ["shoulder", "step", "stepped diameter", "shaft shoulder", "collar step"], type: "shoulder" },
  { match: ["flange", "base flange", "mounting flange", "collar flange", "rim flange"], type: "flange" },
  { match: ["shaft", "spindle", "cylindrical body", "pin", "axle", "stem"], type: "shaft" },
  { match: ["boss", "hub", "collar", "protrusion", "raised boss", "bearing hub"], type: "boss" },
  { match: ["slot", "slots", "slotted", "channel", "milled slot"], type: "slot" },
  { match: ["pocket", "pockets", "recess", "cavity", "milled pocket"], type: "pocket" },
  { match: ["groove", "grooves", "snap ring groove", "o-ring groove", "raceway", "channel groove"], type: "groove" },
  { match: ["chamfer", "chamfers", "bevel", "beveled edge", "chamfered"], type: "chamfer" },
  { match: ["fillet", "fillets", "rounded edge", "radius transition", "filleted"], type: "fillet" },
  { match: ["thread", "threads", "threaded", "tapping", "internal thread", "external thread"], type: "thread" },
];

/**
 * Match a raw feature string from Gemini analysis to a canonical feature type.
 */
export function matchFeatureType(rawText) {
  if (!rawText || typeof rawText !== "string") return "other";
  const lower = rawText.toLowerCase().trim();
  for (const { match, type } of SYNONYM_MAP) {
    for (const phrase of match) {
      if (lower.includes(phrase)) return type;
    }
  }
  return "other";
}

/**
 * Extract count from a feature string (e.g. "6 mounting holes" -> 6).
 */
export function extractCountFromString(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const match = rawText.match(/(\d+)\s*(?:bolt|mounting|mount|fastener|screw|drilled)?\s*holes?/i);
  if (match && match[1]) {
    const count = parseInt(match[1], 10);
    if (!isNaN(count) && count > 0) return count;
  }
  const digitMatch = rawText.match(/^(\d+)\b/);
  if (digitMatch && digitMatch[1]) {
    const count = parseInt(digitMatch[1], 10);
    if (!isNaN(count) && count > 0) return count;
  }
  return null;
}

/**
 * Inspect revolvedProfile to detect radial steps/shoulders.
 */
export function detectShoulders(profile) {
  if (!Array.isArray(profile) || profile.length < 2) return [];
  const shoulders = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const r1 = profile[i].radius;
    const r2 = profile[i + 1].radius;
    if (typeof r1 !== "number" || typeof r2 !== "number") continue;
    const diff = Math.abs(r2 - r1);
    const maxR = Math.max(r1, r2, 0.1);
    if (diff >= SHOULDER_THRESHOLD_MM || diff >= SHOULDER_RELATIVE_RATIO * maxR) {
      shoulders.push({
        z: profile[i].z,
        radius1: r1,
        radius2: r2,
        stepHeight: diff,
      });
    }
  }
  return shoulders;
}

/**
 * Normalizes all detected features from analysis, geometryRecipe, and dimensions.
 * Produces a deduplicated, prioritized array of feature objects.
 *
 * @param {object} analysis - The Gemini component analysis object
 * @returns {Array<object>} - Array of normalized feature objects
 */
export function normalizeFeatures(analysis) {
  if (!analysis || typeof analysis !== "object") return [];

  const recipe = analysis.geometryRecipe || {};
  const dims = analysis.dimensions || {};
  const compType = String(analysis.componentType || "").toLowerCase();
  const featuresMap = new Map(); // key: featureType -> feature object

  const addOrMergeFeature = (feature) => {
    const key = feature.type;
    if (!featuresMap.has(key)) {
      featuresMap.set(key, feature);
      return;
    }

    const existing = featuresMap.get(key);
    // Merge: recipe > derived > analysis
    const sourcePriority = { recipe: 3, derived: 2, analysis: 1 };
    const currPrio = sourcePriority[existing.source] || 1;
    const newPrio = sourcePriority[feature.source] || 1;

    if (newPrio > currPrio) {
      featuresMap.set(key, {
        ...feature,
        metadata: { ...existing.metadata, ...feature.metadata },
      });
    } else {
      // Merge metadata and keep higher confidence
      existing.metadata = { ...feature.metadata, ...existing.metadata };
      if (feature.confidence > existing.confidence) {
        existing.confidence = feature.confidence;
      }
      if (feature.geometryRef && !existing.geometryRef) {
        existing.geometryRef = feature.geometryRef;
      }
    }
  };

  // 1. Deterministic Extraction from recipe.gear / teeth / spur gear component
  const hasGear =
    recipe.style === "gear" ||
    (recipe.gear && typeof recipe.gear === "object") ||
    (typeof analysis.teeth === "number" && analysis.teeth > 0) ||
    compType.includes("gear");

  if (hasGear) {
    const teethCount =
      recipe.gear?.teeth ||
      (typeof analysis.teeth === "number" && analysis.teeth > 0 ? Math.round(analysis.teeth) : null);
    const mod = recipe.gear?.module || analysis.module || null;
    const helixAngle = recipe.gear?.helixAngle || analysis.helixAngle || null;

    addOrMergeFeature({
      id: "feature-gear-teeth-1",
      type: "gear_teeth",
      label: teethCount ? `${teethCount} Gear Teeth` : "Gear Teeth",
      description: FEATURE_DESCRIPTIONS.gear_teeth,
      source: "recipe",
      confidence: 1.0,
      geometryRef: "feature-gear-teeth-1",
      metadata: {
        teeth: teethCount,
        module: mod,
        helixAngle,
        faceWidth: recipe.gear?.faceWidth || dims.height || dims.thickness || null,
      },
    });

    // Spur gears commonly have hubs/bosses
    addOrMergeFeature({
      id: "feature-boss-1",
      type: "boss",
      label: "Center Hub",
      description: FEATURE_DESCRIPTIONS.boss,
      source: "recipe",
      confidence: 0.95,
      geometryRef: "feature-boss-1",
      metadata: {},
    });
  }

  // 2. Deterministic Extraction of Central Bore
  const innerDia =
    typeof dims.innerDiameter === "number" && dims.innerDiameter > 0
      ? dims.innerDiameter
      : null;
  const gearBore = recipe.gear?.boreRadius ? recipe.gear.boreRadius * 2 : null;
  const recipeHoles = Array.isArray(recipe.holes) ? recipe.holes : [];
  const centralHole = recipeHoles.find(
    (h) => Math.abs(h.cx || 0) < 0.01 && Math.abs(h.cy || 0) < 0.01
  );

  const boreDia = innerDia || gearBore || (centralHole ? centralHole.radius * 2 : null);

  if (
    boreDia ||
    compType.includes("bearing") ||
    compType.includes("flange") ||
    (hasGear && (innerDia || gearBore))
  ) {
    addOrMergeFeature({
      id: "feature-bore-1",
      type: "bore",
      label: "Central Bore",
      description: FEATURE_DESCRIPTIONS.bore,
      source: "recipe",
      confidence: 1.0,
      geometryRef: "feature-bore-1",
      metadata: {
        diameter: boreDia ? Math.round(boreDia * 10) / 10 : null,
        depth: dims.height || dims.thickness || dims.length || recipe.depth || null,
        count: 1,
      },
    });
  }

  // 3. Deterministic Extraction of Mounting Holes
  const perimeterHoles = recipeHoles.filter(
    (h) => Math.abs(h.cx || 0) >= 0.01 || Math.abs(h.cy || 0) >= 0.01
  );

  if (perimeterHoles.length > 0) {
    const avgDia =
      perimeterHoles.reduce((sum, h) => sum + (h.radius || 0) * 2, 0) / perimeterHoles.length;
    addOrMergeFeature({
      id: "feature-mounting-holes-1",
      type: "mounting_hole",
      label: `${perimeterHoles.length} Mounting Holes`,
      description: FEATURE_DESCRIPTIONS.mounting_hole,
      source: "recipe",
      confidence: 1.0,
      geometryRef: "feature-mounting-holes-1",
      metadata: {
        count: perimeterHoles.length,
        diameter: avgDia > 0 ? Math.round(avgDia * 10) / 10 : null,
      },
    });
  } else if (compType.includes("flange")) {
    // Parametric flange has 6 mounting holes by default
    addOrMergeFeature({
      id: "feature-mounting-holes-1",
      type: "mounting_hole",
      label: "6 Mounting Holes",
      description: FEATURE_DESCRIPTIONS.mounting_hole,
      source: "derived",
      confidence: 0.9,
      geometryRef: "feature-mounting-holes-1",
      metadata: {
        count: 6,
      },
    });
  }

  // 4. Deterministic Extraction of Revolved Shoulders / Shafts
  if (recipe.style === "revolved" && Array.isArray(recipe.revolvedProfile)) {
    const shoulders = detectShoulders(recipe.revolvedProfile);
    if (shoulders.length > 0) {
      addOrMergeFeature({
        id: "feature-shoulder-1",
        type: "shoulder",
        label: shoulders.length > 1 ? `${shoulders.length} Shaft Shoulders` : "Shaft Shoulder",
        description: FEATURE_DESCRIPTIONS.shoulder,
        source: "derived",
        confidence: 0.88,
        geometryRef: "feature-shoulder-1",
        metadata: {
          count: shoulders.length,
          maxStep: Math.max(...shoulders.map((s) => s.stepHeight)),
        },
      });
    }

    addOrMergeFeature({
      id: "feature-shaft-1",
      type: "shaft",
      label: "Cylindrical Shaft",
      description: FEATURE_DESCRIPTIONS.shaft,
      source: "recipe",
      confidence: 1.0,
      geometryRef: "feature-shaft-1",
      metadata: {
        outerDiameter: dims.outerDiameter || null,
        length: dims.height || dims.length || null,
      },
    });
  } else if (compType.includes("cylinder") || compType.includes("shaft")) {
    addOrMergeFeature({
      id: "feature-shaft-1",
      type: "shaft",
      label: "Cylindrical Shaft",
      description: FEATURE_DESCRIPTIONS.shaft,
      source: "recipe",
      confidence: 1.0,
      geometryRef: "feature-shaft-1",
      metadata: {
        outerDiameter: dims.outerDiameter || null,
        length: dims.height || dims.length || null,
      },
    });

    addOrMergeFeature({
      id: "feature-chamfer-1",
      type: "chamfer",
      label: "End Chamfers",
      description: FEATURE_DESCRIPTIONS.chamfer,
      source: "derived",
      confidence: 0.8,
      geometryRef: "feature-chamfer-1",
      metadata: {},
    });
  }

  // 5. Flange base & boss features
  if (compType.includes("flange") || recipe.style === "extruded") {
    addOrMergeFeature({
      id: "feature-flange-1",
      type: "flange",
      label: "Mounting Flange",
      description: FEATURE_DESCRIPTIONS.flange,
      source: "recipe",
      confidence: 1.0,
      geometryRef: "feature-flange-1",
      metadata: {
        outerDiameter: dims.outerDiameter || dims.width || null,
        thickness: dims.thickness || dims.height || null,
      },
    });

    if (compType.includes("flange")) {
      addOrMergeFeature({
        id: "feature-boss-1",
        type: "boss",
        label: "Flange Boss",
        description: FEATURE_DESCRIPTIONS.boss,
        source: "derived",
        confidence: 0.9,
        geometryRef: "feature-boss-1",
        metadata: {},
      });
    }
  }

  // 6. Bracket & Bearing Features
  if (compType.includes("bracket")) {
    addOrMergeFeature({
      id: "feature-flange-1",
      type: "flange",
      label: "Mounting Bracket Plates",
      description: FEATURE_DESCRIPTIONS.flange,
      source: "recipe",
      confidence: 0.95,
      geometryRef: "feature-flange-1",
      metadata: {},
    });
    addOrMergeFeature({
      id: "feature-fillet-1",
      type: "fillet",
      label: "Reinforcement Gussets",
      description: FEATURE_DESCRIPTIONS.fillet,
      source: "derived",
      confidence: 0.9,
      geometryRef: "feature-fillet-1",
      metadata: {},
    });
    addOrMergeFeature({
      id: "feature-mounting-holes-1",
      type: "mounting_hole",
      label: "Fastener Mounting Points",
      description: FEATURE_DESCRIPTIONS.mounting_hole,
      source: "derived",
      confidence: 0.85,
      geometryRef: "feature-mounting-holes-1",
      metadata: { count: 2 },
    });
  }

  if (compType.includes("bearing")) {
    addOrMergeFeature({
      id: "feature-flange-1",
      type: "flange",
      label: "Outer Race",
      description: FEATURE_DESCRIPTIONS.flange,
      source: "recipe",
      confidence: 0.95,
      geometryRef: "feature-flange-1",
      metadata: {},
    });
    addOrMergeFeature({
      id: "feature-groove-1",
      type: "groove",
      label: "Ball Raceway & Rolling Elements",
      description: FEATURE_DESCRIPTIONS.groove,
      source: "derived",
      confidence: 0.95,
      geometryRef: "feature-groove-1",
      metadata: { count: 10 },
    });
  }

  // 7. Parse string array from `analysis.features`
  const textFeatures = Array.isArray(analysis.features) ? analysis.features : [];
  for (const raw of textFeatures) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const type = matchFeatureType(raw);
    const count = extractCountFromString(raw);
    const label = count && type === "mounting_hole"
      ? `${count} Mounting Holes`
      : FEATURE_LABELS[type] || raw.trim();

    addOrMergeFeature({
      id: `feature-${type}-1`,
      type,
      label,
      description: FEATURE_DESCRIPTIONS[type] || FEATURE_DESCRIPTIONS.other,
      source: "analysis",
      confidence: typeof analysis.confidence === "number" ? Math.min(0.85, analysis.confidence) : 0.75,
      geometryRef: featuresMap.has(type) ? featuresMap.get(type).geometryRef : null,
      metadata: count ? { count } : {},
    });
  }

  // Convert to array and sort by priority
  const result = Array.from(featuresMap.values());
  result.sort((a, b) => {
    const prioA = FEATURE_PRIORITY[a.type] || 99;
    const prioB = FEATURE_PRIORITY[b.type] || 99;
    return prioA - prioB;
  });

  return result;
}
