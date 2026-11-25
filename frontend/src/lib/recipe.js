import * as THREE from "three";
import {
  cappedLatheGeometry,
  matLathe,
  visibleBounds,
  extrude,
  gearShape,
  matAccent,
  matBody,
  matDark,
  matHighlight,
  matRim,
  ringShape,
} from "./geo.js";
import { executeGeometryProgram, generateGeometryProgram } from "./runtime-geometry-engine.js";
import { normalizeGearType } from "./gear-types.js";

const RECIPE_LIMITS = {
  maxProfilePoints: 200,
  maxOutlinePoints: 200,
  maxHoles: 50,
  maxPrimitives: 30,
  maxDimensionRatio: 1000,
  maxBalls: 120,
};
const STYLES = [
  "axial_segments",
  "extruded",
  "revolved",
  "composition",
  "gear",
  "flange",
  "bearing",
  "combination",
  "mesh",
  "compound_gear",
  "flanged_shaft",
  "pinion_shaft",
];
const PRIMITIVE_KINDS = ["box", "cylinder", "sphere", "cone", "torus"];

function num(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

function positive(value) {
  const n = num(value);
  return n != null && n > 0 ? n : null;
}

function bearingBallCount(rawBearing, analysis) {
  const candidates = [rawBearing?.ballCount, analysis?.ballCount];
  for (const candidate of candidates) {
    const n = num(candidate);
    if (n != null && n >= 3) return Math.round(n);
  }
  if (Array.isArray(analysis?.features)) {
    for (const feature of analysis.features) {
      const match = String(feature).match(/(\d+)\s*(?:rolling\s*)?balls?/i);
      if (match?.[1]) return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Normalise a bearing recipe from image-derived fields. Missing race/ball
 * values are derived from the measured outside and bore diameters, never from
 * a fixed parts catalogue.
 */
export function normalizeBearingRecipe(rawBearing, analysis) {
  if (!rawBearing || typeof rawBearing !== "object") return null;
  const dims = analysis?.dimensions && typeof analysis.dimensions === "object" ? analysis.dimensions : {};
  const outerDiameter = positive(rawBearing.outerDiameter) ?? positive(dims.outerDiameter);
  if (outerDiameter == null) return null;
  const cap = Math.max(outerDiameter * RECIPE_LIMITS.maxDimensionRatio, 1000);
  const limit = (value) => Math.max(0, Math.min(value, cap));

  let innerDiameter = positive(rawBearing.innerDiameter) ?? positive(dims.innerDiameter);
  if (innerDiameter == null || innerDiameter >= outerDiameter) innerDiameter = outerDiameter * 0.5;

  const width = positive(rawBearing.width)
    ?? positive(rawBearing.thickness)
    ?? positive(dims.thickness)
    ?? positive(dims.height)
    ?? outerDiameter * 0.25;

  let pitchDiameter = positive(rawBearing.pitchDiameter ?? rawBearing.ballCircleDiameter)
    ?? (outerDiameter + innerDiameter) / 2;
  if (pitchDiameter <= innerDiameter || pitchDiameter >= outerDiameter) {
    pitchDiameter = (outerDiameter + innerDiameter) / 2;
  }

  let ballDiameter = positive(rawBearing.ballDiameter) ?? (outerDiameter - innerDiameter) / 4;
  ballDiameter = Math.min(ballDiameter, Math.min(pitchDiameter - innerDiameter, outerDiameter - pitchDiameter) * 0.75);

  let innerRaceOuterDiameter = positive(rawBearing.innerRaceOuterDiameter)
    ?? Math.max(innerDiameter * 1.01, pitchDiameter - ballDiameter * 0.55);
  innerRaceOuterDiameter = Math.max(innerDiameter * 1.01, Math.min(innerRaceOuterDiameter, pitchDiameter));

  let outerRaceInnerDiameter = positive(rawBearing.outerRaceInnerDiameter)
    ?? Math.min(outerDiameter * 0.99, pitchDiameter + ballDiameter * 0.55);
  outerRaceInnerDiameter = Math.min(outerDiameter * 0.99, Math.max(outerRaceInnerDiameter, pitchDiameter));

  const raceGap = Math.min(pitchDiameter - innerRaceOuterDiameter, outerRaceInnerDiameter - pitchDiameter);
  ballDiameter = Math.min(ballDiameter, raceGap / 0.55);

  let rows = num(rawBearing.rows);
  rows = rows != null ? Math.max(1, Math.min(2, Math.round(rows))) : 1;
  if (rows === 2) ballDiameter = Math.min(ballDiameter, width * 0.4);

  let ballCount = bearingBallCount(rawBearing, analysis);
  if (ballCount == null && ballDiameter > 0) {
    ballCount = Math.round((Math.PI * pitchDiameter) / (ballDiameter * 1.25));
  }
  ballCount = Math.max(6, Math.min(RECIPE_LIMITS.maxBalls, Math.round(ballCount || 6)));

  const grooveDepth = positive(rawBearing.grooveDepth) ?? ballDiameter * 0.25;
  const grooveRadius = positive(rawBearing.grooveRadius) ?? ballDiameter * 0.225;
  const shieldType = ["shielded", "sealed"].includes(String(rawBearing.shieldType).toLowerCase())
    ? String(rawBearing.shieldType).toLowerCase()
    : "open";

  return {
    outerDiameter: limit(outerDiameter),
    innerDiameter: limit(innerDiameter),
    width: limit(width),
    pitchDiameter: limit(pitchDiameter),
    ballDiameter: limit(ballDiameter),
    ballCount,
    innerRaceOuterDiameter: limit(innerRaceOuterDiameter),
    outerRaceInnerDiameter: limit(outerRaceInnerDiameter),
    grooveDepth: limit(Math.min(grooveDepth, ballDiameter)),
    grooveRadius: limit(Math.min(grooveRadius, ballDiameter / 2)),
    rows,
    shieldType,
  };
}

export function sanitizeRecipe(analysis) {
  const raw = analysis?.geometryRecipe;
  if (!raw || typeof raw !== "object") return null;
  const recipe = {};
  recipe.style = STYLES.includes(raw.style) ? raw.style : null;

  // OPERATOR A: Axial Segments Extraction & Normalization
  const rawSegments = raw.axialSegments || raw.segments;
  if (Array.isArray(rawSegments) && rawSegments.length > 0) {
    const cleanSegments = [];
    for (const seg of rawSegments) {
      if (!seg || typeof seg !== "object") continue;
      const zStart = num(seg.zStart ?? seg.z_start);
      const zEnd = num(seg.zEnd ?? seg.z_end);
      const radius = num(seg.radius ?? seg.outer_radius ?? seg.outerRadius);
      if (zStart == null || zEnd == null || radius == null || radius <= 0 || zEnd <= zStart) {
        continue;
      }
      const cleanSeg = {
        zStart,
        zEnd,
        radius,
        innerRadius: Math.max(0, num(seg.innerRadius ?? seg.inner_radius ?? seg.boreRadius) || 0),
        label: String(seg.label || `Segment ${cleanSegments.length + 1}`),
      };
      const teeth = num(seg.teeth);
      if (teeth && teeth >= 3) {
        cleanSeg.teeth = Math.round(teeth);
        cleanSeg.module = num(seg.module) || (radius * 2) / (cleanSeg.teeth + 2);
        cleanSeg.helixAngle = num(seg.helixAngle ?? seg.helix_angle) || 0;
        cleanSeg.pressureAngle = num(seg.pressureAngle ?? seg.pressure_angle) || 20;
      }
      const splines = num(seg.splineCount ?? seg.spline_count);
      if (splines && splines >= 2) {
        cleanSeg.splineCount = Math.round(splines);
        cleanSeg.splineDepth = num(seg.splineDepth ?? seg.spline_depth) || radius * 0.16;
      }
      if (seg.featureType) {
        cleanSeg.featureType = String(seg.featureType);
      }
      if (seg.thread) {
        cleanSeg.thread = String(seg.thread);
      }
      const pitch = num(seg.pitch);
      if (pitch && pitch > 0) {
        cleanSeg.pitch = pitch;
        cleanSeg.starts = num(seg.starts) || 1;
        cleanSeg.lead = num(seg.lead) || cleanSeg.starts * pitch;
        cleanSeg.rootRadius = num(seg.rootRadius ?? seg.root_radius) || radius * 0.7;
        cleanSeg.featureType = cleanSeg.featureType || "worm_thread";
      }
      cleanSegments.push(cleanSeg);
    }
    if (cleanSegments.length > 0) {
      recipe.axialSegments = cleanSegments;
      if (!recipe.style || recipe.style === "mesh" || raw.operator === "axial_segments") {
        recipe.style = "axial_segments";
      }
    }
  }

  // Boolean features & multi-station modifiers
  const rawModifiers = raw.modifiers;
  if (Array.isArray(rawModifiers) && rawModifiers.length > 0) {
    recipe.modifiers = rawModifiers.filter((b) => b && typeof b === "object");
  }
  const rawBooleans = raw.booleans || raw.features;
  if (Array.isArray(rawBooleans) && rawBooleans.length > 0) {
    recipe.booleans = rawBooleans.filter((b) => b && typeof b === "object");
  }

  if (raw.style === "mesh" || raw.meshData) {
    if (raw.meshData && typeof raw.meshData === "object") {
      recipe.meshData = {
        vertices: Array.isArray(raw.meshData.vertices) ? raw.meshData.vertices : null,
        normals: Array.isArray(raw.meshData.normals) ? raw.meshData.normals : null,
        indices: Array.isArray(raw.meshData.indices) ? raw.meshData.indices : null,
        uvs: Array.isArray(raw.meshData.uvs) ? raw.meshData.uvs : null,
        features: Array.isArray(raw.meshData.features) ? raw.meshData.features : [],
        dimensions: raw.meshData.dimensions || null,
      };
      if (recipe.meshData.vertices && recipe.meshData.vertices.length >= 9) {
        // ONLY assign style to 'mesh' if no engineered style was determined
        if (!recipe.style) {
          recipe.style = "mesh";
        }
      }
    }
  }

  const profile = Array.isArray(raw.revolvedProfile) ? raw.revolvedProfile.slice(0, RECIPE_LIMITS.maxProfilePoints) : [];
  const cleanProfile = [];
  for (const pt of profile) {
    if (!pt || typeof pt !== "object") continue;
    const z = num(pt.z);
    const radius = num(pt.radius);
    if (z == null || radius == null) continue;
    cleanProfile.push({ z, radius: Math.max(0, radius) });
  }
  if (cleanProfile.length >= 2) {
    cleanProfile.sort((a, b) => a.z - b.z);
    recipe.revolvedProfile = cleanProfile;
  }

  const outline = Array.isArray(raw.outline) ? raw.outline.slice(0, RECIPE_LIMITS.maxOutlinePoints) : [];
  const cleanOutline = [];
  for (const pt of outline) {
    if (!pt || typeof pt !== "object") continue;
    const x = num(pt.x);
    const y = num(pt.y);
    if (x == null || y == null) continue;
    cleanOutline.push({ x, y });
  }
  if (cleanOutline.length >= 3) recipe.outline = cleanOutline;

  const holes = Array.isArray(raw.holes) ? raw.holes.slice(0, RECIPE_LIMITS.maxHoles) : [];
  const cleanHoles = [];
  for (const h of holes) {
    if (!h || typeof h !== "object") continue;
    const cx = num(h.cx);
    const cy = num(h.cy);
    const radius = num(h.radius);
    if (cx == null || cy == null || radius == null || radius <= 0) continue;
    cleanHoles.push({ cx, cy, radius });
  }
  if (cleanHoles.length) recipe.holes = cleanHoles;

  const depth = num(raw.depth);
  if (depth != null && depth > 0) recipe.depth = depth;

  const g = raw.gear && typeof raw.gear === "object" ? raw.gear : {};
  // The confirmed analysis is the single source of truth. If a partial recipe
  // omits the mirrored type, keep the analysis-level type so the viewer cannot
  // fall back to a silent spur reconstruction.
  const rawGearType = g.gearType ?? g.type ?? analysis?.gearType;
  let normalizedGearType = normalizeGearType(rawGearType);
  if (normalizedGearType === "unknown" && rawGearType == null) {
    const fromComponent = normalizeGearType(analysis?.componentType);
    if (fromComponent !== "unknown") normalizedGearType = fromComponent;
  }
  const rawStages = Array.isArray(g.stages) ? g.stages.slice(0, 8) : [];
  const stages = rawStages
    .map((stage) => ({
      teeth: num(stage?.teeth),
      module: num(stage?.module),
      outerDiameter: num(stage?.outerDiameter),
      faceWidth: num(stage?.faceWidth),
    }))
    .filter((stage) => stage.teeth != null || stage.outerDiameter != null);
  const innerRing = typeof g.innerRing === "boolean" ? g.innerRing : normalizedGearType === "internal";
  const gear = {
    teeth: num(g.teeth),
    module: num(g.module),
    outerDiameter: num(g.outerDiameter ?? (num(g.outerRadius) != null ? num(g.outerRadius) * 2 : null)),
    gearType: normalizedGearType === "unknown"
      ? (rawGearType || null)
      : normalizedGearType,
    coneAngle: num(g.coneAngle),
    pressureAngle: num(g.pressureAngle),
    helixAngle: num(g.helixAngle),
    faceWidth: num(g.faceWidth),
    boreRadius: num(g.boreRadius),
    hubDiameter: num(g.hubDiameter),
    hubLength: num(g.hubLength),
    spokes: num(g.spokes),
    pitch: num(g.pitch),
    starts: num(g.starts),
    lead: num(g.lead),
    rootRadius: num(g.rootRadius),
    rackLength: num(g.rackLength),
    innerRing,
    stages: stages.length ? stages : null,
  };
  if (Object.values(gear).some((v) => v != null && v !== false)) recipe.gear = gear;

  const f = raw.flange && typeof raw.flange === "object" ? raw.flange : {};
  const flange = {
    outerDiameter: num(f.outerDiameter),
    innerDiameter: num(f.innerDiameter),
    thickness: num(f.thickness),
    height: num(f.height),
    boltCount: num(f.boltCount),
    boltCircleDiameter: num(f.boltCircleDiameter),
    boltHoleDiameter: num(f.boltHoleDiameter),
    bossDiameter: num(f.bossDiameter),
    bossHeight: num(f.bossHeight),
  };
  if (Object.values(flange).some((v) => v != null)) recipe.flange = flange;

  if (raw.style === "bearing" || raw.bearing && typeof raw.bearing === "object") {
    const bearing = normalizeBearingRecipe(raw.bearing || {}, analysis);
    if (bearing) recipe.bearing = bearing;
  }

  const primitives = Array.isArray(raw.primitives) ? raw.primitives.slice(0, RECIPE_LIMITS.maxPrimitives) : [];
  const cleanPrimitives = [];
  for (const p of primitives) {
    if (!p || typeof p !== "object" || !PRIMITIVE_KINDS.includes(p.kind)) continue;
    const item = { kind: p.kind };
    for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube", "radialSegments"]) {
      const v = num(p[key]);
      if (v != null) item[key] = v;
    }
    const pos = p.position && typeof p.position === "object" ? p.position : {};
    if (num(pos.x) != null || num(pos.y) != null || num(pos.z) != null) {
      item.position = { x: num(pos.x) || 0, y: num(pos.y) || 0, z: num(pos.z) || 0 };
    }
    const rot = p.rotation && typeof p.rotation === "object" ? p.rotation : {};
    if (num(rot.x) != null || num(rot.y) != null || num(rot.z) != null) {
      item.rotation = { x: num(rot.x) || 0, y: num(rot.y) || 0, z: num(rot.z) || 0 };
    }
    cleanPrimitives.push(item);
  }
  if (cleanPrimitives.length) recipe.primitives = cleanPrimitives;

  if (!recipe.style) {
    if (recipe.bearing) recipe.style = "bearing";
    else if (recipe.flange) recipe.style = "flange";
    else if (recipe.gear) recipe.style = "gear";
    else if (recipe.revolvedProfile) recipe.style = "revolved";
    else if (recipe.outline) recipe.style = "extruded";
    else if (recipe.primitives) recipe.style = "combination";
  }

  const dims = [];
  for (const p of recipe.revolvedProfile || []) dims.push(p.z, p.radius);
  for (const pt of recipe.outline || []) dims.push(Math.abs(pt.x), Math.abs(pt.y));
  for (const h of recipe.holes || []) dims.push(h.radius);
  if (recipe.depth != null) dims.push(recipe.depth);
  if (recipe.bearing) {
    for (const key of ["outerDiameter", "innerDiameter", "width", "pitchDiameter", "ballDiameter", "innerRaceOuterDiameter", "outerRaceInnerDiameter", "grooveDepth", "grooveRadius"]) {
      if (recipe.bearing[key] != null) dims.push(Math.abs(recipe.bearing[key]));
    }
  }
  if (recipe.gear) {
    for (const key of ["module", "outerDiameter", "faceWidth", "boreRadius", "coneAngle", "pitch", "rootRadius", "rackLength"]) {
      if (recipe.gear[key] != null) dims.push(Math.abs(recipe.gear[key]));
    }
    for (const stage of recipe.gear.stages || []) {
      for (const key of ["module", "outerDiameter", "faceWidth"]) {
        if (stage[key] != null) dims.push(Math.abs(stage[key]));
      }
    }
  }
  for (const p of recipe.primitives || []) {
    for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]) {
      if (p[key] != null) dims.push(Math.abs(p[key]));
    }
  }
  const positive = dims.filter((d) => typeof d === "number" && isFinite(d) && d > 0);
  if (positive.length) {
    const sorted = [...positive].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cap = Math.max(median * RECIPE_LIMITS.maxDimensionRatio, 1000);
    // z (axial position), outline x/y and hole centres are signed coordinates:
    // clamping them to >= 0 collapses every profile that is centred on the origin.
    const clip = (v) => (typeof v === "number" && isFinite(v) ? Math.max(-cap, Math.min(v, cap)) : v);
    const clipPositive = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(v, cap)) : v);
    for (const p of recipe.revolvedProfile || []) {
      p.z = clip(p.z);
      p.radius = clipPositive(p.radius);
    }
    for (const pt of recipe.outline || []) {
      pt.x = clip(pt.x);
      pt.y = clip(pt.y);
    }
    for (const h of recipe.holes || []) {
      h.cx = clip(h.cx);
      h.cy = clip(h.cy);
      h.radius = clipPositive(h.radius);
    }
    if (recipe.depth != null) recipe.depth = clipPositive(recipe.depth);
    if (recipe.bearing) {
      for (const key of ["outerDiameter", "innerDiameter", "width", "pitchDiameter", "ballDiameter", "innerRaceOuterDiameter", "outerRaceInnerDiameter", "grooveDepth", "grooveRadius"]) {
        if (recipe.bearing[key] != null) recipe.bearing[key] = clipPositive(recipe.bearing[key]);
      }
    }
    if (recipe.gear) {
      for (const key of ["module", "outerDiameter", "faceWidth", "boreRadius", "coneAngle", "pitch", "rootRadius", "rackLength"]) {
        if (recipe.gear[key] != null) recipe.gear[key] = clip(recipe.gear[key]);
      }
      for (const stage of recipe.gear.stages || []) {
        for (const key of ["module", "outerDiameter", "faceWidth"]) {
          if (stage[key] != null) stage[key] = clip(stage[key]);
        }
      }
    }
    for (const p of recipe.primitives || []) {
      for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]) {
        if (p[key] != null) p[key] = clipPositive(p[key]);
      }
    }
  }

  if (!recipe.style) return null;
  if (!(recipe.bearing || recipe.axialSegments || recipe.revolvedProfile || recipe.outline || recipe.gear || recipe.flange || recipe.primitives || recipe.meshData)) return null;
  return recipe;
}

