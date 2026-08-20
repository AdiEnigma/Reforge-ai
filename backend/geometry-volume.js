// geometry-volume.js
// Estimates the volume (in cm³) of a component from its analysis object.
// All internal arithmetic is done in mm³; the result is divided by 1000 at the
// very end to convert to cm³.  mm → cm³ is the most common unit-conversion bug
// in this module — every formula below keeps values in mm until the final step.
//
// Returns: { volumeCm3: number | null, source: "recipe" | "fallback-dims" | "insufficient-data" }

// ---------------------------------------------------------------------------
// Server-side recipe sanitiser
// Mirrors sanitizeRecipe() from gemini.js — re-validates because analysis
// arrives from the browser (untrusted client) on the /api/manufacturing-intelligence
// endpoint and must be treated defensively.
// ---------------------------------------------------------------------------

const COMPONENT_STYLES = ["revolved", "extruded", "gear", "combination"];
const PRIMITIVE_KINDS = ["box", "cylinder", "sphere", "cone", "torus"];
const RECIPE_LIMITS = {
  maxProfilePoints: 200,
  maxOutlinePoints: 200,
  maxHoles: 50,
  maxPrimitives: 30,
  maxDimensionRatio: 1000,
};

function cleanNum(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

function sanitizeRecipeForVolume(rawRecipe) {
  if (!rawRecipe || typeof rawRecipe !== "object") return null;
  const recipe = {};
  recipe.style = COMPONENT_STYLES.includes(rawRecipe.style) ? rawRecipe.style : null;

  // --- revolvedProfile ---
  const rawProfile = Array.isArray(rawRecipe.revolvedProfile)
    ? rawRecipe.revolvedProfile.slice(0, RECIPE_LIMITS.maxProfilePoints)
    : [];
  const cleanProfile = [];
  for (const pt of rawProfile) {
    if (!pt || typeof pt !== "object") continue;
    const z = cleanNum(pt.z);
    const radius = cleanNum(pt.radius);
    if (z == null || radius == null) continue;
    cleanProfile.push({ z, radius: Math.max(0, radius) });
  }
  if (cleanProfile.length >= 2) {
    cleanProfile.sort((a, b) => a.z - b.z);
    recipe.revolvedProfile = cleanProfile;
  }

  // --- outline ---
  const rawOutline = Array.isArray(rawRecipe.outline)
    ? rawRecipe.outline.slice(0, RECIPE_LIMITS.maxOutlinePoints)
    : [];
  const cleanOutline = [];
  for (const pt of rawOutline) {
    if (!pt || typeof pt !== "object") continue;
    const x = cleanNum(pt.x);
    const y = cleanNum(pt.y);
    if (x == null || y == null) continue;
    cleanOutline.push({ x, y });
  }
  if (cleanOutline.length >= 3) recipe.outline = cleanOutline;

  // --- holes ---
  const rawHoles = Array.isArray(rawRecipe.holes)
    ? rawRecipe.holes.slice(0, RECIPE_LIMITS.maxHoles)
    : [];
  const cleanHoles = [];
  for (const h of rawHoles) {
    if (!h || typeof h !== "object") continue;
    const cx = cleanNum(h.cx);
    const cy = cleanNum(h.cy);
    const radius = cleanNum(h.radius);
    if (cx == null || cy == null || radius == null || radius <= 0) continue;
    cleanHoles.push({ cx, cy, radius });
  }
  if (cleanHoles.length) recipe.holes = cleanHoles;

  const depth = cleanNum(rawRecipe.depth);
  if (depth != null && depth > 0) recipe.depth = depth;

  // --- gear ---
  const g = rawRecipe.gear && typeof rawRecipe.gear === "object" ? rawRecipe.gear : {};
  const gear = {
    teeth: cleanNum(g.teeth),
    module: cleanNum(g.module),
    pressureAngle: cleanNum(g.pressureAngle),
    helixAngle: cleanNum(g.helixAngle),
    faceWidth: cleanNum(g.faceWidth),
    boreRadius: cleanNum(g.boreRadius),
  };
  if (Object.values(gear).some((v) => v != null)) recipe.gear = gear;

  // --- primitives ---
  const rawPrimitives = Array.isArray(rawRecipe.primitives)
    ? rawRecipe.primitives.slice(0, RECIPE_LIMITS.maxPrimitives)
    : [];
  const cleanPrimitives = [];
  for (const p of rawPrimitives) {
    if (!p || typeof p !== "object" || !PRIMITIVE_KINDS.includes(p.kind)) continue;
    const item = { kind: p.kind };
    for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]) {
      const v = cleanNum(p[key]);
      if (v != null) item[key] = v;
    }
    cleanPrimitives.push(item);
  }
  if (cleanPrimitives.length) recipe.primitives = cleanPrimitives;

  // Style inference
  if (!recipe.style) {
    if (recipe.gear) recipe.style = "gear";
    else if (recipe.revolvedProfile) recipe.style = "revolved";
    else if (recipe.outline) recipe.style = "extruded";
    else if (recipe.primitives) recipe.style = "combination";
  }

  if (!recipe.style) return null;
  if (!(recipe.revolvedProfile || recipe.outline || recipe.gear || recipe.primitives)) return null;
  return recipe;
}

