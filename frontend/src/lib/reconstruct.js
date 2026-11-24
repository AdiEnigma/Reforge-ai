import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { buildGearFromRecipe, executeRecipe, sanitizeRecipe } from "./recipe.js";
import { normalizeGearType } from "./gear-types.js";
import { extrude, gearShape, matAccent, matBody, matDark, matRim, matHighlight, ringShape, buildBevelGearGroup, buildSteppedShaftGroup, buildCompoundGearGroup, buildFlangedShaftGroup, buildPinionShaftGroup, buildCapBushingGroup } from "./geo.js";

// Built geometry is immutable for a given analysis object. Validation and each
// viewport previously rebuilt the same meshes from scratch; share the geometry
// and clone only the lightweight Object3D wrappers per consumer.
const modelCache = new WeakMap();

function visibleBounds(object) {
  const box = new THREE.Box3();
  if (!object) return box;
  object.updateWorldMatrix(true, true);
  object.traverse((node) => {
    if (!node.visible || !node.isMesh || !node.geometry) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    if (!node.geometry.boundingBox) return;
    const meshBox = node.geometry.boundingBox.clone();
    meshBox.applyMatrix4(node.matrixWorld);
    box.union(meshBox);
  });
  return box;
}

export const COMPONENT_LABELS = {
  "pinion shaft": "HELICAL PINION SHAFT",
  "compound gear": "COMPOUND GEAR",
  "flanged shaft": "FLANGED SPLINE SHAFT",
  "bevel gear": "BEVEL GEAR",
  "stepped shaft": "STEPPED SHAFT",
  "cap/bushing": "CIRCULAR CAP / BUSHING",
  "spur gear": "SPUR GEAR",
  "helical gear": "HELICAL GEAR",
  "worm gear": "WORM GEAR",
  "rack gear": "RACK GEAR",
  "internal gear": "INTERNAL GEAR",
  "stepped gear": "STEPPED GEAR",
  "flanged gear": "FLANGED GEAR",
  "gear (type unconfirmed)": "GEAR TYPE UNCONFIRMED",
  "cylinder/shaft": "CYLINDER / SHAFT",
  flange: "FLANGE",
  bearing: "BEARING",
  "simple bracket": "SIMPLE BRACKET",
  other: "GENERIC COMPONENT",
};

export function resolveComponentType(analysis) {
  const raw = String(analysis?.componentType || "other").toLowerCase();
  const featuresStr = Array.isArray(analysis?.features) ? analysis.features.map(f => String(f).toLowerCase()).join(" ") : "";
  const rawGearType = analysis?.gearType ?? analysis?.geometryRecipe?.gear?.gearType;
  const gearType = normalizeGearType(rawGearType);
  const hasExplicitGearType = rawGearType != null;
  const isGear = raw.includes("gear") || featuresStr.includes("gear") || featuresStr.includes("teeth") || (typeof analysis?.teeth === "number" && analysis.teeth > 0) || gearType !== "unknown" || analysis?.geometryRecipe?.style === "gear" || analysis?.geometryRecipe?.gear;

  // 1. Detect Compound / Cluster Multi-Stage Gear (EXCLUDE pinion shafts and single gears)
  const isExplicitPinionShaft =
    raw.includes("pinion shaft") ||
    raw.includes("gear shaft") ||
    raw.includes("helical shaft") ||
    featuresStr.includes("pinion shaft") ||
    featuresStr.includes("gear shaft");

  if (
    isGear &&
    !isExplicitPinionShaft &&
    gearType !== "stepped" &&
    (raw.includes("compound") ||
      raw.includes("cluster") ||
      raw.includes("double gear") ||
      raw.includes("dual gear") ||
      raw.includes("two-stage") ||
      raw.includes("two stage") ||
      featuresStr.includes("compound") ||
      featuresStr.includes("cluster") ||
      featuresStr.includes("two-stage") ||
      featuresStr.includes("double gear") ||
      featuresStr.includes("dual gear") ||
      gearType === "compound" ||
      (analysis?.geometryRecipe?.gear?.stages && analysis.geometryRecipe.gear.stages.length >= 2))
  ) {
    return "compound gear";
  }

  if (isGear && gearType === "pinion") {
    return "pinion shaft";
  }

  // 2. Detect Integral Pinion Shaft / Gear Shaft
  const pinionCompatible = ["unknown", "spur", "helical", "pinion"].includes(gearType);
  if (
    isGear &&
    pinionCompatible &&
    (isExplicitPinionShaft ||
      (analysis?.geometryRecipe?.shaft && analysis?.geometryRecipe?.gear) ||
      ((analysis?.dimensions?.length || analysis?.dimensions?.height || 0) >= ((analysis?.dimensions?.outerDiameter || 30) * 1.5) &&
        (raw.includes("shaft") || featuresStr.includes("bearing journal") || featuresStr.includes("ground journal"))))
  ) {
    return "pinion shaft";
  }

  // 3. Detect Flanged Shaft / Linear Spline Bushing
  if (
    (raw.includes("flanged") && raw.includes("shaft")) ||
    raw.includes("ball spline") ||
    raw.includes("spline bushing") ||
    raw.includes("linear shaft") ||
    analysis?.geometryRecipe?.style === "flanged_shaft" ||
    ((raw.includes("flange") || featuresStr.includes("bolt hole") || featuresStr.includes("mounting hole")) &&
      (raw.includes("spline") || (raw.includes("shaft") && !raw.includes("shaft bore")) || featuresStr.includes("spline")))
  ) {
    return "flanged shaft";
  }

  // 4. Detect Bevel Gear
  if (
    isGear &&
    (raw.includes("bevel") ||
      raw.includes("miter") ||
      raw.includes("conical") ||
      gearType === "bevel" ||
      featuresStr.includes("bevel") ||
      featuresStr.includes("miter") ||
      featuresStr.includes("conical"))
  ) {
    return "bevel gear";
  }

  // 5. Prefer explicit tooth-form evidence over generic helix-angle hints.
  if (isGear && (raw.includes("worm") || gearType === "worm")) {
    return "worm gear";
  }
  if (isGear && (raw.includes("rack") || gearType === "rack")) {
    return "rack gear";
  }
  if (isGear && (raw.includes("internal") || raw.includes("annular") || gearType === "internal")) {
    return "internal gear";
  }
  if (isGear && gearType === "stepped") {
    return "stepped gear";
  }
  if (isGear && gearType === "flanged" && !isExplicitPinionShaft) {
    return "flanged gear";
  }
  if (isGear && (raw.includes("helical") || gearType === "helical" || (!hasExplicitGearType && typeof analysis?.helixAngle === "number" && analysis.helixAngle > 0))) {
    return "helical gear";
  }

  // 6. Detect Spur Gear only from explicit evidence. An uncounted tooth form
  // stays unconfirmed instead of being silently rebuilt as a spur gear.
  if (isGear) {
    return gearType === "spur" || raw.includes("spur") || featuresStr.includes("straight teeth") ? "spur gear" : "gear (type unconfirmed)";
  }

  // 7. Detect Circular Cap / Bushing / Sleeve (avoid false-positive stepped shafts)
  const isCapOrBushing =
    raw.includes("cap") ||
    raw.includes("bushing") ||
    raw.includes("cup") ||
    raw.includes("plug") ||
    raw.includes("sleeve") ||
    raw.includes("bottle");
  if (isCapOrBushing) {
    return "cap/bushing";
  }

  // 8. Detect Stepped Shaft / Spindle (ONLY if NOT a gear and NOT a flanged shaft!)
  if (
    !isGear &&
    (raw.includes("step") ||
      raw.includes("spindle") ||
      (raw.includes("shaft") && !raw.includes("crank") && !raw.includes("shaft bore")) ||
      featuresStr.includes("shoulder") ||
      featuresStr.includes("bearing journal") ||
      (analysis?.geometryRecipe?.style === "revolved" &&
        Array.isArray(analysis?.geometryRecipe?.revolvedProfile) &&
        analysis.geometryRecipe.revolvedProfile.length >= 4 &&
        ((analysis?.dimensions?.length || analysis?.dimensions?.height || 20) >= (analysis?.dimensions?.outerDiameter || 30) * 0.8)))
  ) {
    return "stepped shaft";
  }

  const ordered = Object.keys(COMPONENT_LABELS).sort((a, b) => b.length - a.length);
  for (const key of ordered) {
    if (raw.includes(key)) return key;
  }
  if (raw.includes("shaft") || raw.includes("cylinder") || (analysis?.geometryRecipe?.style === "revolved" && !raw.includes("bracket"))) {
    return "cylinder/shaft";
  }
  if (raw.includes("flange")) return "flange";
  if (raw.includes("bearing")) return "bearing";
  if (
    raw.includes("bracket") ||
    raw.includes("lever") ||
    raw.includes("arm") ||
    raw.includes("rod") ||
    raw.includes("link") ||
    raw.includes("plate") ||
    raw.includes("mount") ||
    raw.includes("housing") ||
    analysis?.geometryRecipe?.style === "extruded"
  ) {
    return "simple bracket";
  }
  return "other";
}