function buildLathe(profile) {
  const group = new THREE.Group();
  const geo = cappedLatheGeometry(profile, 64);
  if (!geo) return group;
  const mesh = new THREE.Mesh(geo, matLathe);
  mesh.userData = { featureId: "feature-shaft-1", featureType: "shaft" };
  group.add(mesh);

  // Detect steps/shoulders in profile and add highlight torus rings
  for (let i = 0; i < profile.length - 1; i++) {
    const r1 = profile[i].radius;
    const r2 = profile[i + 1].radius;
    const diff = Math.abs(r2 - r1);
    const maxR = Math.max(r1, r2, 0.1);
    if (diff >= 1.0 || diff >= 0.06 * maxR) {
      const stepR = Math.max(r1, r2);
      const stepGeo = new THREE.TorusGeometry(stepR * 0.99, Math.max(0.1, diff * 0.12), 12, 48);
      const stepMesh = new THREE.Mesh(stepGeo, matHighlight);
      stepMesh.rotation.x = Math.PI / 2;
      stepMesh.position.y = profile[i].z;
      stepMesh.userData = { featureId: `feature-shoulder-${i + 1}`, featureType: "shoulder", isHighlightOnly: true };
      stepMesh.visible = false;
      group.add(stepMesh);
    }
  }

  // Check if profile has an inner bore (min radius > 0 at end caps)
  const innerR = Math.min(profile[0]?.radius || 0, profile[profile.length - 1]?.radius || 0);
  if (innerR > 0) {
    const minZ = Math.min(...profile.map((p) => p.z));
    const maxZ = Math.max(...profile.map((p) => p.z));
    const totalZ = Math.max(maxZ - minZ, 1);
    const boreHighlight = new THREE.Mesh(
      new THREE.CylinderGeometry(innerR * 0.99, innerR * 0.99, totalZ * 1.05, 32),
      matHighlight
    );
    boreHighlight.position.y = (minZ + maxZ) / 2;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }

  return group;
}

