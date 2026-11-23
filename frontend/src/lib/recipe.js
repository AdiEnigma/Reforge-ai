import * as THREE from "three";
import { cappedLatheGeometry, extrude, gearShape, matAccent, matBody, matHighlight, matLathe, ringShape, visibleBounds, buildBevelGearGroup, buildSteppedShaftGroup } from "./geo.js";

const RECIPE_LIMITS = {
  maxProfilePoints: 200,
  maxOutlinePoints: 200,
  maxHoles: 50,
  maxPrimitives: 30,
  maxDimensionRatio: 1000,
};
const STYLES = ["revolved", "extruded", "gear", "flange", "combination"];
const PRIMITIVE_KINDS = ["box", "cylinder", "sphere", "cone", "torus"];

function num(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

export function sanitizeRecipe(analysis) {
  const raw = analysis?.geometryRecipe;
  if (!raw || typeof raw !== "object") return null;
  const recipe = {};
  recipe.style = STYLES.includes(raw.style) ? raw.style : null;

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
  const gear = {
    teeth: num(g.teeth),
    module: num(g.module),
    gearType: typeof g.gearType === "string" ? g.gearType : null,
    coneAngle: num(g.coneAngle),
    pressureAngle: num(g.pressureAngle),
    helixAngle: num(g.helixAngle),
    faceWidth: num(g.faceWidth),
    boreRadius: num(g.boreRadius),
    hubDiameter: num(g.hubDiameter),
    hubLength: num(g.hubLength),
    spokes: num(g.spokes),
  };
  if (Object.values(gear).some((v) => v != null)) recipe.gear = gear;

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
    if (recipe.flange) recipe.style = "flange";
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
  if (recipe.gear) {
    for (const key of ["module", "faceWidth", "boreRadius"]) {
      if (recipe.gear[key] != null) dims.push(Math.abs(recipe.gear[key]));
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
    if (recipe.gear) {
      for (const key of ["module", "faceWidth", "boreRadius"]) {
        if (recipe.gear[key] != null) recipe.gear[key] = clipPositive(recipe.gear[key]);
      }
    }
    for (const p of recipe.primitives || []) {
      for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]) {
        if (p[key] != null) p[key] = clipPositive(p[key]);
      }
    }
  }

  if (!recipe.style) return null;
  if (!(recipe.revolvedProfile || recipe.outline || recipe.gear || recipe.flange || recipe.primitives)) return null;
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
      stepMesh.userData = { featureId: "feature-shoulder-1", featureType: "shoulder", isHighlightOnly: true };
      stepMesh.visible = false;
      group.add(stepMesh);
    }
  }
  return group;
}

function shapeFromOutline(outline) {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0].x, outline[0].y);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i].x, outline[i].y);
  shape.closePath();
  return shape;
}