export function computeParams(analysis) {
  const dims = analysis?.dimensions || {};
  const values = [dims.outerDiameter, dims.innerDiameter, dims.height, dims.width, dims.length, dims.thickness];
  const maxDim = Math.max(1, ...values.filter((v) => typeof v === "number" && isFinite(v) && v > 0));
  const scale = 6 / maxDim;
  const s = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v * scale : null);

  let boltCount = null;
  if (typeof analysis?.boltCount === "number" && analysis.boltCount >= 3) {
    boltCount = Math.round(analysis.boltCount);
  } else if (analysis?.geometryRecipe?.flange?.boltCount) {
    boltCount = Math.round(analysis.geometryRecipe.flange.boltCount);
  } else if (Array.isArray(analysis?.features)) {
    for (const f of analysis.features) {
      const match = String(f).match(/(\d+)\s*(?:bolt|mounting|mount|fastener|screw|drilled|\s)*holes?/i);
      if (match && match[1]) {
        boltCount = parseInt(match[1], 10);
        break;
      }
    }
  }

  let spokeCount = null;
  if (typeof analysis?.spokes === "number" && analysis.spokes >= 3) {
    spokeCount = Math.round(analysis.spokes);
  } else if (typeof analysis?.spokeCount === "number" && analysis.spokeCount >= 3) {
    spokeCount = Math.round(analysis.spokeCount);
  } else if (typeof analysis?.geometryRecipe?.gear?.spokes === "number") {
    spokeCount = Math.round(analysis.geometryRecipe.gear.spokes);
  } else if (Array.isArray(analysis?.features)) {
    for (const f of analysis.features) {
      const match = String(f).match(/(\d+)\s*(?:spoke|cutout|window|pocket|arm)/i);
      if (match && match[1]) {
        spokeCount = parseInt(match[1], 10);
        break;
      }
      if (/spoke|lightening\s*cutout|web\s*pocket/i.test(String(f))) {
        spokeCount = 6;
      }
    }
  }

  return {
    type: resolveComponentType(analysis),
    scale,
    teeth: typeof analysis?.teeth === "number" && analysis.teeth > 0 ? Math.max(6, Math.round(analysis.teeth)) : null,
    boltCount: boltCount || 4,
    spokes: spokeCount,
    coneAngle: typeof analysis?.coneAngle === "number" ? analysis.coneAngle : (analysis?.geometryRecipe?.gear?.coneAngle || 45),
    gearType: normalizeGearType(analysis?.gearType || analysis?.geometryRecipe?.gear?.gearType),
    helixAngle: analysis?.helixAngle ?? analysis?.geometryRecipe?.gear?.helixAngle ?? 0,
    module: analysis?.module ?? analysis?.geometryRecipe?.gear?.module ?? null,
    pitch: analysis?.pitch ?? analysis?.geometryRecipe?.gear?.pitch ?? null,
    starts: analysis?.starts ?? analysis?.geometryRecipe?.gear?.starts ?? null,
    requiresGearTypeConfirmation: Boolean(analysis?.requiresGearTypeConfirmation),
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
  const boreR = p.innerDiameter ? p.innerDiameter / 2 : 0;
  const height = p.height || p.thickness || outerR * 0.45;
  const toothHeight = outerR * 0.08;
  const hubR = boreR * 1.65;
  const hubH = height * 0.28;
  const rimInnerR = outerR * 0.72;

  const cutouts = [];
  const spokes = p.spokes || (p.spokeCount ? p.spokeCount : null);
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
      cutouts.push(path);
    }
  }

  const geo = extrude(gearShape(teeth, outerR, toothHeight, boreR, cutouts), height);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = { featureId: "feature-gear-teeth-1", featureType: "gear_teeth" };
  group.add(mesh);

  if (boreR > 0 && hubR > boreR * 1.02) {
    const hubGeo = extrude(ringShape(hubR, boreR), hubH, false);
    hubGeo.center();
    for (const z of [1, -1]) {
      const hub = new THREE.Mesh(hubGeo, matAccent);
      hub.position.z = z * (height / 2 + hubH / 2);
      hub.userData = { featureId: "feature-boss-1", featureType: "boss" };
      group.add(hub);
    }
  }
  if (boreR > 0) {
    const boreHighlight = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.99, boreR * 0.99, (height + hubH * 2) * 1.05, 32), matHighlight);
    boreHighlight.rotation.x = Math.PI / 2;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
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
    const mesh = new THREE.Mesh(geo, matBody);
    mesh.userData = { featureId: "feature-shaft-1", featureType: "shaft" };
    group.add(mesh);

    const boreHighlight = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.99, boreR * 0.99, height * 1.05, 32), matHighlight);
    boreHighlight.rotation.x = Math.PI / 2;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  } else {
    const geo = new THREE.CylinderGeometry(outerR, outerR, height, 48);
    const mesh = new THREE.Mesh(geo, matBody);
    mesh.userData = { featureId: "feature-shaft-1", featureType: "shaft" };
    group.add(mesh);
  }
  for (const z of [1, -1]) {
    const cap = new THREE.Mesh(new THREE.TorusGeometry(outerR * 0.94, outerR * 0.06, 12, 48), matRim);
    cap.rotation.x = Math.PI / 2;
    cap.position.y = z * (height / 2);
    cap.userData = { featureId: "feature-chamfer-1", featureType: "chamfer" };
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
  const boltCount = Math.max(3, Math.min(64, Math.round(p.boltCount || 4)));
  const boltR = outerR * 0.78;
  const holeR = outerR * 0.12;
  for (let i = 0; i < boltCount; i++) {
    const a = (i / boltCount) * Math.PI * 2;
    const hole = new THREE.Path();
    hole.absarc(Math.cos(a) * boltR, Math.sin(a) * boltR, holeR, 0, Math.PI * 2, true);
    boltHoles.push(hole);

    const holeHighlight = new THREE.Mesh(new THREE.CylinderGeometry(holeR * 0.98, holeR * 0.98, flangeT * 1.08, 16), matHighlight);
    holeHighlight.rotation.x = Math.PI / 2;
    holeHighlight.position.set(Math.cos(a) * boltR, Math.sin(a) * boltR, 0);
    holeHighlight.userData = { featureId: "feature-mounting-holes-1", featureType: "mounting_hole", isHighlightOnly: true };
    holeHighlight.visible = false;
    group.add(holeHighlight);
  }
  const baseGeo = extrude(ringShape(outerR, boreR, boltHoles), flangeT);
  baseGeo.center();
  const base = new THREE.Mesh(baseGeo, matBody);
  base.userData = { featureId: "feature-flange-1", featureType: "flange" };
  group.add(base);

  const bossGeo = extrude(ringShape(bossR, boreR), bossH);
  bossGeo.translate(0, 0, flangeT / 2 + bossH / 2);
  const boss = new THREE.Mesh(bossGeo, matAccent);
  boss.userData = { featureId: "feature-boss-1", featureType: "boss" };
  group.add(boss);

  if (boreR > 0) {
    const totalH = flangeT + bossH;
    const boreHighlight = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.99, boreR * 0.99, totalH * 1.05, 32), matHighlight);
    boreHighlight.position.z = bossH / 2;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }
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
  const outerMesh = new THREE.Mesh(outerRing, matDark);
  outerMesh.userData = { featureId: "feature-flange-1", featureType: "flange" };
  group.add(outerMesh);

  const innerRing = extrude(ringShape(midR - ballR, boreR), width);
  innerRing.center();
  const innerMesh = new THREE.Mesh(innerRing, matBody);
  innerMesh.userData = { featureId: "feature-bore-1", featureType: "bore" };
  group.add(innerMesh);

  const ballCount = 10;
  for (let i = 0; i < ballCount; i++) {
    const a = (i / ballCount) * Math.PI * 2;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 20, 20), matRim);
    ball.position.set(Math.cos(a) * midR, Math.sin(a) * midR, 0);
    ball.userData = { featureId: "feature-groove-1", featureType: "groove" };
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
  vertical.userData = { featureId: "feature-flange-1", featureType: "flange" };
  group.add(vertical);

  const horizontal = new THREE.Mesh(new THREE.BoxGeometry(w, t, l), matBody);
  horizontal.position.set(0, t / 2, 0);
  horizontal.userData = { featureId: "feature-flange-1", featureType: "flange" };
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
    gusset.userData = { featureId: "feature-fillet-1", featureType: "fillet" };
    group.add(gusset);
  }
  for (const z of [1, -1]) {
    const rivet = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, t * 1.6, 12), matRim);
    rivet.rotation.x = Math.PI / 2;
    rivet.position.set(0, h - 0.2, z * l * 0.45);
    rivet.userData = { featureId: "feature-mounting-holes-1", featureType: "mounting_hole" };
    group.add(rivet);
  }
  return group;
}