function shapeFromOutline(outline) {
  const shape = new THREE.Shape();
  if (!Array.isArray(outline) || outline.length < 3) return shape;
  shape.moveTo(outline[0].x, outline[0].y);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i].x, outline[i].y);
  shape.closePath();
  return shape;
}

function buildExtruded(outline, holes, depth) {
  const group = new THREE.Group();
  const shape = shapeFromOutline(outline);
  const cleanHoles = Array.isArray(holes) ? holes : [];
  for (const h of cleanHoles) {
    if (h && typeof h.radius === "number" && h.radius > 0) {
      const hole = new THREE.Path();
      hole.absarc(h.cx || 0, h.cy || 0, h.radius, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
  }
  const d = depth > 0 ? depth : Math.max(1, (Math.max(...outline.map((p) => Math.abs(p.x)), ...outline.map((p) => Math.abs(p.y)))) * 0.2);
  const geo = extrude(shape, d);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = { featureId: "feature-body-1", featureType: "flange" };
  group.add(mesh);

  // Add individual highlight cylinders for every hole so they are individually inspectable
  cleanHoles.forEach((h, idx) => {
    const isCenter = Math.abs(h.cx || 0) < 0.01 && Math.abs(h.cy || 0) < 0.01;
    const maxRadius = Math.max(...cleanHoles.map((x) => x.radius || 0));
    const isLarge = h.radius >= maxRadius * 0.75;
    const featureId = (isCenter || (cleanHoles.length <= 2 && isLarge))
      ? `feature-bore-${idx + 1}`
      : `feature-mounting-holes-${idx + 1}`;
    const featureType = (isCenter || (cleanHoles.length <= 2 && isLarge)) ? "bore" : "mounting_hole";

    const holeGeo = new THREE.CylinderGeometry((h.radius || 0.5) * 0.98, (h.radius || 0.5) * 0.98, d * 1.05, 24);
    const holeMesh = new THREE.Mesh(holeGeo, matHighlight);
    holeMesh.rotation.x = Math.PI / 2;
    holeMesh.position.set(h.cx || 0, h.cy || 0, 0);
    holeMesh.userData = { featureId, featureType, isHighlightOnly: true };
    holeMesh.visible = false;
    group.add(holeMesh);
  });

  return group;
}

function buildRackGearGroup(gear, teeth, module, height) {
  const group = new THREE.Group();
  const effectiveModule = module || 2.0;
  const pitch = Math.PI * effectiveModule;
  const length = gear.rackLength > 0 ? gear.rackLength : teeth * pitch;
  const toothHeight = 2.25 * effectiveModule;
  const shape = new THREE.Shape();
  const left = -length / 2;
  const rootY = -toothHeight * 0.55;
  const tipY = toothHeight * 0.45;

  shape.moveTo(left, rootY);
  for (let i = 0; i < teeth; i++) {
    const x0 = left + i * pitch;
    shape.lineTo(x0, rootY);
    shape.lineTo(x0 + pitch * 0.18, tipY);
    shape.lineTo(x0 + pitch * 0.50, tipY);
    shape.lineTo(x0 + pitch * 0.68, rootY);
  }
  shape.lineTo(left + length, rootY);
  shape.lineTo(left + length, rootY - toothHeight * 0.9);
  shape.lineTo(left, rootY - toothHeight * 0.9);
  shape.closePath();

  const geo = extrude(shape, height);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = {
    featureId: "feature-rack-teeth-1",
    featureType: "rack_teeth",
    teeth,
    module: effectiveModule,
    rackLength: length,
  };
  group.add(mesh);
  return group;
}

function buildInternalGearGroup(gear, teeth, module, outerR, toothHeight, height) {
  const group = new THREE.Group();
  const effectiveModule = module || toothHeight / 2.25;
  const tipR = outerR;
  const ringOuterR = tipR + effectiveModule * 2.5;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, ringOuterR, 0, Math.PI * 2, false);

  const innerPoints = gearShape(teeth, tipR, toothHeight, 0).extractPoints(24).shape;
  const hole = new THREE.Path();
  const points = [...innerPoints].reverse();
  points.forEach((point, index) => {
    if (index === 0) hole.moveTo(point.x, point.y);
    else hole.lineTo(point.x, point.y);
  });
  hole.closePath();
  shape.holes.push(hole);

  const geo = extrude(shape, height);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = {
    featureId: "feature-internal-teeth-1",
    featureType: "internal_gear_teeth",
    teeth,
    module: effectiveModule,
    innerRing: true,
  };
  group.add(mesh);
  return group;
}

export function buildGearFromRecipe(gear) {
  const teeth = Math.max(6, Math.min(200, Math.round(gear.teeth || 16)));
  const module = gear.module != null && gear.module > 0 ? gear.module : null;
  const faceWidth = gear.faceWidth != null && gear.faceWidth > 0 ? gear.faceWidth : null;
  const boreRadius = gear.boreRadius != null && gear.boreRadius > 0 ? gear.boreRadius : 0;
  const helixAngle = gear.helixAngle != null && gear.helixAngle !== 0
    ? Math.max(-45, Math.min(45, gear.helixAngle))
    : 0;
  const outerDiameter = gear.outerDiameter != null && gear.outerDiameter > 0 ? gear.outerDiameter : null;
  // A missing or unconfirmed type must never silently build spur/helical teeth.
  // Render a neutral placeholder and let the confirmation flow pick the builder.
  const rawGearType = gear.gearType ?? gear.type;
  const gearType = rawGearType == null ? "unknown" : normalizeGearType(rawGearType);

  let outerR;
  let toothHeight;
  if (outerDiameter) {
    outerR = outerDiameter / 2;
    const effectiveModule = module || outerDiameter / (teeth + 2);
    toothHeight = 2.25 * effectiveModule;
  } else if (module) {
    outerR = (teeth * module) / 2 + module;
    toothHeight = 2.25 * module;
  } else {
    outerR = 2.8;
    toothHeight = outerR * 0.08;
  }
  const height = faceWidth || outerR * 0.45;
  const bore = Math.min(boreRadius, outerR * 0.9);
  const spokes = gear.spokes && gear.spokes >= 3 ? Math.round(gear.spokes) : null;
  const hubR = gear.hubDiameter != null && gear.hubDiameter > 0 ? gear.hubDiameter / 2 : (bore > 0 ? bore * 1.65 : 0);
  const hubH = gear.hubLength != null && gear.hubLength > 0 ? gear.hubLength : height * 0.28;
  const rimInnerR = outerR * 0.72;

  if (gearType === "bevel") {
    const prog = generateGeometryProgram({
      componentType: "bevel gear",
      geometryRecipe: {
        style: "gear",
        gear: {
          gearType: "bevel",
          teeth,
          outerDiameter: outerR * 2,
          faceWidth: height,
          coneAngle: gear.coneAngle || 45,
          boreRadius: bore,
          hubDiameter: gear.hubDiameter,
          hubLength: gear.hubLength,
        },
      },
    });
    return executeGeometryProgram(prog);
  }

  if (gearType === "worm") {
    const pitch = gear.pitch > 0 ? gear.pitch : Math.PI * (module || outerR * 0.14);
    const starts = Math.max(1, Math.round(gear.starts || 1));
    const rootR = gear.rootRadius > 0 ? Math.min(gear.rootRadius, outerR * 0.95) : outerR * 0.7;
    const prog = generateGeometryProgram({
      componentType: "worm gear",
      geometryRecipe: {
        style: "gear",
        gear: {
          gearType: "worm",
          pitch,
          starts,
          rootRadius: rootR,
          faceWidth: height,
          outerDiameter: outerR * 2,
        },
      },
    });
    return executeGeometryProgram(prog);
  }

  if (gearType === "rack") {
    return buildRackGearGroup(gear, teeth, module, height);
  }

  if (gearType === "internal" || gear.innerRing === true) {
    return buildInternalGearGroup(gear, teeth, module, outerR, toothHeight, height);
  }

  if (gearType === "pinion") {
    const prog = generateGeometryProgram({
      componentType: "pinion shaft",
      geometryRecipe: {
        style: "pinion_shaft",
        gear: {
          teeth,
          outerDiameter: outerR * 2,
          faceWidth: height,
          boreRadius: bore,
          helixAngle: helixAngle || (gear.helixAngle ? Number(gear.helixAngle) : 0),
        },
        shaft: {
          diameter: (bore || outerR * 0.35) * 2,
          length: Math.max(height * 3, outerR * 4),
        },
      },
    });
    return executeGeometryProgram(prog);
  }

  if (gearType === "compound" || gearType === "stepped") {
    const stages = Array.isArray(gear.stages) ? gear.stages : [];
    const first = stages[0] || {};
    const second = stages[1] || {};
    const prog = generateGeometryProgram({
      componentType: "compound gear",
      geometryRecipe: {
        style: "compound_gear",
        gear: {
          stages: [
            {
              teeth: first.teeth || teeth,
              outerDiameter: first.outerDiameter || outerR * 2,
              faceWidth: first.faceWidth || height * 0.55,
            },
            {
              teeth: second.teeth || Math.max(8, Math.round(teeth * 0.65)),
              outerDiameter: second.outerDiameter || outerR * 1.24,
              faceWidth: second.faceWidth || height * 0.45,
            },
          ],
          boreRadius: bore,
        },
      },
    });
    return executeGeometryProgram(prog);
  }

  if (gearType === "unknown") {
    // A tooth count alone does not establish a tooth form. Show a neutral
    // reconstruction and let the confirmation UI select the real builder.
    const group = new THREE.Group();
    const geo = new THREE.CylinderGeometry(outerR * 0.9, outerR * 0.9, height, 48);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, matBody);
    mesh.userData = { featureId: "feature-unconfirmed-gear-1", featureType: "unconfirmed_gear_type" };
    group.add(mesh);
    return group;
  }

  const cutouts = [];
  if (spokes && spokes >= 3) {
    const N = Math.min(24, Math.max(3, spokes));
    for (let i = 0; i < N; i++) {
      const centerA = (i / N) * Math.PI * 2;
      const halfSpan = (Math.PI / N) * 0.62;
      const a1 = centerA - halfSpan;
      const a2 = centerA + halfSpan;
      const rIn = hubR * 1.12;
      const rOut = rimInnerR * 0.95;

      const path = new THREE.Path();
      path.absarc(0, 0, rIn, a1, a2, false);
      path.absarc(0, 0, rOut, a2, a1, true);
      path.closePath();
      lighteningHoles.push(path);
    }
  }

  const group = new THREE.Group();
  const shape = gearShape(teeth, outerR, toothHeight, bore, cutouts);

  if (Math.abs(helixAngle) > 0.01) {
    // Layered twisted extrusions approximate the helix while remaining
    // compatible with three.js 0.128 (no newer post-processing APIs).
    const slices = 10;
    const sliceHeight = height / slices;
    for (let i = 0; i < slices; i++) {
      const geo = extrude(shape, sliceHeight * 1.02, false);
      geo.rotateZ((helixAngle * Math.PI / 180) * (i / (slices - 1)));
      geo.translate(0, 0, -height / 2 + i * sliceHeight);
      const mesh = new THREE.Mesh(geo, matBody);
      mesh.userData = {
        featureId: `feature-helical-tooth-${i + 1}`,
        featureType: "helical_gear_teeth",
        teeth,
        helixAngle,
      };
      group.add(mesh);
    }
  } else {
    const geo = extrude(shape, height);
    geo.center();
    const mesh = new THREE.Mesh(geo, matBody);
    mesh.userData = { featureId: "feature-gear-teeth-1", featureType: "gear_teeth", teeth };
    group.add(mesh);
  }

  if (gearType !== "flanged") {
    if (hubR > bore * 1.02 && hubH > 0) {
      const hubGeo = bore > 0
        ? extrude(ringShape(hubR, bore), hubH, false)
        : new THREE.CylinderGeometry(hubR, hubR, hubH, 32);
      if (bore > 0) {
        hubGeo.center();
      } else {
        hubGeo.rotateX(Math.PI / 2);
      }
      for (const z of [1, -1]) {
        const hub = new THREE.Mesh(hubGeo, matAccent);
        hub.position.z = z * (height / 2 + hubH / 2);
        hub.userData = { featureId: "feature-boss-1", featureType: "boss" };
        group.add(hub);
      }
    }
  } else {
    const flangeThickness = Math.max(height * 0.18, outerR * 0.08);
    const boltHoles = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const hole = new THREE.Path();
      hole.absarc(
        Math.cos(a) * outerR * 0.82,
        Math.sin(a) * outerR * 0.82,
        Math.max(outerR * 0.05, 0.4),
        0,
        Math.PI * 2,
        true
      );
      boltHoles.push(hole);
    }
    const flangeShape = ringShape(outerR * 1.12, bore, boltHoles);
    const flangeGeo = extrude(flangeShape, flangeThickness);
    flangeGeo.center();
    const flange = new THREE.Mesh(flangeGeo, matRim);
    flange.position.z = -height / 2 - flangeThickness / 2;
    flange.userData = { featureId: "feature-flange-1", featureType: "flange" };
    group.add(flange);
  }

  if (gearType === "flanged") {
    const flangeR = outerR * 1.35;
    const flangeThick = Math.max(3, height * 0.35);
    const flangeShape = ringShape(flangeR, bore);
    const flangeMesh = new THREE.Mesh(extrude(flangeShape, flangeThick, false), matBody);
    flangeMesh.position.z = -height / 2 - flangeThick / 2;
    flangeMesh.userData = { featureId: "feature-flange-1", featureType: "flange" };
    group.add(flangeMesh);
  }

  if (bore > 0) {
    const boreHighlight = new THREE.Mesh(new THREE.CylinderGeometry(bore * 0.99, bore * 0.99, (height + hubH * 2) * 1.05, 32), matHighlight);
    boreHighlight.rotation.x = Math.PI / 2;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }

  return group;
}

