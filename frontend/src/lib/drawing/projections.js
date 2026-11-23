/**
 * projections.js
 * 2D Orthographic Projection Engine (Front, Top, Right-Side Views).
 * Converts 3D recipes and component dimensions into 2D CAD views.
 */

import { line, rect, circle, arc, path, centerMark, dimension, pt } from "./geometry.js";

/**
 * Format a number for engineering dimension display (e.g. 50, 12.5).
 */
export function formatDim(n) {
  if (typeof n !== "number" || !isFinite(n)) return "";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded.toFixed(1)}`;
}

/**
 * Derives the base dimensions from analysis and recipe.
 */
export function extractBaseDimensions(analysis) {
  const dims = analysis?.dimensions || {};
  const recipe = analysis?.geometryRecipe || {};

  let outerDia = dims.outerDiameter || analysis?.outerDiameter || null;
  let innerDia = dims.innerDiameter || null;
  let height = dims.height || dims.length || null;
  let width = dims.width || dims.outerDiameter || null;
  let depth = dims.thickness || dims.length || recipe.depth || null;
  let teeth = typeof analysis?.teeth === "number" && analysis.teeth > 0 ? Math.round(analysis.teeth) : null;
  let module = analysis?.module || null;
  let spokes = null;
  if (typeof analysis?.spokes === "number" && analysis.spokes >= 3) {
    spokes = Math.round(analysis.spokes);
  } else if (typeof recipe?.gear?.spokes === "number" && recipe.gear.spokes >= 3) {
    spokes = Math.round(recipe.gear.spokes);
  } else if (Array.isArray(analysis?.features)) {
    for (const f of analysis.features) {
      const match = String(f).match(/(\d+)\s*(?:spoke|cutout|window|pocket|arm)/i);
      if (match && match[1]) {
        spokes = parseInt(match[1], 10);
        break;
      }
      if (/spoke|lightening\s*cutout|web\s*pocket/i.test(String(f))) {
        spokes = 6;
      }
    }
  }

  // Recipe overrides / refinements
  if (recipe.gear) {
    if (recipe.gear.teeth) teeth = recipe.gear.teeth;
    if (recipe.gear.module) module = recipe.gear.module;
    if (recipe.gear.faceWidth) height = recipe.gear.faceWidth;
    if (recipe.gear.boreRadius) innerDia = recipe.gear.boreRadius * 2;
    if (recipe.gear.spokes) spokes = recipe.gear.spokes;
    const explicitOuterDia = [recipe.gear.outerDiameter, analysis?.outerDiameter].find(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0
    );
    if (explicitOuterDia != null) {
      outerDia = explicitOuterDia;
      width = outerDia;
    } else if (teeth && module) {
      outerDia = (teeth * module) + (2 * module);
      width = outerDia;
    }
  }

  if (recipe.style === "revolved" && Array.isArray(recipe.revolvedProfile) && recipe.revolvedProfile.length >= 2) {
    const maxR = Math.max(...recipe.revolvedProfile.map((p) => p.radius || 0));
    const minZ = Math.min(...recipe.revolvedProfile.map((p) => p.z || 0));
    const maxZ = Math.max(...recipe.revolvedProfile.map((p) => p.z || 0));
    if (maxR > 0) outerDia = maxR * 2;
    if (maxZ - minZ > 0) height = maxZ - minZ;
  }

  if (recipe.style === "extruded" && Array.isArray(recipe.outline) && recipe.outline.length >= 3) {
    const xs = recipe.outline.map((p) => p.x || 0);
    const ys = recipe.outline.map((p) => p.y || 0);
    width = Math.max(...xs) - Math.min(...xs);
    height = Math.max(...ys) - Math.min(...ys);
    if (recipe.depth) depth = recipe.depth;
  }

  // Fallbacks if missing
  width = width || outerDia || 60;
  height = height || 40;
  depth = depth || 20;

  return {
    outerDia: outerDia || width,
    innerDia,
    width,
    height,
    depth,
    teeth,
    module,
    spokes,
  };
}

/**
 * Revolved component projections (Shafts, Cylinders, Stepped Hubs)
 */
function projectRevolved(recipe, dims, isRecipe) {
  const profile = recipe?.revolvedProfile || [];
  const hasProfile = profile.length >= 2;

  const od = dims.outerDia || 50;
  const len = dims.height || 80;
  const bore = dims.innerDia || 0;
  const halfOd = od / 2;
  const halfBore = bore / 2;

  const front = { entities: [], dimensions: [], width: len, height: od };
  const top = { entities: [], dimensions: [], width: od, height: od };
  const side = { entities: [], dimensions: [], width: od, height: od };

  if (hasProfile) {
    const minZ = Math.min(...profile.map((p) => p.z));
    const maxZ = Math.max(...profile.map((p) => p.z));
    const totalZ = Math.max(1, maxZ - minZ);

    // Front View: Symmetric axial silhouette from profile
    const upperPts = profile.map((p) => pt(p.z - minZ - totalZ / 2, -p.radius));
    const lowerPts = [...profile].reverse().map((p) => pt(p.z - minZ - totalZ / 2, p.radius));
    const fullProfile = [...upperPts, ...lowerPts];

    front.entities.push(path(fullProfile, true, "visible"));
    // Centerline along shaft axis
    front.entities.push(line(-totalZ / 2 - 10, 0, totalZ / 2 + 10, 0, "centerline"));

    // Step lines inside silhouette
    for (let i = 0; i < profile.length - 1; i++) {
      const z = profile[i].z - minZ - totalZ / 2;
      const r1 = profile[i].radius;
      const r2 = profile[i + 1].radius;
      if (Math.abs(r2 - r1) >= 1.0) {
        front.entities.push(line(z, -r1, z, r1, "visible"));
      }
    }

    if (bore > 0) {
      front.entities.push(line(-totalZ / 2, -halfBore, totalZ / 2, -halfBore, "hidden"));
      front.entities.push(line(-totalZ / 2, halfBore, totalZ / 2, halfBore, "hidden"));
    }
  } else {
    // Basic cylindrical silhouette
    front.entities.push(rect(-len / 2, -halfOd, len, od, "visible"));
    front.entities.push(line(-len / 2 - 10, 0, len / 2 + 10, 0, "centerline"));
    if (bore > 0) {
      front.entities.push(line(-len / 2, -halfBore, len / 2, -halfBore, "hidden"));
      front.entities.push(line(-len / 2, halfBore, len / 2, halfBore, "hidden"));
    }
  }

  // Top View: Concentric Circles with cross centerlines
  top.entities.push(circle(0, 0, halfOd, "visible"));
  top.entities.push(line(-halfOd - 8, 0, halfOd + 8, 0, "centerline"));
  top.entities.push(line(0, -halfOd - 8, 0, halfOd + 8, 0, "centerline"));

  if (bore > 0) {
    top.entities.push(circle(0, 0, halfBore, "visible"));
  }

  // Side View: Matches Top view (circular end-view) or matching axial silhouette
  side.entities.push(circle(0, 0, halfOd, "visible"));
  side.entities.push(line(-halfOd - 8, 0, halfOd + 8, 0, "centerline"));
  side.entities.push(line(0, -halfOd - 8, 0, halfOd + 8, 0, "centerline"));
  if (bore > 0) {
    side.entities.push(circle(0, 0, halfBore, "visible"));
  }

  return { front, top, side };
}

/**
 * Extruded component projections (Flanges, Plates, Custom Profiles)
 */
function projectExtruded(recipe, dims, isRecipe) {
  const outline = recipe?.outline || [];
  const holes = recipe?.holes || [];
  const depth = recipe?.depth || dims.depth || 20;

  const w = dims.width || 80;
  const h = dims.height || 80;
  const halfW = w / 2;
  const halfH = h / 2;
  const halfD = depth / 2;

  const front = { entities: [], dimensions: [], width: w, height: h };
  const top = { entities: [], dimensions: [], width: w, height: depth };
  const side = { entities: [], dimensions: [], width: depth, height: h };

  // Front View: 2D Shape outline
  if (outline.length >= 3) {
    const xs = outline.map((p) => p.x);
    const ys = outline.map((p) => p.y);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const centeredOutline = outline.map((p) => pt(p.x - cx, p.y - cy));
    front.entities.push(path(centeredOutline, true, "visible"));

    // Draw holes
    for (const hole of holes) {
      const hx = (hole.cx || 0) - cx;
      const hy = (hole.cy || 0) - cy;
      const hr = hole.radius || 4;
      front.entities.push(circle(hx, hy, hr, "visible"));
      front.entities.push(centerMark(hx, hy, hr * 2 + 4));
    }
  } else {
    // Default circular flange or plate
    front.entities.push(circle(0, 0, halfW, "visible"));
    front.entities.push(line(-halfW - 8, 0, halfW + 8, 0, "centerline"));
    front.entities.push(line(0, -halfW - 8, 0, halfW + 8, 0, "centerline"));
    if (dims.innerDia > 0) {
      front.entities.push(circle(0, 0, dims.innerDia / 2, "visible"));
    }
    if (holes.length > 0) {
      for (const hole of holes) {
        const hx = hole.cx || 0;
        const hy = hole.cy || 0;
        const hr = hole.radius || 4;
        front.entities.push(circle(hx, hy, hr, "visible"));
        front.entities.push(centerMark(hx, hy, hr * 2 + 4));
      }
    } else {
      // Flange bolt pattern: dynamic count on PCD
      const boltR = halfW * 0.76;
      const holeR = Math.max(3, halfW * 0.11);
      const bCount = Math.max(3, Math.min(64, Math.round(dims.boltCount || recipe?.flange?.boltCount || 4)));
      front.entities.push(circle(0, 0, boltR, "centerline"));
      for (let i = 0; i < bCount; i++) {
        const a = (i / bCount) * Math.PI * 2;
        const hx = Math.cos(a) * boltR;
        const hy = Math.sin(a) * boltR;
        front.entities.push(circle(hx, hy, holeR, "visible"));
        front.entities.push(centerMark(hx, hy, holeR * 2 + 4));
      }
    }
  }

  // Top View: Depth projection (rectangle)
  top.entities.push(rect(-halfW, -halfD, w, depth, "visible"));
  top.entities.push(line(-halfW - 6, 0, halfW + 6, 0, "centerline"));

  // Side View: Depth projection (rectangle)
  side.entities.push(rect(-halfD, -halfH, depth, h, "visible"));
  side.entities.push(line(0, -halfH - 6, 0, halfH + 6, 0, "centerline"));

  return { front, top, side };
}

/**
 * Gear component projections
 */
function projectGear(recipe, dims) {
  const g = recipe?.gear || {};
  const teeth = dims.teeth || g.teeth || 16;
  const module = dims.module || g.module || 2.0;
  const faceWidth = dims.height || g.faceWidth || 20;
  const bore = dims.innerDia || (g.boreRadius ? g.boreRadius * 2 : 15);

  const pitchDia = teeth * module;
  const outerDia = pitchDia + 2 * module;
  const rootDia = Math.max(10, pitchDia - 2.5 * module);
  const halfOd = outerDia / 2;
  const halfBore = bore / 2;
  const halfFw = faceWidth / 2;
  const hubDia = bore * 1.6;
  const halfHub = hubDia / 2;
  const hubExt = faceWidth * 0.2;

  const front = { entities: [], dimensions: [], width: outerDia, height: outerDia };
  const top = { entities: [], dimensions: [], width: outerDia, height: faceWidth + hubExt * 2 };
  const side = { entities: [], dimensions: [], width: faceWidth + hubExt * 2, height: outerDia };

  // Front View: Gear face
  front.entities.push(circle(0, 0, halfOd, "visible")); // Outer circle
  front.entities.push(circle(0, 0, pitchDia / 2, "centerline")); // Pitch circle (dashed)
  front.entities.push(circle(0, 0, rootDia / 2, "hidden")); // Root circle (hidden)
  front.entities.push(circle(0, 0, halfHub, "visible")); // Hub circle
  if (bore > 0) front.entities.push(circle(0, 0, halfBore, "visible")); // Bore circle

  // Cross centerlines
  front.entities.push(line(-halfOd - 10, 0, halfOd + 10, 0, "centerline"));
  front.entities.push(line(0, -halfOd - 10, 0, halfOd + 10, 0, "centerline"));

  // Tooth tick marks around perimeter
  const numMarks = Math.min(32, teeth);
  for (let i = 0; i < numMarks; i++) {
    const a = (i / numMarks) * Math.PI * 2;
    const x1 = Math.cos(a) * (rootDia / 2);
    const y1 = Math.sin(a) * (rootDia / 2);
    const x2 = Math.cos(a) * halfOd;
    const y2 = Math.sin(a) * halfOd;
    front.entities.push(line(x1, y1, x2, y2, "visible"));
  }

  // Spoke cutouts / windows if spoked
  const spokes = dims.spokes || g.spokes || null;
  if (spokes && spokes >= 3) {
    const N = Math.min(24, Math.max(3, spokes));
    const rimIn = (rootDia * 0.88) / 2;
    const hubOut = halfHub * 1.15;
    for (let i = 0; i < N; i++) {
      const centerA = (i / N) * Math.PI * 2;
      const halfSpan = (Math.PI / N) * 0.62;
      const a1 = centerA - halfSpan;
      const a2 = centerA + halfSpan;
      front.entities.push(line(Math.cos(a1) * hubOut, Math.sin(a1) * hubOut, Math.cos(a1) * rimIn, Math.sin(a1) * rimIn, "visible"));
      front.entities.push(line(Math.cos(a2) * hubOut, Math.sin(a2) * hubOut, Math.cos(a2) * rimIn, Math.sin(a2) * rimIn, "visible"));
      front.entities.push(arc(0, 0, hubOut, a1, a2, "visible"));
      front.entities.push(arc(0, 0, rimIn, a1, a2, "visible"));
    }
  }

  // Side View: Gear section with face width and hub
  const totalW = faceWidth + hubExt * 2;
  // Rim / teeth body
  side.entities.push(rect(-halfFw, -halfOd, faceWidth, outerDia, "visible"));
  // Hub protrusions
  side.entities.push(rect(-halfFw - hubExt, -halfHub, hubExt, hubDia, "visible"));
  side.entities.push(rect(halfFw, -halfHub, hubExt, hubDia, "visible"));
  // Centerline
  side.entities.push(line(-totalW / 2 - 8, 0, totalW / 2 + 8, 0, "centerline"));
  // Bore hidden lines
  if (bore > 0) {
    side.entities.push(line(-totalW / 2, -halfBore, totalW / 2, -halfBore, "hidden"));
    side.entities.push(line(-totalW / 2, halfBore, totalW / 2, halfBore, "hidden"));
  }

  // Top View: Similar to side view
  top.entities.push(rect(-halfOd, -halfFw, outerDia, faceWidth, "visible"));
  top.entities.push(rect(-halfHub, -halfFw - hubExt, hubDia, hubExt, "visible"));
  top.entities.push(rect(-halfHub, halfFw, hubDia, hubExt, "visible"));
  top.entities.push(line(0, -totalW / 2 - 8, 0, totalW / 2 + 8, "centerline"));
  if (bore > 0) {
    top.entities.push(line(-halfBore, -totalW / 2, -halfBore, totalW / 2, "hidden"));
    top.entities.push(line(halfBore, -totalW / 2, halfBore, totalW / 2, "hidden"));
  }

  return { front, top, side };
}

/**
 * Main Projection Engine Adapter
 */
export function buildDrawingModel({
  analysis,
  manufacturingIntelligence,
  revision = "A",
  date = null,
  drawingId = "RF-001",
}) {
  const recipe = analysis?.geometryRecipe || {};
  const style = recipe?.style || "fallback";
  const dims = extractBaseDimensions(analysis);
  const compType = String(analysis?.componentType || "Component").trim();
  const isRecipeBacked = Boolean(recipe && (recipe.style || recipe.revolvedProfile || recipe.outline || recipe.gear || recipe.flange));

  let views;
  if (style === "flange" || compType.toLowerCase().includes("flange")) {
    views = projectExtruded(recipe, dims, isRecipeBacked);
  } else if (style === "revolved" || compType.toLowerCase().includes("shaft") || compType.toLowerCase().includes("cylinder")) {
    views = projectRevolved(recipe, dims, isRecipeBacked);
  } else if (style === "gear" || compType.toLowerCase().includes("gear")) {
    views = projectGear(recipe, dims);
  } else if (style === "extruded" || compType.toLowerCase().includes("bracket")) {
    views = projectExtruded(recipe, dims, isRecipeBacked);
  } else {
    // Default parametric bounding projection
    views = projectRevolved(recipe, dims, false);
  }

  // Determine material name & source
  const mfgMaterial = manufacturingIntelligence?.material;
  const materialName = mfgMaterial?.label || analysis?.materialEstimate || "Mild Steel";
  const materialSource = mfgMaterial?.materialSource || (analysis?.materialEstimate ? "ai-estimated" : "fallback-default");

  // Determine process name
  const processName =
    manufacturingIntelligence?.process?.recommended?.label ||
    analysis?.manufacturingProcess ||
    "CNC Machining";

  // Formatted date
  const dateStr = date || new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();

  // Part title
  const partTitle = compType.toUpperCase();

  return {
    partName: partTitle,
    componentType: compType,
    drawingId: drawingId || "RF-001",
    revision: String(revision || "A").toUpperCase(),
    date: dateStr,
    units: "mm",
    scale: "FIT",
    isEstimated: !isRecipeBacked,
    material: {
      name: materialName,
      source: materialSource,
      isAssumed: materialSource === "fallback-default",
    },
    manufacturingProcess: processName,
    views,
    dimensions: dims,
    recipe,
  };
}
