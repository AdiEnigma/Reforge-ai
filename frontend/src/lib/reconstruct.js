import * as THREE from "three";
import { executeRecipe, sanitizeRecipe } from "./recipe.js";
import { extrude, gearShape, matAccent, matBody, matDark, matRim, matHighlight, ringShape, buildBevelGearGroup, buildSteppedShaftGroup, buildCompoundGearGroup, buildFlangedShaftGroup, buildPinionShaftGroup } from "./geo.js";

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
  "cylinder/shaft": "CYLINDER / SHAFT",
  flange: "FLANGE",
  bearing: "BEARING",
  "simple bracket": "SIMPLE BRACKET",
  other: "GENERIC COMPONENT",
};

export function resolveComponentType(analysis) {
  const raw = String(analysis?.componentType || "other").toLowerCase();
  const featuresStr = Array.isArray(analysis?.features) ? analysis.features.map(f => String(f).toLowerCase()).join(" ") : "";
  const gearType = String(analysis?.gearType || analysis?.geometryRecipe?.gear?.gearType || "").toLowerCase();
  const isGear = raw.includes("gear") || featuresStr.includes("gear") || featuresStr.includes("teeth") || (typeof analysis?.teeth === "number" && analysis.teeth > 0) || analysis?.geometryRecipe?.style === "gear" || analysis?.geometryRecipe?.gear;

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
      (analysis?.geometryRecipe?.gear?.stages && analysis.geometryRecipe.gear.stages.length >= 2))
  ) {
    return "compound gear";
  }

  // 2. Detect Integral Pinion Shaft / Gear Shaft
  if (
    isGear &&
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

  // 5. Detect Helical / Worm Gear
  if (isGear && (raw.includes("helical") || gearType === "helical" || (typeof analysis?.helixAngle === "number" && analysis.helixAngle > 0))) {
    return "helical gear";
  }
  if (isGear && (raw.includes("worm") || gearType === "worm")) {
    return "worm gear";
  }

  // 6. Detect Spur Gear (Standard)
  if (isGear) {
    return "spur gear";
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
    gearType: analysis?.gearType || analysis?.geometryRecipe?.gear?.gearType || null,
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

  for (const z of [1, -1]) {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, hubH, 32), matAccent);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = z * (height / 2 + hubH / 2);
    hub.userData = { featureId: "feature-boss-1", featureType: "boss" };
    group.add(hub);
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
  return group;
}