function buildPrimitive(p, index = 0) {
  const segments = p.radialSegments || 24;
  let geo;
  let defaultFeatureType = "other";
  switch (p.kind) {
    case "box":
      geo = new THREE.BoxGeometry(p.width || 1, p.height || 1, p.depth || 1);
      defaultFeatureType = "flange";
      break;
    case "cylinder":
      geo = new THREE.CylinderGeometry(p.radius || 0.5, p.radius || 0.5, p.height || 1, Math.max(8, Math.min(48, segments)));
      defaultFeatureType = "shaft";
      break;
    case "sphere":
      geo = new THREE.SphereGeometry(p.radius || 0.5, Math.max(8, Math.min(32, segments)), Math.max(6, Math.min(24, Math.floor(segments / 2))));
      defaultFeatureType = "other";
      break;
    case "cone":
      geo = new THREE.ConeGeometry(p.radius || 0.5, p.height || 1, Math.max(8, Math.min(48, segments)));
      defaultFeatureType = "chamfer";
      break;
    case "torus":
      geo = new THREE.TorusGeometry(p.radius || 0.5, p.tube || 0.15, 12, Math.max(12, Math.min(48, segments)));
      defaultFeatureType = "groove";
      break;
    default:
      return null;
  }
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = {
    featureId: `feature-${defaultFeatureType}-${index + 1}`,
    featureType: defaultFeatureType,
  };
  if (p.position) mesh.position.set(p.position.x || 0, p.position.y || 0, p.position.z || 0);
  if (p.rotation) mesh.rotation.set(p.rotation.x || 0, p.rotation.y || 0, p.rotation.z || 0);
  return mesh;
}