function buildGeneric(p) {
  const group = new THREE.Group();
  const w = p.width || 2.4;
  const l = p.length || w * 1.5;
  const t = p.thickness || p.height || 0.6;
  const boreR = p.innerDiameter ? p.innerDiameter / 2 : 0;

  const shape = new THREE.Shape();
  const hw = w / 2;
  const hl = l / 2;
  shape.moveTo(-hl, -hw);
  shape.lineTo(hl, -hw);
  shape.lineTo(hl, hw);
  shape.lineTo(-hl, hw);
  shape.closePath();

  if (boreR > 0 && boreR < Math.min(hw, hl)) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, boreR, 0, Math.PI * 2, true);
    shape.holes.push(hole);

    const boreHighlight = new THREE.Mesh(
      new THREE.CylinderGeometry(boreR * 0.98, boreR * 0.98, t * 1.05, 32),
      matHighlight
    );
    boreHighlight.rotation.x = Math.PI / 2;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }

  const geo = extrude(shape, t);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = { featureId: "feature-body-1", featureType: "other" };
  group.add(mesh);
  const envelope = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: "#de822b" })
  );
  envelope.scale.setScalar(1.25);
  group.add(envelope);
  group.userData.schematic = true;
  return group;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Render the actual retrieved STL instead of a parametric approximation when
 * the dataset service supplied a validated viewer mesh.
 */
function buildRetrievedDatasetMesh(analysis) {
  const base64 = analysis?.datasetModel?.viewerMeshBase64;
  if (typeof base64 !== "string" || base64.length < 100) return null;
  try {
    const geometry = new STLLoader().parse(base64ToArrayBuffer(base64));
    if (!geometry || !geometry.getAttribute("position") || geometry.getAttribute("position").count === 0) {
      return null;
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, matBody);
    mesh.userData = {
      featureId: "feature-retrieved-dataset-mesh",
      featureType: "retrieved_dataset_geometry",
      source: analysis.datasetModel.assetId || "dataset",
    };
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  } catch (error) {
    console.warn("Could not parse retrieved dataset mesh:", error?.message || error);
    return null;
  }
}