// ---------------------------------------------------------------------------
// Component-type resolver (server-side, no THREE.js dependency)
// Mirrors resolveComponentType() from frontend/src/lib/reconstruct.js
// ---------------------------------------------------------------------------
const COMPONENT_KEYS = [
  "spur gear",
  "cylinder/shaft",
  "flange",
  "bearing",
  "simple bracket",
  "other",
];

export function resolveComponentTypeServer(analysis) {
  const raw = String(analysis?.componentType || "other").toLowerCase();
  // longest match first
  const ordered = [...COMPONENT_KEYS].sort((a, b) => b.length - a.length);
  for (const key of ordered) {
    if (raw.includes(key)) return key;
  }
  if (raw.includes("gear")) return "spur gear";
  if (raw.includes("shaft") || raw.includes("cylinder") || raw.includes("rod") || raw.includes("spindle")) return "cylinder/shaft";
  if (raw.includes("flange") || raw.includes("coupling")) return "flange";
  if (raw.includes("bearing")) return "bearing";
  if (raw.includes("bracket") || raw.includes("mount") || raw.includes("plate")) return "simple bracket";
  return "other";
}

// ---------------------------------------------------------------------------
// Volume formulae (all in mm³)
// ---------------------------------------------------------------------------

function volumeRevolved(profile) {
  // Pappus / frustum stacking over sorted revolvedProfile points {z, radius}.
  // Assumes solid revolution — no bore channel in the current schema.
  let volumeMm3 = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const { z: z0, radius: r0 } = profile[i];
    const { z: z1, radius: r1 } = profile[i + 1];
    const h = Math.abs(z1 - z0);
    // Frustum (cone frustum) formula: π*h/3 * (r0² + r0*r1 + r1²)
    volumeMm3 += (Math.PI * h) / 3 * (r0 * r0 + r0 * r1 + r1 * r1);
  }
  return volumeMm3;
}

function volumeExtruded(outline, holes, depth) {
  // Shoelace formula for outline polygon area
  let area = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += outline[i].x * outline[j].y;
    area -= outline[j].x * outline[i].y;
  }
  let outlineArea = Math.abs(area) / 2;

  // Subtract hole areas
  let holeArea = 0;
  for (const h of holes || []) {
    holeArea += Math.PI * h.radius * h.radius;
  }

  const netArea = Math.max(0, outlineArea - holeArea);
  return netArea * depth;
}

function volumeGear(gear) {
  // Coarse cylinder approximation — cost-estimation grade only, NOT machining grade.
  // Matches the geometry derived in buildGearFromRecipe() in frontend/src/lib/recipe.js.
  const teeth = Math.max(6, Math.min(200, Math.round(gear.teeth || 16)));
  const module = gear.module != null && gear.module > 0 ? gear.module : null;

  let outerR, toothHeight;
  if (module) {
    outerR = (teeth * module) / 2 + module;       // addendum circle
    toothHeight = 2.25 * module;                   // full tooth height (addendum + dedendum)
  } else {
    outerR = 2.8;                                  // dimensionless fallback (same as buildGearFromRecipe)
    toothHeight = outerR * 0.08;
  }

  const faceWidth = gear.faceWidth != null && gear.faceWidth > 0 ? gear.faceWidth : outerR * 0.45;
  const boreRadius = gear.boreRadius != null && gear.boreRadius > 0 ? gear.boreRadius : outerR * 0.35;

  // Effective root radius (outer minus 45% of tooth height to account for tooth valleys)
  const effectiveR = outerR - toothHeight * 0.45;
  const boreR = Math.min(boreRadius, effectiveR * 0.9); // clamp to prevent negative area

  return Math.PI * (effectiveR * effectiveR - boreR * boreR) * faceWidth;
}