function buildPrimitives(primitives) {
  const group = new THREE.Group();
  for (let i = 0; i < primitives.length; i++) {
    const mesh = buildPrimitive(primitives[i], i);
    if (mesh) group.add(mesh);
  }
  group.userData.schematic = true;
  return group;
}

function buildFlangeFromRecipe(flange, outline, holes, depth) {
  const group = new THREE.Group();
  const od = flange?.outerDiameter || (outline ? Math.max(...outline.map((p) => Math.hypot(p.x, p.y))) * 2 : 120);
  const id = flange?.innerDiameter != null ? flange.innerDiameter : 35;
  const th = flange?.thickness || depth || 18;
  const h = flange?.height || th * 1.5;
  const outerR = od / 2;
  const boreR = id / 2;
  const bCount = Math.max(3, Math.min(64, Math.round(flange?.boltCount || 4)));
  const bcd = flange?.boltCircleDiameter || od * 0.76;
  const bhd = flange?.boltHoleDiameter || Math.max(4, od * 0.11);
  const boltR = bcd / 2;
  const holeR = bhd / 2;
  const bossR = (flange?.bossDiameter || od * 0.60) / 2;
  const bossH = flange?.bossHeight || Math.max(2, h - th);

  // Collect bolt holes (excluding center hole)
  const boltHoles = [];
  if (Array.isArray(holes) && holes.length > 1) {
    for (const hItem of holes) {
      const isCenter = Math.abs(hItem.cx || 0) < 0.01 && Math.abs(hItem.cy || 0) < 0.01;
      if (!isCenter) {
        const pathHole = new THREE.Path();
        pathHole.absarc(hItem.cx, hItem.cy, hItem.radius, 0, Math.PI * 2, true);
        boltHoles.push(pathHole);

        const holeHighlight = new THREE.Mesh(new THREE.CylinderGeometry(hItem.radius * 0.98, hItem.radius * 0.98, th * 1.08, 16), matHighlight);
        holeHighlight.rotation.x = Math.PI / 2;
        holeHighlight.position.set(hItem.cx, hItem.cy, 0);
        holeHighlight.userData = { featureId: "feature-mounting-holes-1", featureType: "mounting_hole", isHighlightOnly: true };
        holeHighlight.visible = false;
        group.add(holeHighlight);
      }
    }
  } else {
    for (let i = 0; i < bCount; i++) {
      const a = (i / bCount) * Math.PI * 2;
      const pathHole = new THREE.Path();
      pathHole.absarc(Math.cos(a) * boltR, Math.sin(a) * boltR, holeR, 0, Math.PI * 2, true);
      boltHoles.push(pathHole);

      const holeHighlight = new THREE.Mesh(new THREE.CylinderGeometry(holeR * 0.98, holeR * 0.98, th * 1.08, 16), matHighlight);
      holeHighlight.rotation.x = Math.PI / 2;
      holeHighlight.position.set(Math.cos(a) * boltR, Math.sin(a) * boltR, 0);
      holeHighlight.userData = { featureId: "feature-mounting-holes-1", featureType: "mounting_hole", isHighlightOnly: true };
      holeHighlight.visible = false;
      group.add(holeHighlight);
    }
  }

  // Base flange plate with center bore AND all bolt holes
  const baseGeo = extrude(ringShape(outerR, boreR, boltHoles), th);
  baseGeo.center();
  const baseMesh = new THREE.Mesh(baseGeo, matBody);
  baseMesh.userData = { featureId: "feature-flange-1", featureType: "flange" };
  group.add(baseMesh);

  // Central bore highlight
  if (boreR > 0) {
    const totalH = th + (bossH > 0 ? bossH : 0);
    const boreHighlight = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.99, boreR * 0.99, totalH * 1.05, 32), matHighlight);
    boreHighlight.rotation.x = Math.PI / 2;
    boreHighlight.position.z = bossH > 0 ? bossH / 2 : 0;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }

  // Raised face hub / boss
  if (bossR > boreR && bossH > 0) {
    const bossGeo = extrude(ringShape(bossR, boreR), bossH);
    bossGeo.center();
    const bossMesh = new THREE.Mesh(bossGeo, matAccent);
    bossMesh.position.z = th / 2 + bossH / 2;
    bossMesh.userData = { featureId: "feature-boss-1", featureType: "boss" };
    group.add(bossMesh);
  }

  return group;
}

