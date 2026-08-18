import * as THREE from "three";
import { executeRecipe, sanitizeRecipe } from "./recipe.js";
import { extrude, gearShape, matAccent, matBody, matDark, matRim, ringShape } from "./geo.js";

export const COMPONENT_LABELS = {
  "spur gear": "SPUR GEAR",
  "cylinder/shaft": "CYLINDER / SHAFT",
  flange: "FLANGE",
  bearing: "BEARING",
  "simple bracket": "SIMPLE BRACKET",
  other: "GENERIC COMPONENT",
};

export function resolveComponentType(analysis) {
  const raw = String(analysis?.componentType || "other").toLowerCase();
  const ordered = Object.keys(COMPONENT_LABELS).sort((a, b) => b.length - a.length);
  for (const key of ordered) {
    if (raw.includes(key)) return key;
  }
  if (raw.includes("gear")) return "spur gear";
  return "other";
}

export function computeParams(analysis) {
  const dims = analysis?.dimensions || {};
  const values = [dims.outerDiameter, dims.innerDiameter, dims.height, dims.width, dims.length, dims.thickness];
  const maxDim = Math.max(1, ...values.filter((v) => typeof v === "number" && isFinite(v) && v > 0));
  const scale = 6 / maxDim;
  const s = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v * scale : null);
  return {
    type: resolveComponentType(analysis),
    scale,
    teeth: typeof analysis?.teeth === "number" && analysis.teeth > 0 ? Math.max(6, Math.round(analysis.teeth)) : null,
    outerDiameter: s(dims.outerDiameter),
    innerDiameter: s(dims.innerDiameter),
    height: s(dims.height),
    width: s(dims.width),
    length: s(dims.length),
    thickness: s(dims.thickness),
  };
}

function buildSpurGear(p) {
  const group = new THREE.Group();
  const teeth = p.teeth || 16;
  const outerR = p.outerDiameter ? p.outerDiameter / 2 : 2.8;
  const boreR = p.innerDiameter ? p.innerDiameter / 2 : outerR * 0.35;
  const height = p.height || p.thickness || outerR * 0.45;
  const toothHeight = outerR * 0.08;
  const geo = extrude(gearShape(teeth, outerR, toothHeight, boreR), height);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  group.add(mesh);
  const hubR = boreR * 1.7;
  const hubH = height * 0.24;
  for (const z of [1, -1]) {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, hubH, 32), matAccent);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = z * (height / 2 - hubH / 2);
    group.add(hub);
  }
  return group;
}

function buildCylinder(p) {
  const group = new THREE.Group();
  const outerR = p.outerDiameter ? p.outerDiameter / 2 : 1.8;
  const boreR = p.innerDiameter ? p.innerDiameter / 2 : 0;
  const height = p.height || p.length || p.thickness || outerR * 3;
  if (boreR > 0) {
    const geo = extrude(ringShape(outerR, boreR), height, false);
    geo.center();
    group.add(new THREE.Mesh(geo, matBody));
  } else {
    const geo = new THREE.CylinderGeometry(outerR, outerR, height, 48);
    geo.translate(0, 0, 0);
    group.add(new THREE.Mesh(geo, matBody));
  }
  for (const z of [1, -1]) {
    const cap = new THREE.Mesh(new THREE.TorusGeometry(outerR * 0.94, outerR * 0.06, 12, 48), matRim);
    cap.rotation.x = Math.PI / 2;
    cap.position.y = z * (height / 2);
    group.add(cap);
  }
  return group;
}

function buildFlange(p) {
  const group = new THREE.Group();
  const outerR = (p.outerDiameter || 3.4) / 2;
  const boreR = p.innerDiameter ? p.innerDiameter / 2 : outerR * 0.42;
  const flangeT = p.thickness || outerR * 0.24;
  const bossR = outerR * 0.62;
  const bossH = p.height ? Math.max(p.height - flangeT, flangeT * 0.4) : outerR * 0.4;
  const boltHoles = [];
  const boltCount = 6;
  const boltR = outerR * 0.78;
  const holeR = outerR * 0.14;
  for (let i = 0; i < boltCount; i++) {
    const a = (i / boltCount) * Math.PI * 2;
    const hole = new THREE.Path();
    hole.absarc(Math.cos(a) * boltR, Math.sin(a) * boltR, holeR, 0, Math.PI * 2, true);
    boltHoles.push(hole);
  }
  const baseGeo = extrude(ringShape(outerR, boreR, boltHoles), flangeT);
  baseGeo.center();
  const base = new THREE.Mesh(baseGeo, matBody);
  group.add(base);
  const bossGeo = extrude(ringShape(bossR, boreR), bossH);
  bossGeo.translate(0, 0, flangeT / 2 + bossH / 2);
  group.add(new THREE.Mesh(bossGeo, matAccent));
  return group;
}