export function buildModel(analysis) {
  if (analysis && typeof analysis === 'object') {
    const cached = modelCache.get(analysis);
    if (cached) return { ...cached, group: cached.group.clone(true) };
  }

  const p = computeParams(analysis);
  const group = new THREE.Group();
  let body = null;
  let label;
  const recipe = sanitizeRecipe(analysis);
  const retrievedMesh = buildRetrievedDatasetMesh(analysis);

  // Detect trivial single-box fallback that Gemini returns when it can't determine geometry
  const isTrivialBoxFallback =
    recipe &&
    recipe.style === "combination" &&
    Array.isArray(recipe.primitives) &&
    recipe.primitives.length === 1 &&
    recipe.primitives[0].kind === "box";

  // Check if component is an extruded planar / prismatic part with a valid outline
  const isCustomExtruded =
    recipe &&
    (recipe.style === "extruded" || (Array.isArray(recipe.outline) && recipe.outline.length >= 3)) &&
    !isTrivialBoxFallback;

  const rawType = String(analysis?.componentType || "").toLowerCase();
  const featuresStr = Array.isArray(analysis?.features) ? analysis.features.map(f => String(f).toLowerCase()).join(" ") : "";
  const isGear = p.type === "compound gear" || p.type === "pinion shaft" || p.type === "bevel gear" || p.type === "helical gear" || p.type === "spur gear" || p.type === "worm gear" || rawType.includes("gear") || featuresStr.includes("gear") || featuresStr.includes("teeth") || (typeof analysis?.teeth === "number" && analysis.teeth > 0) || recipe?.gear != null;

  // Detect if component is Pinion Shaft / Gear Shaft
  const isPinionShaft =
    p.type === "pinion shaft" ||
    rawType.includes("pinion shaft") ||
    rawType.includes("gear shaft") ||
    rawType.includes("helical shaft") ||
    (recipe?.shaft != null && recipe?.gear != null);

  // Detect if component is Compound Gear
  const isCompoundGear =
    !isPinionShaft &&
    (p.type === "compound gear" ||
      rawType.includes("compound") ||
      rawType.includes("double gear") ||
      rawType.includes("dual gear") ||
      rawType.includes("cluster gear") ||
      recipe?.style === "compound_gear");

  // Detect if component is Flanged Shaft / Linear Spline Bushing
  const isFlangedShaft =
    p.type === "flanged shaft" ||
    recipe?.style === "flanged_shaft" ||
    ((p.type === "flange" || (Array.isArray(analysis?.features) && analysis.features.some((f) => /bolt\s*hole|mounting\s*hole|flange/i.test(String(f))))) &&
      (rawType.includes("shaft") ||
        rawType.includes("spline") ||
        rawType.includes("bushing") ||
        (Array.isArray(analysis?.features) && analysis.features.some((f) => /spline|linear\s*shaft|drive\s*shaft/i.test(String(f))))));

  // Detect if component is Bevel Gear
  const isBevel =
    p.type === "bevel gear" ||
    rawType.includes("bevel") ||
    recipe?.gear?.gearType === "bevel" ||
    (recipe?.gear?.coneAngle && recipe.gear.coneAngle > 0);

  // Detect if component is Stepped Shaft / Spindle (NEVER a gear or flanged shaft!)
  const isSteppedShaft =
    !isGear &&
    !isCompoundGear &&
    !isPinionShaft &&
    !isFlangedShaft &&
    !isCustomExtruded &&
    (p.type === "stepped shaft" ||
      rawType.includes("step") ||
      rawType.includes("spindle"));

  // Check if component is a flange (either by type or features containing flange/bolt holes)
  const isFlange =
    !isGear &&
    !isPinionShaft &&
    !isFlangedShaft &&
    !isCustomExtruded &&
    (p.type === "flange" ||
      rawType.includes("flange") ||
      (Array.isArray(analysis?.features) && analysis.features.some((f) => /bolt\s*hole|mounting\s*hole/i.test(String(f)))));

  // If component is a flange, but the recipe is 'revolved' (which CANNOT display off-axis bolt holes)
  // or has no bolt holes in recipe, render the true flange geometry with bolt holes!
  const flangeLacksHoles =
    isFlange &&
    (!recipe ||
      recipe.style === "revolved" ||
      (!recipe.flange && (!recipe.holes || recipe.holes.length <= 1)));

  // Detect if component is Circular Cap / Bushing / Bottle Cap
  const isCapOrBushing =
    p.type === "cap/bushing" ||
    rawType.includes("cap") ||
    rawType.includes("bushing") ||
    rawType.includes("bottle cap") ||
    rawType.includes("lid") ||
    rawType.includes("closure");

  if (isCapOrBushing) {
    const od = p.outerDiameter || analysis?.dimensions?.outerDiameter || 30.0;
    const id = p.innerDiameter || analysis?.dimensions?.innerDiameter || null;
    const h = p.height || p.length || analysis?.dimensions?.height || analysis?.dimensions?.length || 12.0;
    const t = p.thickness || analysis?.dimensions?.thickness || null;
    body = buildCapBushingGroup({
      outerDiameter: od,
      innerDiameter: id,
      height: h,
      thickness: t,
    });
    label = "CIRCULAR CAP / BUSHING";
  }

  // Primary Route: Execute exact engineering recipe (meshData, compound_gear, flanged_shaft, gear, revolved, extruded, combination)
  const recipeMismatchesType =
    (p.type === "flange" && recipe?.style === "revolved" && !recipe.flange) ||
    (["bevel gear", "spur gear", "helical gear"].includes(p.type) &&
      recipe?.style !== "mesh" && !recipe?.axialSegments && !recipe?.gear);
  if (!body && recipe && !isTrivialBoxFallback && !recipeMismatchesType) {
    body = executeRecipe(recipe);
    const rawComp = String(analysis?.componentType || "").trim();
    if (rawComp && rawComp.toLowerCase() !== "other") {
      label = rawComp.toUpperCase();
    } else if (p.type && COMPONENT_LABELS[p.type]) {
      label = COMPONENT_LABELS[p.type];
    } else {
      label = "ENGINEERED COMPONENT";
    }
  }
  if (!body) {
    if (isCompoundGear) {
      const outerR = p.outerDiameter ? p.outerDiameter / 2 : 2.8;
      const stage2R = outerR * 0.60;
      const faceW = p.height || p.thickness || 2.2;
      const boreR = p.innerDiameter ? p.innerDiameter / 2 : outerR * 0.25;
      body = buildCompoundGearGroup({
        stage1Teeth: p.teeth || 24,
        stage1Radius: outerR,
        stage1FaceWidth: faceW * 0.55,
        stage2Teeth: Math.max(8, Math.round((p.teeth || 24) * 0.65)),
        stage2Radius: stage2R,
        stage2FaceWidth: faceW * 0.45,
        boreRadius: boreR,
        keywayWidth: boreR * 0.4,
        keywayHeight: boreR * 0.22,
      });
      label = COMPONENT_LABELS["compound gear"];
    } else if (isPinionShaft) {
      const outerR = p.outerDiameter ? p.outerDiameter / 2 : 2.5;
      const faceW = p.thickness || (p.outerDiameter ? p.outerDiameter * 0.65 : 2.0);
      const length = p.length || p.height || outerR * 4.5;
      const shaftR = p.innerDiameter && p.innerDiameter > 0 ? p.innerDiameter / 2 : outerR * 0.45;
      body = buildPinionShaftGroup({
        gearTeeth: p.teeth || 16,
        gearRadius: outerR,
        gearFaceWidth: faceW,
        helixAngle: p.helixAngle || 20,
        shaftRadius: shaftR,
        shaftLength: length,
        driveJournalRadius: shaftR * 0.9,
        supportJournalRadius: shaftR * 0.8,
        keywayWidth: shaftR * 0.35,
        keywayHeight: shaftR * 0.22,
      });
      label = COMPONENT_LABELS["pinion shaft"] || "HELICAL PINION SHAFT";
    } else if (isFlangedShaft) {
      const outerR = p.outerDiameter ? p.outerDiameter / 2 : 2.4;
      const shaftR = p.innerDiameter ? p.innerDiameter / 2 : outerR * 0.35;
      const length = p.length || p.height || outerR * 4.0;
      body = buildFlangedShaftGroup({
        shaftRadius: shaftR,
        shaftLength: length,
        flangeRadius: outerR,
        flangeThickness: Math.max(0.5, outerR * 0.28),
        collarRadius: shaftR * 1.5,
        collarLength: outerR * 0.7,
        boltCount: p.boltCount || 4,
        boltHoleRadius: Math.max(0.12, outerR * 0.09),
        splineCount: 6,
      });
      label = COMPONENT_LABELS["flanged shaft"];
    } else if (isBevel) {
      const outerR = p.outerDiameter ? p.outerDiameter / 2 : 2.8;
      const faceW = p.height || p.thickness || outerR * 0.45;
      const boreR = p.innerDiameter ? p.innerDiameter / 2 : outerR * 0.30;
      body = buildBevelGearGroup({
        teeth: p.teeth || 20,
        outerRadius: outerR,
        faceWidth: faceW,
        coneAngleDeg: p.coneAngle || 45,
        boreRadius: boreR,
      });
      label = COMPONENT_LABELS["bevel gear"];
    } else if (isSteppedShaft) {
      const outerR = p.outerDiameter ? p.outerDiameter / 2 : 1.8;
      const length = p.length || p.height || outerR * 4.0;
      const boreR = p.innerDiameter ? p.innerDiameter / 2 : 0;
      body = buildSteppedShaftGroup({
        outerRadius: outerR,
        length,
        innerRadius: boreR,
        profile: recipe?.revolvedProfile || null,
      });
      label = COMPONENT_LABELS["stepped shaft"];
    } else if (flangeLacksHoles) {
      body = buildFlange(p);
      label = COMPONENT_LABELS.flange;
    } else {
      switch (p.type) {
        case "compound gear":
          body = buildCompoundGearGroup();
          break;
        case "flanged shaft":
          body = buildFlangedShaftGroup();
          break;
        case "bevel gear":
          body = buildBevelGearGroup({
            teeth: p.teeth || 20,
            outerRadius: (p.outerDiameter || 5.6) / 2,
            faceWidth: p.height || p.thickness || 1.2,
            coneAngleDeg: p.coneAngle || 45,
            boreRadius: p.innerDiameter ? p.innerDiameter / 2 : 0,
          });
          break;
        case "cap/bushing":
          body = buildCapBushingGroup({
            outerDiameter: p.outerDiameter || analysis?.dimensions?.outerDiameter || 30.0,
            innerDiameter: p.innerDiameter || analysis?.dimensions?.innerDiameter || null,
            height: p.height || p.length || analysis?.dimensions?.height || analysis?.dimensions?.length || 12.0,
            thickness: p.thickness || analysis?.dimensions?.thickness || null,
          });
          break;
        case "stepped shaft":
          body = buildSteppedShaftGroup({
            outerRadius: (p.outerDiameter || 3.6) / 2,
            length: p.length || p.height || 6.5,
            innerRadius: p.innerDiameter ? p.innerDiameter / 2 : 0,
          });
          break;
        case "spur gear":
        case "helical gear":
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
      label = COMPONENT_LABELS[p.type] || COMPONENT_LABELS.other;
    }
  }
  body.traverse((obj) => {
    if (obj.isMesh) obj.castShadow = true;
  });
  group.add(body);

  // Universal Bounding Box Normalization & Origin Centering
  // Guarantees all components (regardless of source or raw dimension units)
  // fit cleanly inside the 3D viewport without camera clipping or runaway dimensions
  let meshCount = 0;
  body.traverse((obj) => { if (obj.isMesh) meshCount += 1; });
  if (!meshCount) {
    return { group, params: p, label };
  }

  const bbox = visibleBounds(group);
  if (bbox.isEmpty()) {
    return { group, params: p, label };
  }
  const bSize = bbox.getSize(new THREE.Vector3());
  const maxExtent = Math.max(bSize.x, bSize.y, bSize.z, 0.001);
  if (maxExtent > 6.5 || maxExtent < 2.0) {
    const fitScale = 5.5 / maxExtent;
    group.scale.setScalar(fitScale);
  }
  const updatedBbox = visibleBounds(group);
  const updatedCenter = updatedBbox.getCenter(new THREE.Vector3());
  group.position.sub(updatedCenter);

  return { group, params: p, label };
}


/**
 * Validate a reconstructed model before it is presented as complete.
 * Throws on invalid geometry; returns validation metadata on success.
 */
export function validateReconstructedModel(model) {
  const group = model?.group;
  if (!group || !group.isObject3D) {
    throw new Error('Reconstruction produced no 3D model.');
  }

  const meshes = [];
  group.traverse((node) => {
    if (node.isMesh && node.geometry) meshes.push(node);
  });
  if (!meshes.length) {
    throw new Error('Reconstruction produced no renderable mesh.');
  }

  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    if (!position || position.count === 0) {
      throw new Error('Reconstruction produced an empty mesh.');
    }
    const values = position.array;
    for (let i = 0; i < values.length; i += 1) {
      if (!Number.isFinite(values[i])) {
        throw new Error('Reconstruction produced invalid mesh coordinates.');
      }
    }
  }

  const bounds = new THREE.Box3().setFromObject(group);
  if (bounds.isEmpty()) {
    throw new Error('Reconstructed model has no measurable bounds.');
  }
  const size = bounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.x + size.y + size.z) || size.length() === 0) {
    throw new Error('Reconstructed model has invalid dimensions.');
  }

  return { valid: true, meshCount: meshes.length, bounds, size };
}