function buildMeshFromRecipe(meshData) {
  const group = new THREE.Group();
  if (!meshData || !Array.isArray(meshData.vertices) || meshData.vertices.length < 9) {
    return group;
  }

  const geo = new THREE.BufferGeometry();
  const vertices = new Float32Array(meshData.vertices);
  geo.setAttribute("position", new THREE.BufferAttribute(vertices, 3));

  if (Array.isArray(meshData.indices) && meshData.indices.length >= 3) {
    geo.setIndex(meshData.indices);
  }

  if (Array.isArray(meshData.normals) && meshData.normals.length === meshData.vertices.length) {
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(meshData.normals), 3));
  } else {
    geo.computeVertexNormals();
  }

  geo.computeBoundingBox();
  if (geo.boundingBox) {
    const sz = new THREE.Vector3();
    geo.boundingBox.getSize(sz);
    // If component is elongated along Z (shafts, pinion shafts, flanged shafts):
    // Lay it horizontally along X to match standard ReForge CAD isometric perspective
    if (sz.z > sz.x * 1.25 && sz.z > sz.y * 1.25) {
      geo.rotateY(Math.PI / 2);
      geo.computeVertexNormals();
    }
  }

  geo.computeBoundingBox();
  geo.center();
  geo.computeVertexNormals();

  const mainMesh = new THREE.Mesh(geo, matBody);
  mainMesh.userData = { featureId: "feature-body-1", featureType: "other" };
  group.add(mainMesh);

  // Sharp technical CAD edges (threshold 35 deg avoids triangulated facet noise on curved walls)
  const edgesGeo = new THREE.EdgesGeometry(geo, 35);
  const edgesMat = new THREE.LineBasicMaterial({ color: "#181410", linewidth: 1 });
  edgesMat.userData.appearanceRole = 'edges';
  const edgesLine = new THREE.LineSegments(edgesGeo, edgesMat);
  group.add(edgesLine);

  // Highlight proxies for individual features (bores, holes, mounting faces)
  if (Array.isArray(meshData.features)) {
    for (const feat of meshData.features) {
      if (!feat || !feat.id) continue;
      const fType = feat.type || "other";
      if (fType === "bore" || fType === "mounting_hole") {
        const radius = Number(feat.radius) || 10;
        const depth = Number(feat.depth) || 20;
        const cx = Number(feat.cx) || 0;
        const cy = Number(feat.cy) || 0;
        const cz = Number(feat.cz) || 0;
        const cyl = new THREE.Mesh(
          new THREE.CylinderGeometry(radius * 0.99, radius * 0.99, depth * 1.05, 24),
          matHighlight
        );
        cyl.rotation.x = Math.PI / 2;
        cyl.position.set(cx, cy, cz);
        cyl.userData = { featureId: feat.id, featureType: fType, isHighlightOnly: true };
        cyl.visible = false;
        group.add(cyl);
      } else if (fType === "mounting_face" || fType === "face") {
        const w = Number(feat.width) || 30;
        const h = Number(feat.height) || 20;
        const cx = Number(feat.cx) || 0;
        const cy = Number(feat.cy) || 0;
        const cz = Number(feat.cz) || 0;
        const plane = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, 2),
          matHighlight
        );
        plane.position.set(cx, cy, cz);
        plane.userData = { featureId: feat.id, featureType: "face", isHighlightOnly: true };
        plane.visible = false;
        group.add(plane);
      }
    }
  }

  return group;
}