function volumeCombination(primitives) {
  let total = 0;
  for (const p of primitives) {
    switch (p.kind) {
      case "box":
        total += (p.width || 1) * (p.height || 1) * (p.depth || 1);
        break;
      case "cylinder":
        // buildPrimitive() uses same radius for top and bottom
        total += Math.PI * Math.pow(p.radius || 0.5, 2) * (p.height || 1);
        break;
      case "sphere":
        total += (4 / 3) * Math.PI * Math.pow(p.radius || 0.5, 3);
        break;
      case "cone":
        total += (1 / 3) * Math.PI * Math.pow(p.radius || 0.5, 2) * (p.height || 1);
        break;
      case "torus":
        total += 2 * Math.PI * Math.PI * (p.radius || 0.5) * Math.pow(p.tube || 0.15, 2);
        break;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Fallback: bounding-volume × fill factor from analysis.dimensions
// ---------------------------------------------------------------------------

function volumeFallback(analysis) {
  const dims = analysis?.dimensions || {};
  const outerD = dims.outerDiameter;
  const innerD = dims.innerDiameter;
  const height = dims.height;
  const width = dims.width;
  const length = dims.length;
  const thickness = dims.thickness;

  const v = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? x : null);

  const od = v(outerD);
  const id = v(innerD);
  const h = v(height);
  const w = v(width);
  const l = v(length);
  const t = v(thickness);

  const type = resolveComponentTypeServer(analysis);

  switch (type) {
    case "spur gear": {
      if (!od || !h) return null;
      return Math.PI * Math.pow(od / 2, 2) * h * 0.72;
    }
    case "cylinder/shaft": {
      if (!od || !h) return null;
      if (id) {
        // hollow shaft / ring
        return Math.PI * (Math.pow(od / 2, 2) - Math.pow(id / 2, 2)) * h;
      }
      return Math.PI * Math.pow(od / 2, 2) * h;
    }
    case "flange": {
      if (!od || !t) return null;
      return Math.PI * Math.pow(od / 2, 2) * t * 0.55;
    }
    case "bearing": {
      if (!od || !t) return null;
      return Math.PI * Math.pow(od / 2, 2) * t * 0.45;
    }
    case "simple bracket": {
      const d = w || l || t;
      if (!d || !h || !t) return null;
      return d * h * t * 0.35;
    }
    case "other":
    default: {
      const depth = t || l;
      if (!w || !h || !depth) return null;
      return w * h * depth * 0.5;
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Estimate volume from a Gemini analysis object.
 * @param {object} analysis  — normalised analysis from Gemini (may arrive from client)
 * @returns {{ volumeCm3: number|null, source: string }}
 */
export function estimateVolumeCm3(analysis) {
  // Try recipe-based estimate first
  const recipe = sanitizeRecipeForVolume(analysis?.geometryRecipe);
  if (recipe) {
    let volumeMm3 = null;

    switch (recipe.style) {
      case "revolved":
        if (recipe.revolvedProfile?.length >= 2) {
          volumeMm3 = volumeRevolved(recipe.revolvedProfile);
        }
        break;

      case "extruded":
        if (recipe.outline?.length >= 3 && recipe.depth > 0) {
          volumeMm3 = volumeExtruded(recipe.outline, recipe.holes, recipe.depth);
        }
        break;

      case "gear":
        if (recipe.gear) {
          volumeMm3 = volumeGear(recipe.gear);
        }
        break;

      case "combination":
        if (recipe.primitives?.length) {
          volumeMm3 = volumeCombination(recipe.primitives);
        }
        break;
    }

    if (volumeMm3 != null && isFinite(volumeMm3) && volumeMm3 > 0) {
      return { volumeCm3: volumeMm3 / 1000, source: "recipe" };
    }
  }

  // Fallback: bounding-volume estimate from dimensions
  const fallbackMm3 = volumeFallback(analysis);
  if (fallbackMm3 != null && isFinite(fallbackMm3) && fallbackMm3 > 0) {
    return { volumeCm3: fallbackMm3 / 1000, source: "fallback-dims" };
  }

  return { volumeCm3: null, source: "insufficient-data" };
}