export function buildAssemblyScene(machineryState, options = {}) {
  const group = new THREE.Group();
  if (!machineryState) return { group, label: 'ASSEMBLY' };

  const selectedIds = options.selectedIds || null; // array of IDs or null for all
  const isSelected = (id) => !selectedIds || selectedIds.includes(id);

  const primary = machineryState.primaryGear;
  const companion = machineryState.companionGear;
  const additionals = machineryState.additionalComponents || [];

  const primaryAnalysis = primary?.analysis || {
    componentType: 'spur gear',
    teeth: 20,
    module: 2.5,
    dimensions: { outerDiameter: 55, innerDiameter: 16, height: 22 },
  };

  // 1. Build Primary Gear
  const primaryModel = buildModel(primaryAnalysis);
  const pGroup = primaryModel.group;
  pGroup.userData = { componentId: primary?.id || 'primary-gear', isPrimary: true };

  // Calculate scaling and center distance
  const pTeeth = primaryAnalysis?.teeth || 20;
  const pMod = primaryAnalysis?.module || 2.5;
  const pPitchR = (pTeeth * pMod) / 2;
  const pScale = 6 / Math.max(1, pPitchR * 2);
  const visualPRadius = pPitchR * pScale;
  const visualFaceWidth = (primaryAnalysis?.dimensions?.height || 22) * pScale;
  const pBoreR = ((primaryAnalysis?.dimensions?.innerDiameter || 16) / 2) * pScale;

  let centerDist = visualPRadius * 2.2;
  let visualCRadius = visualPRadius * 1.2;

  // 2. Build Companion Gear
  let cGroup = null;
  if (companion && isSelected(companion.id)) {
    const companionAnalysis = companion.analysis || {
      componentType: 'spur gear',
      teeth: Math.round(pTeeth * 1.5),
      module: pMod,
      dimensions: {
        outerDiameter: (Math.round(pTeeth * 1.5) + 2) * pMod,
        innerDiameter: (primaryAnalysis?.dimensions?.innerDiameter || 16) * 1.2,
        height: primaryAnalysis?.dimensions?.height || 22,
      },
    };

    const companionModel = buildModel(companionAnalysis);
    cGroup = companionModel.group;
    cGroup.userData = { componentId: companion.id, isCompanion: true };

    const cTeeth = companionAnalysis.teeth || Math.round(pTeeth * 1.5);
    const cPitchR = (cTeeth * pMod) / 2;
    visualCRadius = cPitchR * pScale;
    centerDist = visualPRadius + visualCRadius;

    // Position companion gear along X-axis
    cGroup.position.x = centerDist;
    // Rotate slightly so teeth mesh cleanly
    cGroup.rotation.z = Math.PI / cTeeth;
  }

  // Offset entire assembly to center at origin
  const assemblyOffsetX = -(centerDist / 2);

  const assemblySubGroup = new THREE.Group();

  if (isSelected(primary?.id || 'comp-primary-gear')) {
    assemblySubGroup.add(pGroup);
  }

  if (cGroup) {
    assemblySubGroup.add(cGroup);
  }

  // 3. Primary Shaft and Bearings
  const pShaftLength = visualFaceWidth * 3.5;
  const pShaftGeo = new THREE.CylinderGeometry(pBoreR * 0.96, pBoreR * 0.96, pShaftLength, 32);
  const shaftMat = new THREE.MeshStandardMaterial({
    color: '#3d332c',
    metalness: 0.85,
    roughness: 0.35,
  });
  shaftMat.userData.appearanceRole = 'shaft';
  const pShaftMesh = new THREE.Mesh(pShaftGeo, shaftMat);
  pShaftMesh.rotation.x = Math.PI / 2;
  pShaftMesh.userData = { featureType: 'shaft', role: 'drive_shaft' };
  assemblySubGroup.add(pShaftMesh);

  // Flanking Bearings for Primary Shaft
  const pBearingR = pBoreR * 2.0;
  const pBearingW = visualFaceWidth * 0.35;
  for (const zDir of [1, -1]) {
    const bearingGeo = ringShape(pBearingR, pBoreR * 0.97);
    const bearingMesh = new THREE.Mesh(extrude(bearingGeo, pBearingW), matDark);
    bearingMesh.position.z = zDir * (visualFaceWidth / 2 + pBearingW * 1.2);
    assemblySubGroup.add(bearingMesh);
  }

  // 4. Companion Shaft and Bearings (if companion exists)
  if (cGroup) {
    const cBoreR = pBoreR * 1.1;
    const cShaftGeo = new THREE.CylinderGeometry(cBoreR * 0.96, cBoreR * 0.96, pShaftLength, 32);
    const cShaftMesh = new THREE.Mesh(cShaftGeo, shaftMat);
    cShaftMesh.rotation.x = Math.PI / 2;
    cShaftMesh.position.x = centerDist;
    cShaftMesh.userData = { featureType: 'shaft', role: 'driven_shaft' };
    assemblySubGroup.add(cShaftMesh);

    const cBearingR = cBoreR * 2.0;
    for (const zDir of [1, -1]) {
      const bearingGeo = ringShape(cBearingR, cBoreR * 0.97);
      const bearingMesh = new THREE.Mesh(extrude(bearingGeo, pBearingW), matDark);
      bearingMesh.position.set(centerDist, 0, zDir * (visualFaceWidth / 2 + pBearingW * 1.2));
      assemblySubGroup.add(bearingMesh);
    }
  }

  // 5. Additional Components (Shafts, Bearings, Housings, Custom)
  additionals.forEach((comp, idx) => {
    if (!isSelected(comp.id)) return;
    const compAnalysis = comp.analysis || {
      componentType: comp.type || 'other',
      dimensions: {
        outerDiameter: comp.type === 'bearing' ? 45 : 30,
        innerDiameter: 15,
        height: 20,
      },
    };
    const compModel = buildModel(compAnalysis);
    const mGroup = compModel.group;
    mGroup.userData = { componentId: comp.id, name: comp.name };

    // Layout additional components neatly
    const angle = ((idx + 1) / (additionals.length + 1)) * Math.PI - Math.PI / 2;
    const dist = visualPRadius * 2.4;
    mGroup.position.set(centerDist / 2 + Math.cos(angle) * dist, Math.sin(angle) * dist, 0);
    mGroup.scale.setScalar(0.75);
    assemblySubGroup.add(mGroup);
  });

  // 6. Enclosing Frame / Housing Structure
  const frameW = centerDist + visualCRadius * 2.2 + 2;
  const frameH = Math.max(visualPRadius, visualCRadius) * 2.6 + 2;
  const frameD = visualFaceWidth * 4;

  const housingGeo = new THREE.BoxGeometry(frameW, frameH, frameD);
  const housingMat = new THREE.MeshBasicMaterial({
    color: '#de822b',
    wireframe: true,
    transparent: true,
    opacity: 0.22,
  });
  housingMat.userData.appearanceRole = 'housing';
  const housingBox = new THREE.Mesh(housingGeo, housingMat);
  housingBox.position.set(centerDist / 2, 0, 0);
  assemblySubGroup.add(housingBox);

  // Mount Plate at bottom
  const plateGeo = new THREE.BoxGeometry(frameW * 1.1, 0.4, frameD * 1.1);
  const plateMat = new THREE.MeshStandardMaterial({
    color: '#271e18',
    metalness: 0.8,
    roughness: 0.5,
  });
  plateMat.userData.appearanceRole = 'plate';
  const plateMesh = new THREE.Mesh(plateGeo, plateMat);
  plateMesh.position.set(centerDist / 2, -frameH / 2 - 0.2, 0);
  assemblySubGroup.add(plateMesh);

  assemblySubGroup.position.x = assemblyOffsetX;
  group.add(assemblySubGroup);

  return {
    group,
    label: companion ? 'COMPLETE GEARBOX ASSEMBLY' : 'PRIMARY MACHINERY ASSEMBLY',
    centerDist,
    primaryGroup: pGroup,
    companionGroup: cGroup,
  };
}