const matShield = new THREE.MeshStandardMaterial({
  color: "#8a939c",
  metalness: 0.85,
  roughness: 0.32,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
  side: THREE.DoubleSide,
});

export function buildBearingFromRecipe(rawBearing, analysis) {
  const b = normalizeBearingRecipe(rawBearing, analysis);
  if (!b) return null;

  const group = new THREE.Group();
  const outerR = b.outerDiameter / 2;
  const boreR = b.innerDiameter / 2;
  const pitchR = b.pitchDiameter / 2;
  const ballR = Math.max(0.01, b.ballDiameter / 2);
  const innerRaceR = b.innerRaceOuterDiameter / 2;
  const outerRaceR = b.outerRaceInnerDiameter / 2;
  const grooveTube = Math.max(0.01, Math.min(b.grooveRadius, b.grooveDepth));

  const outerGeometry = extrude(ringShape(outerR, outerRaceR), b.width);
  outerGeometry.center();
  const outerRace = new THREE.Mesh(outerGeometry, matDark);
  outerRace.userData = { featureId: "feature-bearing-outer-race", featureType: "outer_race", bearingRole: "outer_race" };
  group.add(outerRace);

  const innerGeometry = extrude(ringShape(innerRaceR, boreR), b.width);
  innerGeometry.center();
  const innerRace = new THREE.Mesh(innerGeometry, matBody);
  innerRace.userData = { featureId: "feature-bearing-inner-race", featureType: "inner_race", bearingRole: "inner_race" };
  group.add(innerRace);

  const rowZs = b.rows === 2 ? [-b.width * 0.22, b.width * 0.22] : [0];
  const ballsPerRow = Math.ceil(b.ballCount / rowZs.length);
  for (let row = 0; row < rowZs.length; row += 1) {
    for (const [radius, role] of [[innerRaceR, "inner_race"], [outerRaceR, "outer_race"]]) {
      const groove = new THREE.Mesh(new THREE.TorusGeometry(radius, grooveTube, 10, 72), matDark);
      groove.position.z = rowZs[row];
      groove.userData = {
        featureId: `feature-bearing-groove-${role}-${row + 1}`,
        featureType: "groove",
        bearingRole: "groove",
      };
      group.add(groove);
    }
    for (let i = 0; i < ballsPerRow; i += 1) {
      const angle = (i / ballsPerRow) * Math.PI * 2 + (row % 2 ? Math.PI / ballsPerRow : 0);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 24, 16), matRim);
      ball.position.set(Math.cos(angle) * pitchR, Math.sin(angle) * pitchR, rowZs[row]);
      ball.userData = {
        featureId: `feature-bearing-ball-${row + 1}-${i + 1}`,
        featureType: "ball_bearing",
        bearingRole: "ball",
        ballIndex: i,
        row,
      };
      group.add(ball);
    }
  }

  if (b.shieldType !== "open") {
    const shieldGeometry = extrude(ringShape(outerR * 0.94, boreR * 1.15), Math.max(0.01, b.width * 0.04));
    shieldGeometry.center();
    for (const side of [-1, 1]) {
      const shield = new THREE.Mesh(shieldGeometry, matShield);
      shield.position.z = side * b.width * 0.52;
      shield.userData = {
        featureId: `feature-bearing-shield-${side > 0 ? "front" : "back"}`,
        featureType: "shield",
        bearingRole: "shield",
      };
      group.add(shield);
    }
  }

  const boreHighlight = new THREE.Mesh(
    new THREE.CylinderGeometry(boreR * 0.99, boreR * 0.99, b.width * 1.05, 48),
    matHighlight
  );
  boreHighlight.userData = { featureId: "feature-bearing-bore", featureType: "bore", isHighlightOnly: true };
  boreHighlight.visible = false;
  group.add(boreHighlight);

  group.userData.bearing = b;
  return group;
}

