import * as THREE from "three";
import { executeRecipe, sanitizeRecipe } from "./recipe.js";
import { extrude, gearShape, matAccent, matBody, matDark, matRim, matHighlight, ringShape, buildBevelGearGroup, buildSteppedShaftGroup } from "./geo.js";

export const COMPONENT_LABELS = {
  "bevel gear": "BEVEL GEAR",
  "stepped shaft": "STEPPED SHAFT",
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

  // 1. Detect Bevel Gear
  if (
    raw.includes("bevel") ||
    raw.includes("miter") ||
    raw.includes("conical") ||
    gearType === "bevel" ||
    featuresStr.includes("bevel") ||
    featuresStr.includes("miter") ||
    featuresStr.includes("conical")
  ) {
    return "bevel gear";
  }

  // 2. Detect Stepped Shaft / Spindle
  if (
    raw.includes("step") ||
    raw.includes("spindle") ||
    (raw.includes("shaft") && !raw.includes("crank")) ||
    featuresStr.includes("step") ||
    featuresStr.includes("spline") ||
    featuresStr.includes("journal") ||
    (analysis?.geometryRecipe?.style === "revolved" && Array.isArray(analysis?.geometryRecipe?.revolvedProfile) && analysis.geometryRecipe.revolvedProfile.length >= 4)
  ) {
    return "stepped shaft";
  }

  // 3. Detect Helical / Worm Gear
  if (raw.includes("helical") || gearType === "helical" || (typeof analysis?.helixAngle === "number" && analysis.helixAngle > 0)) {
    return "helical gear";
  }
  if (raw.includes("worm") || gearType === "worm") {
    return "worm gear";
  }

  const ordered = Object.keys(COMPONENT_LABELS).sort((a, b) => b.length - a.length);
  for (const key of ordered) {
    if (raw.includes(key)) return key;
  }
  if (
    raw.includes("gear") ||
    (typeof analysis?.teeth === "number" && analysis.teeth > 0) ||
    analysis?.geometryRecipe?.style === "gear" ||
    analysis?.geometryRecipe?.gear
  ) {
    return "spur gear";
  }
  if (raw.includes("shaft") || raw.includes("cylinder") || analysis?.geometryRecipe?.style === "revolved") {
    return "cylinder/shaft";
  }
  if (raw.includes("flange")) return "flange";
  if (raw.includes("bearing")) return "bearing";
  if (raw.includes("bracket")) return "simple bracket";
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
  const w = p.width || p.length || 2.4;
  const h = p.height || 2.4;
  const d = p.thickness || p.length || 1.6;
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = { featureId: "feature-other-1", featureType: "other" };
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

  // Detect trivial single-box fallback that Gemini returns when it can't determine geometry
  const isTrivialBoxFallback =
    recipe &&
    recipe.style === "combination" &&
    Array.isArray(recipe.primitives) &&
    recipe.primitives.length === 1 &&
    recipe.primitives[0].kind === "box";

  // Detect if component is Bevel Gear
  const isBevel =
    p.type === "bevel gear" ||
    String(analysis?.componentType || "").toLowerCase().includes("bevel") ||
    recipe?.gear?.gearType === "bevel" ||
    (recipe?.gear?.coneAngle && recipe.gear.coneAngle > 0);

  // Detect if component is Stepped Shaft / Spindle
  const isSteppedShaft =
    p.type === "stepped shaft" ||
    String(analysis?.componentType || "").toLowerCase().includes("step") ||
    String(analysis?.componentType || "").toLowerCase().includes("spindle") ||
    (recipe?.style === "revolved" && Array.isArray(recipe?.revolvedProfile) && recipe.revolvedProfile.length >= 4);

  // Check if component is a flange (either by type or features containing flange/bolt holes)
  const isFlange =
    p.type === "flange" ||
    String(analysis?.componentType || "").toLowerCase().includes("flange") ||
    (Array.isArray(analysis?.features) && analysis.features.some((f) => /bolt\s*hole|mounting\s*hole|flange/i.test(String(f))));

  // If component is a flange, but the recipe is 'revolved' (which CANNOT display off-axis bolt holes)
  // or has no bolt holes in recipe, render the true flange geometry with bolt holes!
  const flangeLacksHoles =
    isFlange &&
    (!recipe ||
      recipe.style === "revolved" ||
      (!recipe.flange && (!recipe.holes || recipe.holes.length <= 1)));

  if (isBevel) {
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
  } else if (recipe && !isTrivialBoxFallback) {
    body = executeRecipe(recipe);
    label = String(analysis?.componentType || "other").trim().toUpperCase() || COMPONENT_LABELS.other;
  } else {
    switch (p.type) {
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

/**
 * Verifies that a generated model contains real, finite geometry before the
 * reconstruction is allowed to report completion.
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