function buildBearing(p) {
  const group = new THREE.Group();
  const outerR = (p.outerDiameter || 2.4) / 2;
  const boreR = p.innerDiameter ? p.innerDiameter / 2 : outerR * 0.55;
  const width = p.thickness || p.height || outerR * 0.7;
  const midR = (outerR + boreR) / 2;
  const ballR = (outerR - boreR) / 4;
  const outerRing = extrude(ringShape(outerR, midR + ballR), width);
  outerRing.center();
  group.add(new THREE.Mesh(outerRing, matDark));
  const innerRing = extrude(ringShape(midR - ballR, boreR), width);
  innerRing.center();
  group.add(new THREE.Mesh(innerRing, matBody));
  const ballCount = 10;
  for (let i = 0; i < ballCount; i++) {
    const a = (i / ballCount) * Math.PI * 2;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 20, 20), matRim);
    ball.position.set(Math.cos(a) * midR, Math.sin(a) * midR, 0);
    group.add(ball);
  }
  return group;
}

function buildBracket(p) {
  const group = new THREE.Group();
  const w = p.width || 2.6;
  const h = p.height || 2.6;
  const l = p.length || p.thickness || 0.5;
  const t = Math.min(p.thickness || 0.35, Math.min(w, h) / 2);
  const vertical = new THREE.Mesh(new THREE.BoxGeometry(t, h, l), matBody);
  vertical.position.set(0, h / 2, 0);
  group.add(vertical);
  const horizontal = new THREE.Mesh(new THREE.BoxGeometry(w, t, l), matBody);
  horizontal.position.set(0, t / 2, 0);
  group.add(horizontal);
  const gussetShape = new THREE.Shape();
  const g = Math.min(w, h) * 0.45;
  gussetShape.moveTo(0, 0);
  gussetShape.lineTo(t, 0);
  gussetShape.lineTo(0, g);
  gussetShape.closePath();
  const gussetGeo = extrude(gussetShape, l * 0.8);
  for (const side of [1, -1]) {
    const gusset = new THREE.Mesh(gussetGeo, matAccent);
    gusset.rotation.y = side === 1 ? 0 : Math.PI;
    gusset.position.set(side === 1 ? 0 : -t, side === 1 ? 0 : t, side === 1 ? l * 0.1 : -l * 0.1);
    group.add(gusset);
  }
  for (const z of [1, -1]) {
    const rivet = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, t * 1.6, 12), matRim);
    rivet.rotation.x = Math.PI / 2;
    rivet.position.set(0, h - 0.2, z * l * 0.45);
    group.add(rivet);
  }
  return group;
}

function buildGeneric(p) {
  const group = new THREE.Group();
  const w = p.width || p.length || 2.4;
  const h = p.height || 2.4;
  const d = p.thickness || p.length || 1.6;
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, matBody);
  group.add(mesh);
  const envelope = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: "#de822b" })
  );
  envelope.scale.setScalar(1.25);
  group.add(envelope);
  return group;
}

export function buildModel(analysis) {
  const p = computeParams(analysis);
  const group = new THREE.Group();
  let body;
  let label;
  const recipe = sanitizeRecipe(analysis);
  if (recipe) {
    body = executeRecipe(recipe);
    label = String(analysis?.componentType || "other").trim().toUpperCase() || COMPONENT_LABELS.other;
  } else {
    switch (p.type) {
      case "spur gear":
        body = buildSpurGear(p);
        break;
      case "cylinder/shaft":
        body = buildCylinder(p);
        break;
      case "flange":
        body = buildFlange(p);
        break;
      case "bearing":
        body = buildBearing(p);
        break;
      case "simple bracket":
        body = buildBracket(p);
        break;
      default:
        body = buildGeneric(p);
    }
    label = COMPONENT_LABELS[p.type];
  }
  body.traverse((obj) => {
    if (obj.isMesh) obj.castShadow = true;
  });
  group.add(body);
  return { group, params: p, label };
}

export function resolveLabel(analysis) {
  const raw = String(analysis?.componentType || "").trim();
  if (!raw) return COMPONENT_LABELS.other;
  const key = raw.toLowerCase();
  if (COMPONENT_LABELS[key]) return COMPONENT_LABELS[key];
  if (sanitizeRecipe(analysis)) return raw.toUpperCase();
  return COMPONENT_LABELS[resolveComponentType(analysis)];
}

export function dimensionList(analysis) {
  const dims = analysis?.dimensions || {};
  const teeth = analysis?.teeth;
  const rows = [
    { label: "OUTER Ø", value: dims.outerDiameter },
    { label: "INNER Ø", value: dims.innerDiameter },
    { label: "HEIGHT", value: dims.height },
    { label: "WIDTH", value: dims.width },
    { label: "LENGTH", value: dims.length },
    { label: "THICKNESS", value: dims.thickness },
    { label: "TEETH", value: teeth },
    { label: "MODULE", value: analysis?.module },
    { label: "HELIX ANGLE", value: analysis?.helixAngle },
  ];
  return rows.filter((row) => typeof row.value === "number" && isFinite(row.value));
}