export function buildModel(analysis) {
  const p = computeParams(analysis);
  const group = new THREE.Group();
  let body;
  let label;
  const recipe = sanitizeRecipe(analysis);

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

  // Primary Route: Execute exact engineering recipe (meshData, compound_gear, flanged_shaft, gear, revolved, extruded, combination)
  if (recipe && !isTrivialBoxFallback) {
    body = executeRecipe(recipe);
    const rawComp = String(analysis?.componentType || "").trim();
    if (rawComp && rawComp.toLowerCase() !== "other") {
      label = rawComp.toUpperCase();
    } else if (p.type && COMPONENT_LABELS[p.type]) {
      label = COMPONENT_LABELS[p.type];
    } else {
      label = "ENGINEERED COMPONENT";
    }
  } else if (isCompoundGear) {
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
  } else if (isCustomExtruded) {
    body = executeRecipe(recipe);
    label = String(analysis?.componentType || "other").trim().toUpperCase() || COMPONENT_LABELS.other;
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
          boreRadius: p.innerDiameter ? p.innerDiameter / 2 : 0.8,
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
  body.traverse((obj) => {
    if (obj.isMesh) obj.castShadow = true;
  });
  group.add(body);

  // Universal Bounding Box Normalization & Origin Centering
  // Guarantees all components (regardless of source or raw dimension units)
  // fit cleanly inside the 3D viewport without camera clipping or runaway dimensions
  const bbox = new THREE.Box3().setFromObject(group);
  const bSize = bbox.getSize(new THREE.Vector3());
  const maxExtent = Math.max(bSize.x, bSize.y, bSize.z, 0.001);
  if (maxExtent > 6.5 || maxExtent < 2.0) {
    const fitScale = 5.5 / maxExtent;
    group.scale.setScalar(fitScale);
  }
  const updatedBbox = new THREE.Box3().setFromObject(group);
  const updatedCenter = updatedBbox.getCenter(new THREE.Vector3());
  group.position.sub(updatedCenter);

  return { group, params: p, label };
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
  const compType = String(analysis?.componentType || "").toLowerCase();

  // Infer dimensions from geometry recipe if missing from top-level dimensions
  let inferredOD = typeof dims.outerDiameter === "number" && isFinite(dims.outerDiameter) ? dims.outerDiameter : null;
  let inferredLength = typeof dims.length === "number" && isFinite(dims.length) ? dims.length : (typeof dims.height === "number" && isFinite(dims.height) ? dims.height : null);
  let inferredBore = typeof dims.innerDiameter === "number" && isFinite(dims.innerDiameter) ? dims.innerDiameter : null;
  let inferredWidth = typeof dims.width === "number" && isFinite(dims.width) ? dims.width : null;
  let inferredThickness = typeof dims.thickness === "number" && isFinite(dims.thickness) ? dims.thickness : null;

  // 1. Revolved Profile
  if ((inferredOD == null || inferredLength == null) && recipe.style === "revolved" && Array.isArray(recipe.revolvedProfile)) {
    const validR = recipe.revolvedProfile.map((p) => Math.abs(p.radius || 0)).filter((r) => r > 0);
    const validZ = recipe.revolvedProfile.map((p) => p.z || 0);
    if (validR.length > 0) {
      const maxR = Math.max(...validR);
      const zSpan = Math.abs(Math.max(...validZ) - Math.min(...validZ));
      if (inferredOD == null) inferredOD = maxR >= 5 ? Math.round(maxR * 2 * 10) / 10 : 45.0;
      if (inferredLength == null) inferredLength = zSpan >= 5 ? Math.round(zSpan * 10) / 10 : (maxR > 0 ? Math.round(45 * (zSpan / (maxR * 2 || 1)) * 10) / 10 : 80.0);
    }
  }

  // 2. Axial Segments
  if ((inferredOD == null || inferredLength == null) && Array.isArray(recipe.axialSegments)) {
    const validR = recipe.axialSegments.map((s) => s.radius || 0).filter((r) => r > 0);
    const zStarts = recipe.axialSegments.map((s) => s.zStart || 0);
    const zEnds = recipe.axialSegments.map((s) => s.zEnd || 0);
    if (validR.length > 0) {
      if (inferredOD == null) inferredOD = Math.round(Math.max(...validR) * 2 * 10) / 10;
      if (inferredLength == null) inferredLength = Math.round(Math.abs(Math.max(...zEnds) - Math.min(...zStarts)) * 10) / 10;
    }
  }

  // 3. Extruded Outline
  if ((inferredOD == null || inferredLength == null) && Array.isArray(recipe.outline) && recipe.outline.length >= 3) {
    const xs = recipe.outline.map((pt) => pt.x || 0);
    const ys = recipe.outline.map((pt) => pt.y || 0);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (inferredOD == null) inferredOD = Math.round(Math.max(spanX, spanY) * 10) / 10;
    if (inferredLength == null) inferredLength = Math.round(Math.min(spanX, spanY) * 10) / 10;
    if (inferredThickness == null) inferredThickness = recipe.depth || 20;
  }

  // 4. Fallback defaults for turned/revolved parts if still null
  if (inferredOD == null && (compType.includes("shaft") || compType.includes("cylinder") || compType.includes("spindle") || recipe.style === "revolved")) {
    inferredOD = 45.0;
    if (inferredLength == null) inferredLength = 80.0;
    if (inferredBore == null) inferredBore = 0;
  }

  const rows = [
    {
      label: "OUTER Ø",
      key: "outerDiameter",
      value: inferredOD,
      status: paramConf.outerDiameter?.status || (dims.outerDiameter ? "ESTIMATED" : (inferredOD ? "ESTIMATED" : "UNKNOWN")),
      source: paramConf.outerDiameter?.source || (dims.outerDiameter ? null : "inferred_profile"),
      confidence: paramConf.outerDiameter?.confidence || (inferredOD ? 0.65 : null),
      reason: paramConf.outerDiameter?.reason || (inferredOD ? `Inferred outer diameter (Radius = ${(inferredOD / 2).toFixed(1)} mm)` : "Uncalibrated: no physical scale reference in photograph"),
    },
    {
      label: "INNER BORE Ø",
      key: "innerDiameter",
      value: inferredBore,
      status: paramConf.innerDiameter?.status || (dims.innerDiameter != null && dims.innerDiameter > 0 ? "ESTIMATED" : (inferredBore != null ? "ESTIMATED" : "UNKNOWN")),
      source: paramConf.innerDiameter?.source || null,
      confidence: paramConf.innerDiameter?.confidence || (inferredBore != null ? 0.65 : null),
      reason: paramConf.innerDiameter?.reason || (inferredBore === 0 ? "Solid core (no internal bore)" : `Internal bore Ø ${inferredBore} mm (Radius = ${(inferredBore / 2).toFixed(1)} mm)`),
    },
    {
      label: "HEIGHT",
      key: "height",
      value: inferredLength || dims.height,
      status: paramConf.thickness?.status || paramConf.height?.status || "ESTIMATED",
      source: paramConf.thickness?.source || paramConf.height?.source || null,
      confidence: paramConf.thickness?.confidence || 0.65,
      reason: paramConf.thickness?.reason || "Inferred from axial profile span",
    },
    {
      label: "WIDTH",
      key: "width",
      value: inferredWidth || inferredOD || dims.width,
      status: paramConf.outerDiameter?.status || "ESTIMATED",
      source: paramConf.outerDiameter?.source || null,
      confidence: paramConf.outerDiameter?.confidence || 0.65,
      reason: paramConf.outerDiameter?.reason || null,
    },
    {
      label: "LENGTH",
      key: "length",
      value: inferredLength || dims.length,
      status: paramConf.length?.status || paramConf.thickness?.status || "ESTIMATED",
      source: paramConf.length?.source || null,
      confidence: paramConf.length?.confidence || 0.65,
      reason: paramConf.length?.reason || "Inferred from axial profile span",
    },
    {
      label: "THICKNESS",
      key: "thickness",
      value: inferredThickness || dims.thickness,
      status: paramConf.thickness?.status || "ESTIMATED",
      source: paramConf.thickness?.source || null,
      confidence: paramConf.thickness?.confidence || null,
      reason: paramConf.thickness?.reason || null,
    },
    {
      label: "TEETH",
      key: "teeth",
      value: teeth,
      status: paramConf.teeth?.status || (teeth ? "ESTIMATED" : "UNKNOWN"),
      source: paramConf.teeth?.source || null,
      confidence: paramConf.teeth?.confidence || null,
      reason: paramConf.teeth?.reason || null,
    },
    {
      label: "MODULE",
      key: "module",
      value: analysis?.module,
      status: paramConf.module?.status || (analysis?.module ? "ESTIMATED" : "UNKNOWN"),
      source: paramConf.module?.source || null,
      confidence: paramConf.module?.confidence || null,
      reason: paramConf.module?.reason || null,
    },
    {
      label: "HELIX ANGLE",
      key: "helixAngle",
      value: analysis?.helixAngle,
      status: analysis?.helixAngle != null && analysis.helixAngle > 0 ? "ESTIMATED" : "MEASURED",
      source: null,
      confidence: null,
      reason: null,
    },
  ];

  const isPrimary = (k) => k === "outerDiameter" || k === "length" || k === "height" || k === "innerDiameter";
  return rows.filter((row) => (typeof row.value === "number" && isFinite(row.value)) || (row.status === "UNKNOWN" && isPrimary(row.key)));
}