export function resolveLabel(analysis) {
  const raw = String(analysis?.componentType || "").trim();
  const type = resolveComponentType(analysis);
  if (type !== "other") return COMPONENT_LABELS[type];
  if (raw && raw.toLowerCase() !== "other") return raw.toUpperCase();
  return COMPONENT_LABELS.other;
}

export function dimensionList(analysis) {
  const dims = analysis?.dimensions || {};
  const teeth = analysis?.teeth;
  const paramConf = analysis?.parameterConfidence || {};
  const recipe = analysis?.geometryRecipe || {};
  const rawCompType = String(analysis?.componentType || "").toLowerCase();
  const resolvedType = resolveComponentType(analysis);
  const geoType = String(analysis?.geometryType || "").toLowerCase();

  const isPrismatic =
    resolvedType === "simple bracket" ||
    rawCompType.includes("bracket") ||
    rawCompType.includes("box") ||
    rawCompType.includes("plate") ||
    rawCompType.includes("housing") ||
    rawCompType.includes("packaging") ||
    rawCompType.includes("block") ||
    rawCompType.includes("enclosure") ||
    rawCompType.includes("chassis") ||
    geoType.includes("prismatic") ||
    recipe.style === "extruded";

  const isCapBushing =
    resolvedType === "cap/bushing" ||
    rawCompType.includes("cap") ||
    rawCompType.includes("bushing") ||
    rawCompType.includes("bottle cap") ||
    rawCompType.includes("lid") ||
    rawCompType.includes("closure") ||
    rawCompType.includes("cup");

  const isFlange =
    resolvedType === "flange" ||
    rawCompType.includes("flange") ||
    geoType.includes("flange") ||
    Boolean(recipe.flange);

  const isGear =
    !isFlange &&
    (resolvedType.includes("gear") ||
      resolvedType === "compound gear" ||
      resolvedType === "pinion shaft" ||
      rawCompType.includes("gear") ||
      rawCompType.includes("pinion") ||
      rawCompType.includes("sprocket") ||
      (typeof teeth === "number" && teeth >= 4));

  const isShaft =
    !isPrismatic &&
    !isCapBushing &&
    !isGear &&
    !isFlange &&
    (resolvedType === "stepped shaft" ||
      resolvedType === "cylinder/shaft" ||
      resolvedType === "flanged shaft" ||
      rawCompType.includes("shaft") ||
      rawCompType.includes("cylinder") ||
      rawCompType.includes("spindle") ||
      recipe.style === "revolved" ||
      recipe.style === "axial_segments");

  // Inferred base numbers
  let inferredOD = typeof dims.outerDiameter === "number" && isFinite(dims.outerDiameter) ? dims.outerDiameter : null;
  let inferredLength = typeof dims.length === "number" && isFinite(dims.length) ? dims.length : (typeof dims.height === "number" && isFinite(dims.height) ? dims.height : null);
  let inferredBore = typeof dims.innerDiameter === "number" && isFinite(dims.innerDiameter) ? dims.innerDiameter : null;
  let inferredWidth = typeof dims.width === "number" && isFinite(dims.width) ? dims.width : null;
  let inferredThickness = typeof dims.thickness === "number" && isFinite(dims.thickness) ? dims.thickness : null;

  // 1. PRISMATIC (Bracket, Packaging Box, Plate, Housing, Enclosure)
  if (isPrismatic) {
    if (Array.isArray(recipe.outline) && recipe.outline.length >= 3) {
      const xs = recipe.outline.map((pt) => pt.x || 0);
      const ys = recipe.outline.map((pt) => pt.y || 0);
      const spanX = Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10;
      const spanY = Math.round((Math.max(...ys) - Math.min(...ys)) * 10) / 10;
      if (inferredLength == null) inferredLength = Math.max(spanX, spanY);
      if (inferredWidth == null) inferredWidth = Math.min(spanX, spanY);
      if (inferredThickness == null) inferredThickness = recipe.depth || dims.thickness || 20;
    }
    const lVal = inferredLength || inferredWidth || dims.length || 120.0;
    const wVal = inferredWidth || dims.width || Math.round(lVal * 0.65 * 10) / 10;
    const hVal = dims.height || inferredThickness || recipe.depth || 20.0;

    const rows = [
      {
        label: "LENGTH",
        key: "length",
        value: lVal,
        status: paramConf.length?.status || (dims.length ? "MEASURED" : "ESTIMATED"),
        source: paramConf.length?.source || null,
        confidence: paramConf.length?.confidence || 0.95,
        reason: paramConf.length?.reason || "Calibrated major physical span along length axis",
      },
      {
        label: "WIDTH",
        key: "width",
        value: wVal,
        status: paramConf.width?.status || (dims.width ? "MEASURED" : "ESTIMATED"),
        source: paramConf.width?.source || null,
        confidence: paramConf.width?.confidence || 0.95,
        reason: paramConf.width?.reason || "Calibrated physical span along width axis",
      },
      {
        label: "HEIGHT / DEPTH",
        key: "height",
        value: hVal,
        status: paramConf.height?.status || paramConf.thickness?.status || "ESTIMATED",
        source: paramConf.height?.source || paramConf.thickness?.source || null,
        confidence: paramConf.height?.confidence || 0.70,
        reason: paramConf.height?.reason || "Axial depth/thickness perpendicular to face",
      },
    ];

    if (dims.thickness && dims.thickness <= 5.0 && dims.thickness !== hVal) {
      rows.push({
        label: "WALL THICKNESS",
        key: "thickness",
        value: dims.thickness,
        status: paramConf.thickness?.status || "ESTIMATED",
        source: paramConf.thickness?.source || null,
        confidence: paramConf.thickness?.confidence || 0.68,
        reason: paramConf.thickness?.reason || "Sheet metal / paperboard wall thickness",
      });
    }

    if (Array.isArray(recipe.holes) && recipe.holes.length > 0) {
      const holeD = Math.round((recipe.holes[0].radius || 5) * 2 * 10) / 10;
      rows.push({
        label: "HOLE Ø",
        key: "holeDiameter",
        value: holeD,
        status: "MEASURED",
        source: "geometric_feature",
        confidence: 0.95,
        reason: `Through-hole diameter (${recipe.holes.length} holes detected)`,
      });
      rows.push({
        label: "HOLE COUNT",
        key: "holeCount",
        value: recipe.holes.length,
        status: "MEASURED",
        source: "geometric_feature",
        confidence: 1.0,
        reason: "Count of verified through-holes in component face",
      });
    } else if (dims.innerDiameter && dims.innerDiameter > 0) {
      rows.push({
        label: "HOLE Ø",
        key: "innerDiameter",
        value: dims.innerDiameter,
        status: paramConf.innerDiameter?.status || "MEASURED",
        source: paramConf.innerDiameter?.source || null,
        confidence: paramConf.innerDiameter?.confidence || 0.90,
        reason: paramConf.innerDiameter?.reason || "Through-hole bore opening",
      });
    }

    return rows;
  }

  // 2. CIRCULAR CAP / BUSHING (Bottle Cap, Closure, Bushing)
  if (isCapBushing) {
    const od = inferredOD || 30.0;
    const id = inferredBore != null ? inferredBore : (dims.innerDiameter != null ? dims.innerDiameter : Math.round((od - 2.0) * 10) / 10);
    const h = dims.height || inferredLength || 12.0;
    const wallThick = dims.thickness || Math.round(((od - id) / 2) * 10) / 10;

    return [
      {
        label: "OUTER Ø",
        key: "outerDiameter",
        value: od,
        status: paramConf.outerDiameter?.status || "MEASURED",
        source: paramConf.outerDiameter?.source || null,
        confidence: paramConf.outerDiameter?.confidence || 0.98,
        reason: paramConf.outerDiameter?.reason || `Outer rim diameter (R = ${(od / 2).toFixed(1)} mm)`,
      },
      {
        label: "INNER BORE Ø",
        key: "innerDiameter",
        value: id,
        status: paramConf.innerDiameter?.status || (id > 0 ? "MEASURED" : "UNKNOWN"),
        source: paramConf.innerDiameter?.source || null,
        confidence: paramConf.innerDiameter?.confidence || (id > 0 ? 0.96 : 0.1),
        reason: paramConf.innerDiameter?.reason || `Internal cavity / bore diameter (R = ${(id / 2).toFixed(1)} mm)`,
      },
      {
        label: "HEIGHT",
        key: "height",
        value: h,
        status: paramConf.height?.status || paramConf.thickness?.status || "ESTIMATED",
        source: paramConf.height?.source || null,
        confidence: paramConf.height?.confidence || 0.70,
        reason: paramConf.height?.reason || "Axial skirt height",
      },
      {
        label: "WALL THICKNESS",
        key: "thickness",
        value: wallThick > 0 ? wallThick : 1.0,
        status: paramConf.thickness?.status || "ESTIMATED",
        source: paramConf.thickness?.source || null,
        confidence: paramConf.thickness?.confidence || 0.85,
        reason: paramConf.thickness?.reason || `Calculated cylindrical wall thickness (OD - ID) / 2`,
      },
    ];
  }

  // 3. FLANGE
  if (isFlange) {
    const od = inferredOD || 120.0;
    const id = inferredBore != null ? inferredBore : (dims.innerDiameter != null ? dims.innerDiameter : 40.0);
    const th = dims.thickness || 20.0;
    const boltCount = recipe.flange?.boltCount || (recipe.holes ? recipe.holes.length : (analysis?.boltCount || 4));
    const pcd = recipe.flange?.boltCircleDiameter || (dims.pcd ? dims.pcd : Math.round(od * 0.75 * 10) / 10);
    const holeD = recipe.flange?.boltHoleDiameter || (recipe.holes?.[0]?.radius ? recipe.holes[0].radius * 2 : null);

    const rows = [
      {
        label: "FLANGE Ø",
        key: "outerDiameter",
        value: od,
        status: paramConf.outerDiameter?.status || "MEASURED",
        source: paramConf.outerDiameter?.source || null,
        confidence: paramConf.outerDiameter?.confidence || 0.98,
        reason: paramConf.outerDiameter?.reason || `Outer flange plate diameter (R = ${(od / 2).toFixed(1)} mm)`,
      },
      {
        label: "INNER BORE Ø",
        key: "innerDiameter",
        value: id,
        status: paramConf.innerDiameter?.status || (id > 0 ? "MEASURED" : "UNKNOWN"),
        source: paramConf.innerDiameter?.source || null,
        confidence: paramConf.innerDiameter?.confidence || (id > 0 ? 0.96 : 0.1),
        reason: paramConf.innerDiameter?.reason || (id === 0 ? "Blind flange (solid center)" : `Center bore (R = ${(id / 2).toFixed(1)} mm)`),
      },
      {
        label: "THICKNESS",
        key: "thickness",
        value: th,
        status: paramConf.thickness?.status || "ESTIMATED",
        source: paramConf.thickness?.source || null,
        confidence: paramConf.thickness?.confidence || 0.75,
        reason: paramConf.thickness?.reason || "Flange plate thickness",
      },
      {
        label: "BOLT CIRCLE Ø (PCD)",
        key: "pcd",
        value: pcd,
        status: "MEASURED",
        source: "flange_bolt_pattern",
        confidence: 0.95,
        reason: `Pitch Circle Diameter for ${boltCount} mounting bolts`,
      },
      {
        label: "BOLT COUNT",
        key: "boltCount",
        value: boltCount,
        status: "MEASURED",
        source: "flange_bolt_pattern",
        confidence: 1.0,
        reason: `Count of concentric bolt holes`,
      },
    ];

    if (holeD) {
      rows.push({
        label: "HOLE Ø",
        key: "holeDiameter",
        value: holeD,
        status: "MEASURED",
        source: "flange_bolt_pattern",
        confidence: 0.92,
        reason: "Bolt hole clearance diameter",
      });
    }

    return rows;
  }

  // 4. GEAR
  if (isGear) {
    const od = inferredOD || 80.0;
    const id = inferredBore != null ? inferredBore : (dims.innerDiameter != null ? dims.innerDiameter : 0);
    const fw = dims.faceWidth || dims.thickness || dims.height || 20.0;
    const tCount = teeth || recipe.gear?.teeth;
    const mod = analysis?.module || recipe.gear?.module;

    const rows = [
      {
        label: "OUTER Ø",
        key: "outerDiameter",
        value: od,
        status: paramConf.outerDiameter?.status || "ESTIMATED",
        source: paramConf.outerDiameter?.source || null,
        confidence: paramConf.outerDiameter?.confidence || 0.75,
        reason: paramConf.outerDiameter?.reason || `Tip / addendum diameter (R = ${(od / 2).toFixed(1)} mm)`,
      },
      {
        label: "INNER BORE Ø",
        key: "innerDiameter",
        value: id,
        status: paramConf.innerDiameter?.status || (id > 0 ? "ESTIMATED" : "UNKNOWN"),
        source: paramConf.innerDiameter?.source || null,
        confidence: paramConf.innerDiameter?.confidence || (id > 0 ? 0.75 : 0.1),
        reason: paramConf.innerDiameter?.reason || (id === 0 ? "Solid hub core (no bore)" : `Shaft mounting bore (R = ${(id / 2).toFixed(1)} mm)`),
      },
      {
        label: "FACE WIDTH",
        key: "thickness",
        value: fw,
        status: paramConf.thickness?.status || "ESTIMATED",
        source: paramConf.thickness?.source || null,
        confidence: paramConf.thickness?.confidence || 0.70,
        reason: paramConf.thickness?.reason || "Gear face width along axis",
      },
      {
        label: "TEETH",
        key: "teeth",
        value: tCount,
        status: paramConf.teeth?.status || (tCount ? "MEASURED" : "UNKNOWN"),
        source: paramConf.teeth?.source || null,
        confidence: paramConf.teeth?.confidence || (tCount ? 0.95 : null),
        reason: paramConf.teeth?.reason || "Tooth count",
      },
      {
        label: "MODULE",
        key: "module",
        value: mod,
        status: paramConf.module?.status || (mod ? "MEASURED" : "UNKNOWN"),
        source: paramConf.module?.source || null,
        confidence: paramConf.module?.confidence || (mod ? 0.92 : null),
        reason: paramConf.module?.reason || "ISO standard metric tooth module",
      },
    ];

    if (analysis?.helixAngle != null && Math.abs(analysis.helixAngle) > 0) {
      rows.push({
        label: "HELIX ANGLE",
        key: "helixAngle",
        value: analysis.helixAngle,
        status: "MEASURED",
        source: "helical_geometry",
        confidence: 0.90,
        reason: "Tooth lead helix angle in degrees",
      });
    }

    if (analysis?.coneAngle != null && analysis.coneAngle > 0) {
      rows.push({
        label: "CONE ANGLE",
        key: "coneAngle",
        value: analysis.coneAngle,
        status: "MEASURED",
        source: "bevel_geometry",
        confidence: 0.90,
        reason: "Pitch cone angle in degrees",
      });
    }

    return rows.filter((r) => r.value != null);
  }

  // 5. SHAFT (Stepped Shaft, Spindle, Cylinder)
  if (isShaft) {
    if ((inferredOD == null || inferredLength == null) && recipe.style === "revolved" && Array.isArray(recipe.revolvedProfile)) {
      const validR = recipe.revolvedProfile.map((p) => Math.abs(p.radius || 0)).filter((r) => r > 0);
      const validZ = recipe.revolvedProfile.map((p) => p.z || 0);
      if (validR.length > 0) {
        const maxR = Math.max(...validR);
        const zSpan = Math.abs(Math.max(...validZ) - Math.min(...validZ));
        if (inferredOD == null) inferredOD = maxR >= 5 ? Math.round(maxR * 2 * 10) / 10 : 45.0;
        if (inferredLength == null) inferredLength = zSpan >= 5 ? Math.round(zSpan * 10) / 10 : 80.0;
      }
    }
    if ((inferredOD == null || inferredLength == null) && Array.isArray(recipe.axialSegments)) {
      const validR = recipe.axialSegments.map((s) => s.radius || 0).filter((r) => r > 0);
      const zStarts = recipe.axialSegments.map((s) => s.zStart || 0);
      const zEnds = recipe.axialSegments.map((s) => s.zEnd || 0);
      if (validR.length > 0) {
        if (inferredOD == null) inferredOD = Math.round(Math.max(...validR) * 2 * 10) / 10;
        if (inferredLength == null) inferredLength = Math.round(Math.abs(Math.max(...zEnds) - Math.min(...zStarts)) * 10) / 10;
      }
    }
    const od = inferredOD || 45.0;
    const len = inferredLength || 80.0;
    const id = inferredBore != null ? inferredBore : 0;

    const rows = [
      {
        label: "MAJOR Ø",
        key: "outerDiameter",
        value: od,
        status: paramConf.outerDiameter?.status || "ESTIMATED",
        source: paramConf.outerDiameter?.source || null,
        confidence: paramConf.outerDiameter?.confidence || 0.75,
        reason: paramConf.outerDiameter?.reason || `Major shaft diameter (R = ${(od / 2).toFixed(1)} mm)`,
      },
      {
        label: "TOTAL LENGTH",
        key: "length",
        value: len,
        status: paramConf.length?.status || "ESTIMATED",
        source: paramConf.length?.source || null,
        confidence: paramConf.length?.confidence || 0.70,
        reason: paramConf.length?.reason || "Total axial shaft length",
      },
    ];

    if (id > 0) {
      rows.push({
        label: "INNER BORE Ø",
        key: "innerDiameter",
        value: id,
        status: paramConf.innerDiameter?.status || "ESTIMATED",
        source: paramConf.innerDiameter?.source || null,
        confidence: paramConf.innerDiameter?.confidence || 0.70,
        reason: paramConf.innerDiameter?.reason || `Internal hollow bore (R = ${(id / 2).toFixed(1)} mm)`,
      });
    }

    if (Array.isArray(recipe.axialSegments) && recipe.axialSegments.length > 1) {
      rows.push({
        label: "SHOULDERS",
        key: "segmentCount",
        value: recipe.axialSegments.length,
        status: "MEASURED",
        source: "revolved_profile",
        confidence: 1.0,
        reason: `Count of turned diameter steps and bearing journals`,
      });
    }

    return rows;
  }

  // 6. Generic turned/cylindrical/other fallback
  const genericOD = inferredOD || (dims.outerDiameter || dims.width || 45.0);
  const genericLen = inferredLength || (dims.length || dims.height || 80.0);
  const genericBore = inferredBore ?? dims.innerDiameter;

  const rows = [
    {
      label: "PRIMARY Ø / WIDTH",
      key: "outerDiameter",
      value: genericOD,
      status: paramConf.outerDiameter?.status || "ESTIMATED",
      source: paramConf.outerDiameter?.source || null,
      confidence: paramConf.outerDiameter?.confidence || 0.65,
      reason: paramConf.outerDiameter?.reason || `Primary cross-section envelope dimension`,
    },
    {
      label: "TOTAL LENGTH",
      key: "length",
      value: genericLen,
      status: paramConf.length?.status || paramConf.height?.status || "ESTIMATED",
      source: paramConf.length?.source || null,
      confidence: paramConf.length?.confidence || 0.65,
      reason: paramConf.length?.reason || "Overall physical length/height",
    },
  ];

  if (genericBore != null && genericBore > 0) {
    rows.push({
      label: "INNER BORE Ø",
      key: "innerDiameter",
      value: genericBore,
      status: paramConf.innerDiameter?.status || "ESTIMATED",
      source: paramConf.innerDiameter?.source || null,
      confidence: paramConf.innerDiameter?.confidence || 0.65,
      reason: paramConf.innerDiameter?.reason || `Center bore opening`,
    });
  }

  if (dims.thickness && dims.thickness !== genericLen) {
    rows.push({
      label: "THICKNESS",
      key: "thickness",
      value: dims.thickness,
      status: paramConf.thickness?.status || "ESTIMATED",
      source: paramConf.thickness?.source || null,
      confidence: paramConf.thickness?.confidence || 0.65,
      reason: paramConf.thickness?.reason || "Material thickness",
    });
  }

  return rows.filter((r) => typeof r.value === "number" && isFinite(r.value));
}