function buildExtruded(outline, holes, depth) {
  const group = new THREE.Group();
  const shape = shapeFromOutline(outline);
  for (const h of holes || []) {
    const hole = new THREE.Path();
    hole.absarc(h.cx, h.cy, h.radius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const d = depth > 0 ? depth : Math.max(1, (Math.max(...outline.map((p) => Math.abs(p.x)), ...outline.map((p) => Math.abs(p.y)))) * 0.2);
  const geo = extrude(shape, d);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = { featureId: "feature-flange-1", featureType: "flange" };
  group.add(mesh);

  // Add highlight cylinders for holes
  if (Array.isArray(holes) && holes.length > 0) {
    const isMulti = holes.length > 1;
    for (const h of holes) {
      const isCenter = Math.abs(h.cx || 0) < 0.01 && Math.abs(h.cy || 0) < 0.01;
      const featureId = (!isMulti || isCenter) ? "feature-bore-1" : "feature-mounting-holes-1";
      const featureType = (!isMulti || isCenter) ? "bore" : "mounting_hole";
      const holeGeo = new THREE.CylinderGeometry((h.radius || 0.5) * 0.98, (h.radius || 0.5) * 0.98, d * 1.05, 24);
      const holeMesh = new THREE.Mesh(holeGeo, matHighlight);
      holeMesh.rotation.x = Math.PI / 2;
      holeMesh.position.set(h.cx || 0, h.cy || 0, 0);
      holeMesh.userData = { featureId, featureType, isHighlightOnly: true };
      holeMesh.visible = false;
      group.add(holeMesh);
    }
  }
  return group;
}

function buildGearFromRecipe(gear, holes) {
  const teeth = Math.max(6, Math.min(200, Math.round(gear.teeth || 16)));
  const module = gear.module != null && gear.module > 0 ? gear.module : null;
  const faceWidth = gear.faceWidth != null && gear.faceWidth > 0 ? gear.faceWidth : null;
  const boreRadius = gear.boreRadius != null && gear.boreRadius > 0 ? gear.boreRadius : 0;
  const helixAngle = gear.helixAngle != null && gear.helixAngle > 0 ? Math.min(gear.helixAngle, 45) : 0;
  const pressureAngleDeg = gear.pressureAngle != null && gear.pressureAngle > 0 ? Math.min(45, Math.max(5, gear.pressureAngle)) : 20;

  let outerR;
  let toothHeight;
  if (module) {
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

  if (gear.gearType === "bevel" || gear.coneAngle) {
    return buildBevelGearGroup({
      teeth,
      outerRadius: outerR,
      faceWidth: height,
      coneAngleDeg: gear.coneAngle || 45,
      boreRadius: bore,
      hubRadius: gear.hubDiameter ? gear.hubDiameter / 2 : hubR,
      hubHeight: gear.hubLength || hubH,
    });
  }

  const lighteningHoles = [];
  const explicitHoles = Array.isArray(holes)
    ? holes.filter((h) => h && h.radius > 0 && Math.hypot(h.cx || 0, h.cy || 0) > 1e-6)
    : [];
  if (explicitHoles.length > 0) {
    for (const h of explicitHoles) {
      const path = new THREE.Path();
      path.absarc(h.cx || 0, h.cy || 0, h.radius, 0, Math.PI * 2, true);
      lighteningHoles.push(path);
    }
  } else if (spokes && spokes >= 3) {
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
  const shape = gearShape(teeth, outerR, toothHeight, bore, lighteningHoles, pressureAngleDeg);

  if (!helixAngle) {
    const geo = extrude(shape, height);
    geo.center();
    const mesh = new THREE.Mesh(geo, matBody);
    mesh.userData = { featureId: "feature-gear-teeth-1", featureType: "gear_teeth" };
    group.add(mesh);
  } else {
    const slices = 24;
    const sliceH = height / slices;
    const sliceGeo = extrude(shape, sliceH);
    sliceGeo.translate(0, 0, sliceH / 2);
    const pitchR = module ? (teeth * module) / 2 : outerR * 0.9;
    const totalTwist = (height * Math.tan((helixAngle * Math.PI) / 180)) / pitchR;
    for (let i = 0; i < slices; i++) {
      const mesh = new THREE.Mesh(sliceGeo, matBody);
      mesh.position.z = i * sliceH - height / 2;
      mesh.rotation.z = (i / (slices - 1)) * totalTwist;
      mesh.userData = { featureId: "feature-gear-teeth-1", featureType: "gear_teeth" };
      group.add(mesh);
    }
  }

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

export function executeRecipe(recipe) {
  const style = recipe?.style;
  let body = null;
  if (style === "flange" || (recipe?.flange != null)) {
    body = buildFlangeFromRecipe(recipe.flange, recipe.outline, recipe.holes, recipe.depth);
  } else if (style === "revolved" && recipe.revolvedProfile) {
    body = buildLathe(recipe.revolvedProfile);
  } else if (style === "extruded" && recipe.outline) {
    body = buildExtruded(recipe.outline, recipe.holes, recipe.depth);
  } else if (style === "gear" && recipe.gear) {
    body = buildGearFromRecipe(recipe.gear, recipe.holes);
  } else if (style === "combination" && recipe.primitives) {
    body = buildPrimitives(recipe.primitives);
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