export function executeRecipe(recipe) {
  const style = recipe?.style;
  let body = null;

  // Dedicated bearing recipe: preserves the image-derived races, bore and
  // rolling-ball count instead of routing a bearing through a gear template.
  if (style === "bearing" && recipe?.bearing) {
    body = buildBearingFromRecipe(recipe.bearing);

  // Runtime Geometry Engine Execution (Non-categorical declarative AST)
  } else if (style === "axial_segments" || (Array.isArray(recipe?.axialSegments) && recipe.axialSegments.length > 0)) {
    const prog = generateGeometryProgram({ geometryRecipe: recipe });
    body = executeGeometryProgram(prog);
  } else if (style === "compound_gear" || (recipe?.gear?.stages && recipe.gear.stages.length >= 2)) {
    const prog = generateGeometryProgram({ geometryRecipe: recipe });
    body = executeGeometryProgram(prog);
  } else if (
    style === "pinion_shaft" ||
    (recipe?.shaft && recipe?.gear && (recipe.shaft.length || 0) > (recipe.gear.faceWidth || 0))
  ) {
    const prog = generateGeometryProgram({ geometryRecipe: recipe });
    body = executeGeometryProgram(prog);
  } else if (style === "flanged_shaft" || (recipe?.shaft && recipe?.flange)) {
    const prog = generateGeometryProgram({ geometryRecipe: recipe });
    body = executeGeometryProgram(prog);
  } else if (style === "cap_bushing" || style === "cap" || recipe?.capBushing) {
    const prog = generateGeometryProgram({ componentType: "cap/bushing", geometryRecipe: recipe });
    body = executeGeometryProgram(prog);
  } else if (style === "bearing" || recipe?.bearing) {
    const prog = generateGeometryProgram({ componentType: "bearing", geometryRecipe: recipe });
    body = executeGeometryProgram(prog);
  } else if (style === "flange" || (recipe?.flange != null)) {
    body = buildFlangeFromRecipe(recipe.flange, recipe.outline, recipe.holes, recipe.depth);
  } else if (style === "revolved" && recipe.revolvedProfile) {
    body = buildLathe(recipe.revolvedProfile);
  } else if (style === "extruded" && recipe.outline) {
    body = buildExtruded(recipe.outline, recipe.holes, recipe.depth);
  } else if (style === "gear" && recipe.gear) {
    body = buildGearFromRecipe(recipe.gear, recipe.holes);
  } else if (style === "combination" && recipe.primitives) {
    body = buildPrimitives(recipe.primitives);
  } else if (recipe?.meshData && Array.isArray(recipe.meshData.vertices) && recipe.meshData.vertices.length >= 9) {
    body = buildMeshFromRecipe(recipe.meshData);
  }
  if (!body) return null;
  let meshCount = 0;
  body.traverse((node) => { if (node.isMesh) meshCount += 1; });
  if (!meshCount) return null;
  body.userData.recipeStyle = style;

  const box = visibleBounds(body);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (box.isEmpty()) return null;
  const maxDim = Math.max(size.x, size.y, size.z);
  if (isFinite(maxDim) && maxDim > 0.0001) {
    const scale = 6 / maxDim;
    const center = new THREE.Vector3();
    box.getCenter(center);
    body.scale.setScalar(scale);
    body.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  }
  return body;
}
