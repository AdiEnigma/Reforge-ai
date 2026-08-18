import * as THREE from "three";
import { extrude, gearShape, matAccent, matBody } from "./geo.js";

const RECIPE_LIMITS = {
  maxProfilePoints: 200,
  maxOutlinePoints: 200,
  maxHoles: 50,
  maxPrimitives: 30,
  maxDimensionRatio: 1000,
};
const STYLES = ["revolved", "extruded", "gear", "combination"];
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
    pressureAngle: num(g.pressureAngle),
    helixAngle: num(g.helixAngle),
    faceWidth: num(g.faceWidth),
    boreRadius: num(g.boreRadius),
  };
  if (Object.values(gear).some((v) => v != null)) recipe.gear = gear;

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
    if (recipe.gear) recipe.style = "gear";
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
    const clip = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(v, cap)) : v);
    for (const p of recipe.revolvedProfile || []) {
      p.z = clip(p.z);
      p.radius = clip(p.radius);
    }
    for (const pt of recipe.outline || []) {
      pt.x = clip(pt.x);
      pt.y = clip(pt.y);
    }
    for (const h of recipe.holes || []) h.radius = clip(h.radius);
    if (recipe.depth != null) recipe.depth = clip(recipe.depth);
    if (recipe.gear) {
      for (const key of ["module", "faceWidth", "boreRadius"]) {
        if (recipe.gear[key] != null) recipe.gear[key] = clip(recipe.gear[key]);
      }
    }
    for (const p of recipe.primitives || []) {
      for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]) {
        if (p[key] != null) p[key] = clip(p[key]);
      }
    }
  }

  if (!recipe.style) return null;
  if (!(recipe.revolvedProfile || recipe.outline || recipe.gear || recipe.primitives)) return null;
  return recipe;
}

function buildLathe(profile) {
  const points = profile.map((pt) => new THREE.Vector2(pt.radius, pt.z));
  const geo = new THREE.LatheGeometry(points, 48);
  return new THREE.Mesh(geo, matBody);
}

function shapeFromOutline(outline) {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0].x, outline[0].y);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i].x, outline[i].y);
  shape.closePath();
  return shape;
}

function buildExtruded(outline, holes, depth) {
  const shape = shapeFromOutline(outline);
  for (const h of holes || []) {
    const hole = new THREE.Path();
    hole.absarc(h.cx, h.cy, h.radius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const d = depth > 0 ? depth : Math.max(1, (Math.max(...outline.map((p) => Math.abs(p.x)), ...outline.map((p) => Math.abs(p.y)))) * 0.2);
  const geo = extrude(shape, d);
  geo.center();
  return new THREE.Mesh(geo, matBody);
}

function buildGearFromRecipe(gear) {
  const teeth = Math.max(6, Math.min(200, Math.round(gear.teeth || 16)));
  const module = gear.module != null && gear.module > 0 ? gear.module : null;
  const faceWidth = gear.faceWidth != null && gear.faceWidth > 0 ? gear.faceWidth : null;
  const boreRadius = gear.boreRadius != null && gear.boreRadius > 0 ? gear.boreRadius : 0;
  const helixAngle = gear.helixAngle != null && gear.helixAngle > 0 ? Math.min(gear.helixAngle, 45) : 0;

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
  const bore = boreRadius || outerR * 0.35;

  const group = new THREE.Group();
  const shape = gearShape(teeth, outerR, toothHeight, bore);

  if (!helixAngle) {
    const geo = extrude(shape, height);
    geo.center();
    group.add(new THREE.Mesh(geo, matBody));
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
      group.add(mesh);
    }
  }

  const hubR = bore * 1.7;
  const hubH = height * 0.24;
  for (const z of [1, -1]) {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, hubH, 32), matAccent);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = z * (height / 2 - hubH / 2);
    group.add(hub);
  }
  return group;
}

function buildPrimitive(p) {
  const segments = p.radialSegments || 24;
  let geo;
  switch (p.kind) {
    case "box":
      geo = new THREE.BoxGeometry(p.width || 1, p.height || 1, p.depth || 1);
      break;
    case "cylinder":
      geo = new THREE.CylinderGeometry(p.radius || 0.5, p.radius || 0.5, p.height || 1, Math.max(8, Math.min(48, segments)));
      break;
    case "sphere":
      geo = new THREE.SphereGeometry(p.radius || 0.5, Math.max(8, Math.min(32, segments)), Math.max(6, Math.min(24, Math.floor(segments / 2))));
      break;
    case "cone":
      geo = new THREE.ConeGeometry(p.radius || 0.5, p.height || 1, Math.max(8, Math.min(48, segments)));
      break;
    case "torus":
      geo = new THREE.TorusGeometry(p.radius || 0.5, p.tube || 0.15, 12, Math.max(12, Math.min(48, segments)));
      break;
    default:
      return null;
  }
  const mesh = new THREE.Mesh(geo, matAccent);
  if (p.position) mesh.position.set(p.position.x || 0, p.position.y || 0, p.position.z || 0);
  if (p.rotation) mesh.rotation.set(p.rotation.x || 0, p.rotation.y || 0, p.rotation.z || 0);
  return mesh;
}

function buildPrimitives(primitives) {
  const group = new THREE.Group();
  for (const p of primitives) {
    const mesh = buildPrimitive(p);
    if (mesh) group.add(mesh);
  }
  return group;
}

export function executeRecipe(recipe) {
  const style = recipe?.style;
  let body = null;
  if (style === "revolved" && recipe.revolvedProfile) body = buildLathe(recipe.revolvedProfile);
  else if (style === "extruded" && recipe.outline) body = buildExtruded(recipe.outline, recipe.holes, recipe.depth);
  else if (style === "gear" && recipe.gear) body = buildGearFromRecipe(recipe.gear);
  else if (style === "combination" && recipe.primitives) body = buildPrimitives(recipe.primitives);
  if (!body) return new THREE.Group();

  const box = new THREE.Box3().setFromObject(body);
  const size = new THREE.Vector3();
  box.getSize(size);
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
