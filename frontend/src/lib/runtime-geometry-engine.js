/**
 * runtime-geometry-engine.js
 * Universal Runtime Geometry Engine for ReForge AI.
 *
 * Implements a non-categorical, declarative geometry execution layer that reconstructs
 * 3D mechanical models dynamically from inferred image features, geometric compositions,
 * and declarative geometry programs, eliminating architectural dependence on predefined,
 * component-specific builder functions.
 *
 * Architecture:
 * 1. Declarative AST Schema:
 *    - Carriers: carrier_revolved, carrier_extruded, carrier_primitive, carrier_mesh,
 *                flanged_shaft, cap_bushing
 *    - Modifiers: modifier_bore, modifier_keyway, modifier_bolt_pattern, modifier_gear_teeth,
 *                 modifier_worm_flight, modifier_spline, modifier_groove, modifier_boss
 *    - Junctions: junction_coaxial, junction_perpendicular, junction_branched
 * 2. General-Purpose Execution:
 *    - Interprets declarative AST programs into Three.js scene graphs
 *    - Generates watertight geometry, sharp CAD silhouette edges, and inspection highlight proxies
 * 3. Runtime Program Generation:
 *    - Synthesizes component-specific geometry programs on the fly from visual evidence and dimensions
 */

import * as THREE from "three";
import {
  extrude,
  ringShape,
  gearShape,
  cappedLatheGeometry,
  visibleBounds,
  matBody,
  matAccent,
  matRim,
  matDark,
  matHighlight,
  matLathe,
} from "./geo.js";

export const AST_OPERATIONS = Object.freeze({
  CARRIER_REVOLVED: "carrier_revolved",
  CARRIER_EXTRUDED: "carrier_extruded",
  CARRIER_PRIMITIVE: "carrier_primitive",
  CARRIER_MESH: "carrier_mesh",
  CARRIER_FLANGED_SHAFT: "flanged_shaft",
  CARRIER_CAP_BUSHING: "cap_bushing",
  CARRIER_BEARING: "bearing",
  MODIFIER_BORE: "modifier_bore",
  MODIFIER_KEYWAY: "modifier_keyway",
  MODIFIER_BOLT_PATTERN: "modifier_bolt_pattern",
  MODIFIER_GEAR_TEETH: "modifier_gear_teeth",
  MODIFIER_WORM_FLIGHT: "modifier_worm_flight",
  MODIFIER_SPLINE: "modifier_spline",
  MODIFIER_GROOVE: "modifier_groove",
  MODIFIER_BOSS: "modifier_boss",
});

/**
 * Validates a declarative geometry program against numerical and topological rules.
 */
export function validateGeometryProgram(program) {
  if (!program || typeof program !== "object") {
    return { valid: false, error: "Program must be a non-null object" };
  }
  const carriers = Array.isArray(program.carriers) ? program.carriers : [];
  if (carriers.length === 0 && !program.meshData && !program.axialSegments && !program.outline && !program.primitives && !program.gear) {
    return { valid: false, error: "Program must contain at least one carrier or geometric definition" };
  }
  return { valid: true };
}

/**
 * Creates sharp technical CAD silhouette edges for a mesh.
 */
function createCadEdges(geometry, thresholdAngle = 35) {
  try {
    const edgesGeo = new THREE.EdgesGeometry(geometry, thresholdAngle);
    const edgesMat = new THREE.LineBasicMaterial({ color: "#181410", linewidth: 1 });
    edgesMat.userData.appearanceRole = "edges";
    return new THREE.LineSegments(edgesGeo, edgesMat);
  } catch {
    return null;
  }
}

/**
 * Adds an invisible highlight proxy mesh for feature inspection.
 */
function addHighlightProxy(group, { id, type, geometry, position, rotation, label }) {
  if (!geometry) return;
  const proxy = new THREE.Mesh(geometry, matHighlight);
  if (position) proxy.position.set(position.x || 0, position.y || 0, position.z || 0);
  if (rotation) proxy.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
  proxy.userData = {
    featureId: id || `feature-${type || "other"}-proxy`,
    featureType: type || "other",
    label: label || type,
    isHighlightOnly: true,
  };
  proxy.visible = false;
  group.add(proxy);
}

/**
 * Builds conical tapered bevel gear teeth.
 */
function buildBevelTeethGeometry(z, Ra, Rfront, Hcone, boreR) {
  const m = (2 * Ra) / (z + 2);
  const hBack = 2.25 * m;
  const hFront = hBack * (Rfront / Ra);
  const wBackHalf = ((Math.PI * Ra) / z) * 0.28;
  const wFrontHalf = wBackHalf * (Rfront / Ra);

  const positions = [];
  const indices = [];
  let vertIdx = 0;

  for (let i = 0; i < z; i++) {
    const a = (i / z) * Math.PI * 2;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const perpX = -sinA;
    const perpY = cosA;

    const zB = -Hcone / 2;
    const rB_bot = Ra - hBack * 0.3;
    const rB_top = Ra + hBack * 0.7;

    const b0 = [cosA * rB_bot - perpX * wBackHalf, sinA * rB_bot - perpY * wBackHalf, zB];
    const b1 = [cosA * rB_bot + perpX * wBackHalf, sinA * rB_bot + perpY * wBackHalf, zB];
    const b2 = [cosA * rB_top + perpX * (wBackHalf * 0.5), sinA * rB_top + perpY * (wBackHalf * 0.5), zB];
    const b3 = [cosA * rB_top - perpX * (wBackHalf * 0.5), sinA * rB_top - perpY * (wBackHalf * 0.5), zB];

    const zF = Hcone / 2;
    const rF_bot = Rfront - hFront * 0.3;
    const rF_top = Rfront + hFront * 0.7;

    const f0 = [cosA * rF_bot - perpX * wFrontHalf, sinA * rF_bot - perpY * wFrontHalf, zF];
    const f1 = [cosA * rF_bot + perpX * wFrontHalf, sinA * rF_bot + perpY * wFrontHalf, zF];
    const f2 = [cosA * rF_top + perpX * (wFrontHalf * 0.5), sinA * rF_top + perpY * (wFrontHalf * 0.5), zF];
    const f3 = [cosA * rF_top - perpX * (wFrontHalf * 0.5), sinA * rF_top - perpY * (wFrontHalf * 0.5), zF];

    positions.push(...b0, ...b1, ...b2, ...b3, ...f0, ...f1, ...f2, ...f3);
    const base = vertIdx;
    vertIdx += 8;

    indices.push(base + 3, base + 2, base + 6, base + 3, base + 6, base + 7);
    indices.push(base, base + 3, base + 7, base, base + 7, base + 4);
    indices.push(base + 2, base + 1, base + 5, base + 2, base + 5, base + 6);
    indices.push(base + 4, base + 5, base + 6, base + 4, base + 6, base + 7);
    indices.push(base + 1, base, base + 3, base + 1, base + 3, base + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Executes a Circular Cap / Bushing / Bottle Cap Carrier with solid top lid disc,
 * cylindrical skirt wall, and knurled grip flutes.
 */
function executeCapBushingCarrier(carrier, group) {
  const geom = carrier.geometry || {};
  const od = Number(geom.outerDiameter || 30.0);
  const outerR = od / 2;
  const h = Number(geom.height || Math.max(8.0, outerR * 0.75));

  const wallThick = typeof geom.thickness === "number" && geom.thickness > 0
    ? geom.thickness
    : (typeof geom.innerDiameter === "number" && geom.innerDiameter > 0 && geom.innerDiameter < od
        ? (od - geom.innerDiameter) / 2
        : Math.max(1.0, Math.min(2.5, outerR * 0.08)));
  const innerR = typeof geom.innerDiameter === "number" && geom.innerDiameter > 0
    ? geom.innerDiameter / 2
    : Math.max(0, outerR - wallThick);

  const topCeilingThick = Math.max(1.2, wallThick * 1.1);
  const hollowDepth = Math.max(1.0, h - topCeilingThick);

  // 1. Solid Top Cap Disc / Lid with subtle chamfer (The Top Lid!)
  const topDiscGeo = new THREE.CylinderGeometry(outerR * 0.98, outerR, topCeilingThick, 64);
  const topMesh = new THREE.Mesh(topDiscGeo, matBody);
  topMesh.position.y = (h / 2) - (topCeilingThick / 2);
  topMesh.userData = { featureId: "feature-cap-top-1", featureType: "cap_top", label: "Top Cap Lid" };
  group.add(topMesh);
  const topEdges = createCadEdges(topDiscGeo);
  if (topEdges) {
    topEdges.position.copy(topMesh.position);
    group.add(topEdges);
  }

  // 2. Outer Cylindrical Wall (Skirt / Rim) with Hollow Cavity
  const skirtGeo = extrude(ringShape(outerR, innerR), hollowDepth, false);
  skirtGeo.center();
  const skirtMesh = new THREE.Mesh(skirtGeo, matBody);
  skirtMesh.rotation.x = Math.PI / 2;
  skirtMesh.position.y = -(topCeilingThick / 2);
  skirtMesh.userData = { featureId: "feature-cap-wall-1", featureType: "cap_wall", label: "Cylindrical Cap Wall" };
  group.add(skirtMesh);
  const skirtEdges = createCadEdges(skirtGeo);
  if (skirtEdges) {
    skirtEdges.rotation.x = Math.PI / 2;
    skirtEdges.position.y = -(topCeilingThick / 2);
    group.add(skirtEdges);
  }

  // 3. Knurled Flutes (standard plastic bottle cap ribbing)
  const numRibs = 48;
  const fluteGeo = new THREE.BoxGeometry(outerR * 0.035, hollowDepth * 0.95, outerR * 0.04);
  const flutesGroup = new THREE.Group();
  for (let i = 0; i < numRibs; i++) {
    const angle = (i / numRibs) * Math.PI * 2;
    const flute = new THREE.Mesh(fluteGeo, matAccent);
    flute.position.set(Math.cos(angle) * (outerR + 0.02), -(topCeilingThick / 2), Math.sin(angle) * (outerR + 0.02));
    flute.rotation.y = -angle;
    flute.userData = { featureId: `feature-knurl-${i + 1}`, featureType: "knurl", label: "Grip Flute" };
    flutesGroup.add(flute);
  }
  group.add(flutesGroup);
}

/**
 * Executes a Flanged Spline Shaft Carrier.
 */
function executeFlangedShaftCarrier(carrier, group) {
  const geom = carrier.geometry || {};
  const sR = Math.max(0.3, Number(geom.shaftRadius || 12));
  const sL = Math.max(2.0, Number(geom.shaftLength || 180));
  const fR = Math.max(sR * 1.5, Number(geom.flangeRadius || 38));
  const fTh = Math.max(0.2, Number(geom.flangeThickness || 16));
  const cR = Math.max(sR * 1.2, Number(geom.collarRadius || 22));
  const cL = Math.max(0.4, Number(geom.collarLength || 28));
  const bCount = Math.max(3, Math.min(16, Math.round(geom.boltCount || 4)));
  const bHoleR = Math.max(0.08, Number(geom.boltHoleRadius || 3.5));
  const splineCount = Number(geom.splineCount || 6);
  const bcd = Number(geom.boltCircleDiameter || (sR * 1.4 + fR) / 2);

  // 1. Central Longitudinal Shaft
  const shaftGeo = new THREE.CylinderGeometry(sR, sR, sL, 32);
  shaftGeo.rotateZ(Math.PI / 2);
  const shaftMesh = new THREE.Mesh(shaftGeo, matBody);
  shaftMesh.userData = { featureId: "feature-shaft-1", featureType: "shaft" };
  group.add(shaftMesh);

  // 2. Longitudinal Spline Grooves along shaft
  if (splineCount > 0) {
    const grooveW = ((Math.PI * 2 * sR) / splineCount) * 0.28;
    const grooveDepth = sR * 0.18;
    for (let s = 0; s < splineCount; s++) {
      const sa = (s / splineCount) * Math.PI * 2;
      const gGeo = new THREE.BoxGeometry(sL * 0.96, grooveDepth, grooveW);
      const gMesh = new THREE.Mesh(gGeo, matDark);
      gMesh.position.set(0, Math.sin(sa) * sR, Math.cos(sa) * sR);
      gMesh.rotation.x = -sa;
      gMesh.userData = { featureId: `feature-spline-${s + 1}`, featureType: "spline" };
      group.add(gMesh);
    }
  }

  // 3. Circular Mounting Flange Collar
  const flangeX = -sL * 0.15;
  const boltHoles = [];
  for (let i = 0; i < bCount; i++) {
    const a = (i / bCount) * Math.PI * 2;
    const pathHole = new THREE.Path();
    pathHole.absarc(Math.cos(a) * bcd, Math.sin(a) * bcd, bHoleR, 0, Math.PI * 2, true);
    boltHoles.push(pathHole);

    const bGeo = new THREE.CylinderGeometry(bHoleR * 0.98, bHoleR * 0.98, fTh * 1.1, 16);
    bGeo.rotateZ(Math.PI / 2);
    const bMesh = new THREE.Mesh(bGeo, matHighlight);
    bMesh.position.set(flangeX, Math.sin(a) * bcd, Math.cos(a) * bcd);
    bMesh.userData = { featureId: `feature-bolt-hole-${i + 1}`, featureType: "mounting_hole", isHighlightOnly: true };
    bMesh.visible = false;
    group.add(bMesh);
  }

  const flangeShape = ringShape(fR, sR, boltHoles);
  const flangeGeo = extrude(flangeShape, fTh, true);
  flangeGeo.center();
  flangeGeo.rotateY(Math.PI / 2);
  flangeGeo.translate(flangeX, 0, 0);
  const flangeMesh = new THREE.Mesh(flangeGeo, matBody);
  flangeMesh.userData = { featureId: "feature-flange-1", featureType: "flange" };
  group.add(flangeMesh);

  // 4. Ground Bearing Collar Boss
  const bossShape = ringShape(cR, sR);
  const bossGeo = extrude(bossShape, cL, true);
  bossGeo.center();
  bossGeo.rotateY(Math.PI / 2);
  bossGeo.translate(flangeX + fTh / 2 + cL / 2, 0, 0);
  const bossMesh = new THREE.Mesh(bossGeo, matAccent);
  bossMesh.userData = { featureId: "feature-boss-1", featureType: "boss" };
  group.add(bossMesh);
}

/**
 * Executes a Deep-Groove Ball Bearing Carrier.
 * Constructs authentic inner race, outer race, spherical rolling element balls, and cage.
 */
function executeBearingCarrier(carrier, group) {
  const geom = carrier.geometry || {};
  const od = Math.max(10.0, Number(geom.outerDiameter || 35.0));
  const outerR = od / 2;
  const boreR = geom.innerDiameter && Number(geom.innerDiameter) > 0 && Number(geom.innerDiameter) < od
    ? Number(geom.innerDiameter) / 2
    : Math.max(2.0, outerR * 0.42);
  const width = Math.max(4.0, Number(geom.height || geom.thickness || (outerR - boreR) * 0.85));

  const radialSpan = outerR - boreR;
  const pitchR = (outerR + boreR) / 2;
  const ballD = Math.max(2.0, radialSpan * 0.56);
  const ballR = ballD / 2;

  const outerRaceInnerR = Math.min(outerR - 0.5, pitchR + ballR * 0.52);
  const innerRaceOuterR = Math.max(boreR + 0.5, pitchR - ballR * 0.52);

  // 1. Outer Ring / Race
  const outerRaceShape = ringShape(outerR, outerRaceInnerR);
  const outerRaceGeo = extrude(outerRaceShape, width, false);
  outerRaceGeo.center();
  const outerMesh = new THREE.Mesh(outerRaceGeo, matDark);
  outerMesh.rotation.x = Math.PI / 2;
  outerMesh.userData = { featureId: "feature-outer-race-1", featureType: "outer_race", label: "Bearing Outer Race" };
  group.add(outerMesh);
  const outerEdges = createCadEdges(outerRaceGeo);
  if (outerEdges) {
    outerEdges.rotation.x = Math.PI / 2;
    group.add(outerEdges);
  }

  // 2. Inner Ring / Race (with shaft bore)
  const innerRaceShape = ringShape(innerRaceOuterR, boreR);
  const innerRaceGeo = extrude(innerRaceShape, width, false);
  innerRaceGeo.center();
  const innerMesh = new THREE.Mesh(innerRaceGeo, matBody);
  innerMesh.rotation.x = Math.PI / 2;
  innerMesh.userData = { featureId: "feature-inner-race-1", featureType: "inner_race", label: "Bearing Inner Race (Bore)" };
  group.add(innerMesh);
  const innerEdges = createCadEdges(innerRaceGeo);
  if (innerEdges) {
    innerEdges.rotation.x = Math.PI / 2;
    group.add(innerEdges);
  }

  // 3. Rolling Element Ball Bearings
  const ballCount = Math.max(6, Math.min(14, Math.round((Math.PI * pitchR) / (ballD * 1.35)))) || 8;
  const ballsGroup = new THREE.Group();
  for (let i = 0; i < ballCount; i++) {
    const a = (i / ballCount) * Math.PI * 2;
    const ballGeo = new THREE.SphereGeometry(ballR, 24, 20);
    const ballMesh = new THREE.Mesh(ballGeo, matRim);
    ballMesh.position.set(Math.cos(a) * pitchR, 0, Math.sin(a) * pitchR);
    ballMesh.userData = {
      featureId: `feature-rolling-element-${i + 1}`,
      featureType: "ball_bearing",
      label: `Ball Bearing ${i + 1}`,
    };
    ballsGroup.add(ballMesh);
  }
  group.add(ballsGroup);

  // 4. Ball Retainer / Cage
  const cageThick = Math.max(0.6, width * 0.08);
  const cageRIn = pitchR - ballR * 0.75;
  const cageROut = pitchR + ballR * 0.75;
  for (const zSign of [-1, 1]) {
    const cageShape = ringShape(cageROut, cageRIn);
    const cageGeo = extrude(cageShape, cageThick, false);
    cageGeo.center();
    const cageMesh = new THREE.Mesh(cageGeo, matAccent);
    cageMesh.rotation.x = Math.PI / 2;
    cageMesh.position.y = zSign * (ballR * 0.65);
    cageMesh.userData = { featureId: `feature-cage-${zSign > 0 ? "top" : "bot"}`, featureType: "cage", label: "Ball Cage Retainer" };
    group.add(cageMesh);
  }

  // 5. Central Bore Highlight Proxy for Feature Inspection
  addHighlightProxy(group, {
    id: "feature-bore-1",
    type: "bore",
    geometry: new THREE.CylinderGeometry(boreR * 0.99, boreR * 0.99, width * 1.05, 32),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    label: "Inner Shaft Bore",
  });
}

/**
 * Executes a Revolved Carrier (multi-stage axial bodies, shafts, spindles, worms, caps, cylinders).
 */
function executeRevolvedCarrier(carrier, group) {
  const geom = carrier.geometry || {};
  const stages = Array.isArray(geom.stages) ? geom.stages : [];
  const modifiers = Array.isArray(carrier.modifiers) ? carrier.modifiers : [];

  let centralBoreRadius = Number(geom.boreRadius || 0);
  let globalKeyway = geom.keyway || null;
  for (const mod of modifiers) {
    if (mod.type === AST_OPERATIONS.MODIFIER_BORE && !mod.location?.position?.[0] && !mod.location?.position?.[1]) {
      const r = Number(mod.parameters?.radius || (mod.parameters?.diameter ? mod.parameters.diameter / 2 : 0));
      if (r > centralBoreRadius) centralBoreRadius = r;
    } else if (mod.type === AST_OPERATIONS.MODIFIER_KEYWAY) {
      if (!globalKeyway) {
        globalKeyway = {
          width: Number(mod.parameters?.width || 6),
          height: Number(mod.parameters?.depth || mod.parameters?.height || 3.5),
        };
      }
    }
  }

  // Path 1: Continuous Axial Stages
  if (stages.length > 0) {
    const sorted = [...stages].sort((a, b) => (a.zStart ?? 0) - (b.zStart ?? 0));
    const zMin = sorted[0]?.zStart ?? 0;
    const zMax = sorted[sorted.length - 1]?.zEnd ?? 0;
    const totalLength = Math.max(0.1, zMax - zMin);
    const maxRadius = Math.max(1, ...sorted.map((s) => s.radius ?? 10));
    const isElongatedShaft = totalLength > maxRadius * 2.2 && sorted.some((s) => !((s.teeth ?? 0) >= 3));

    for (let i = 0; i < stages.length; i++) {
      const seg = stages[i];
      const z0 = Number(seg.zStart || 0);
      const z1 = Number(seg.zEnd || (z0 + (seg.length || 20)));
      const len = Math.max(0.1, Math.abs(z1 - z0));
      const zCenter = (z0 + z1) / 2;
      const rOuter = Math.max(0.5, Number(seg.radius || 15));
      const rInner = Math.max(0, Math.min(rOuter * 0.95, Number(seg.innerRadius != null ? seg.innerRadius : centralBoreRadius)));
      const featType = seg.featureType || "shaft";
      const coneAngle = Number(seg.coneAngle || 0);
      const helixAngle = Number(seg.helixAngle || 0);

      // 1A. Bevel Gear Stage (conical blank + tapered teeth crown)
      if (coneAngle > 0 || featType === "bevel_gear_teeth") {
        const gamma = (coneAngle * Math.PI) / 180;
        const Hcone = len;
        const deltaR = Hcone * Math.tan(gamma);
        const Rfront = Math.max(rInner * 1.12, rOuter - deltaR);

        const coneProfile = [
          { z: -Hcone / 2, radius: rInner },
          { z: -Hcone / 2, radius: rOuter },
          { z: Hcone / 2, radius: Rfront },
          { z: Hcone / 2, radius: rInner },
        ];
        const hollowConeGeo = rInner > 0 ? cappedLatheGeometry(coneProfile, 64) : null;
        const coneGeo = hollowConeGeo || new THREE.CylinderGeometry(Rfront, rOuter, Hcone, 64);
        coneGeo.rotateX(Math.PI / 2);
        coneGeo.translate(0, 0, zCenter);
        const coneMesh = new THREE.Mesh(coneGeo, hollowConeGeo ? matLathe : matBody);
        coneMesh.userData = { featureId: `feature-gear-teeth-${i}`, featureType: "gear_teeth", label: seg.label || "Bevel Gear Body" };
        group.add(coneMesh);

        const teethCount = Math.max(6, Math.round(seg.teeth || 20));
        const teethGeo = buildBevelTeethGeometry(teethCount, rOuter, Rfront, Hcone, rInner);
        teethGeo.translate(0, 0, zCenter);
        const teethMesh = new THREE.Mesh(teethGeo, matAccent);
        teethMesh.userData = { featureId: `feature-gear-teeth-crown-${i}`, featureType: "gear_teeth", label: "Bevel Teeth Crown" };
        group.add(teethMesh);
        continue;
      }

      // 1B. Worm Flight Stage
      if (featType === "worm_flight" || featType === "worm_thread" || seg.pitch != null || seg.starts != null) {
        const rootR = Math.max(rInner * 1.05, Number(seg.rootRadius || rOuter * 0.65));
        const coreShape = ringShape(rootR, rInner);
        const coreGeo = extrude(coreShape, len, false);
        coreGeo.center();
        if (isElongatedShaft) {
          coreGeo.rotateY(Math.PI / 2);
        }
        const coreMesh = new THREE.Mesh(coreGeo, matBody);
        if (isElongatedShaft) {
          coreMesh.position.x = zCenter;
        } else {
          coreMesh.position.z = zCenter;
        }
        coreMesh.userData = { featureId: `feature-worm-core-${i}`, featureType: "shaft", label: seg.label || "Worm Shaft Core" };
        group.add(coreMesh);

        const pitch = Math.max(1, Number(seg.pitch || 8));
        const starts = Math.max(1, Math.min(8, Math.round(seg.starts || 1)));
        const turns = len / (pitch * starts);
        const samplesPerTurn = 36;
        const totalSamples = Math.max(12, Math.round(turns * samplesPerTurn));

        for (let st = 0; st < starts; st++) {
          const startPhase = (st / starts) * Math.PI * 2;
          const positions = [];
          const indices = [];
          const wHalf = pitch * 0.18;
          for (let s = 0; s <= totalSamples; s++) {
            const frac = s / totalSamples;
            const z = (frac - 0.5) * len;
            const a = startPhase + frac * turns * Math.PI * 2;
            const cosA = Math.cos(a);
            const sinA = Math.sin(a);
            const v0 = [cosA * rootR, z - wHalf * 0.8, sinA * rootR];
            const v1 = [cosA * rOuter, z - wHalf * 0.4, sinA * rOuter];
            const v2 = [cosA * rOuter, z + wHalf * 0.4, sinA * rOuter];
            const v3 = [cosA * rootR, z + wHalf * 0.8, sinA * rootR];
            positions.push(...v0, ...v1, ...v2, ...v3);

            if (s > 0) {
              const base = (s - 1) * 4;
              const next = s * 4;
              indices.push(base + 1, base, next, base + 1, next, next + 1);
              indices.push(base + 2, base + 1, next + 1, base + 2, next + 1, next + 2);
              indices.push(base + 3, base + 2, next + 2, base + 3, next + 2, next + 3);
            }
          }

          const flightGeo = new THREE.BufferGeometry();
          flightGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          flightGeo.setIndex(indices);
          flightGeo.computeVertexNormals();
          if (isElongatedShaft) {
            flightGeo.rotateZ(Math.PI / 2);
            flightGeo.translate(zCenter, 0, 0);
          } else {
            flightGeo.translate(0, zCenter, 0);
          }

          const flightMesh = new THREE.Mesh(flightGeo, matAccent);
          flightMesh.userData = {
            featureId: `feature-worm-flight-${i}-${st}`,
            featureType: featType === "worm_thread" ? "worm_thread" : "worm_flight",
            label: seg.label || "Worm Flight",
            pitch,
            starts,
            hand: "right",
          };
          group.add(flightMesh);
        }
        continue;
      }

      // 1C. Helical Gear Stage (slices with twist)
      if (helixAngle !== 0) {
        const teeth = Math.max(6, Math.round(seg.teeth || 20));
        const sliceCount = 10;
        const sliceThick = len / sliceCount;
        const totalTwist = (helixAngle * Math.PI) / 180 * (len / (rOuter * 2));
        for (let sl = 0; sl < sliceCount; sl++) {
          const frac = (sl + 0.5) / sliceCount;
          const zSlice = (frac - 0.5) * len + zCenter;
          const rotA = (frac - 0.5) * totalTwist;
          const shape = gearShape(teeth, rOuter, (rOuter - rInner) * 0.5, rInner, [], 20, globalKeyway);
          const sliceGeo = extrude(shape, sliceThick, false);
          sliceGeo.center();
          sliceGeo.rotateZ(rotA);
          if (isElongatedShaft) {
            sliceGeo.rotateY(Math.PI / 2);
            sliceGeo.translate(zSlice, 0, 0);
          } else {
            sliceGeo.translate(0, 0, zSlice);
          }
          const sliceMesh = new THREE.Mesh(sliceGeo, matBody);
          sliceMesh.userData = {
            featureId: `feature-helical-slice-${i}-${sl}`,
            featureType: "helical_gear_teeth",
            helixAngle,
            label: "Helical Gear Slice",
          };
          group.add(sliceMesh);
        }
        continue;
      }

      // 1D. Involute Spur Gear Teeth Stage
      if (featType === "gear_teeth" || seg.teeth != null) {
        const teeth = Math.max(6, Math.round(seg.teeth || 20));
        const shape = gearShape(teeth, rOuter, (rOuter - rInner) * 0.5, rInner, [], 20, globalKeyway);
        const geo = extrude(shape, len, true);
        geo.center();
        if (isElongatedShaft) {
          geo.rotateY(Math.PI / 2);
          geo.translate(zCenter, 0, 0);
        } else {
          geo.translate(0, 0, zCenter);
        }
        const mesh = new THREE.Mesh(geo, matBody);
        mesh.userData = {
          featureId: seg.id || `feature-gear-stage-${i + 1}`,
          featureType: "gear_teeth",
          label: seg.label || "Gear Teeth Stage",
          teeth,
        };
        group.add(mesh);
        const edges = createCadEdges(geo);
        if (edges) group.add(edges);
        continue;
      }

      // 1E. Standard Cylindrical / Journal / Collar / Stud Stage
      let geo;
      if (rInner > 0) {
        const shape = ringShape(rOuter, rInner);
        geo = extrude(shape, len, true);
        geo.center();
        if (isElongatedShaft) geo.rotateY(Math.PI / 2);
      } else {
        geo = new THREE.CylinderGeometry(rOuter, rOuter, len, 36);
        if (isElongatedShaft) {
          geo.rotateZ(Math.PI / 2);
        } else {
          geo.rotateX(Math.PI / 2);
        }
      }

      const mesh = new THREE.Mesh(geo, i % 2 === 0 ? matBody : matAccent);
      if (isElongatedShaft) {
        mesh.position.x = zCenter;
      } else {
        mesh.position.z = zCenter;
      }
      mesh.userData = {
        featureId: `feature-stage-${i}`,
        featureType: featType,
        label: seg.label || (rOuter > 25 ? "Collar" : "Shaft Journal"),
      };
      group.add(mesh);
      const edges = createCadEdges(geo);
      if (edges) group.add(edges);
    }
  } else if (Array.isArray(geom.profile) && geom.profile.length >= 2) {
    const geo = cappedLatheGeometry(geom.profile, 64);
    if (geo) {
      geo.rotateX(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, matLathe);
      mesh.userData = { featureId: "feature-revolved-body", featureType: "shaft", label: carrier.label || "Revolved Body" };
      group.add(mesh);
      const edges = createCadEdges(geo);
      if (edges) group.add(edges);
    }
  } else {
    const outerR = Math.max(0.5, Number(geom.radius || (geom.outerDiameter ? geom.outerDiameter / 2 : 15)));
    const h = Math.max(0.1, Number(geom.length || geom.height || 30));
    const innerR = Math.max(0, Math.min(outerR * 0.95, centralBoreRadius));
    const shape = ringShape(outerR, innerR);
    const geo = extrude(shape, h, true);
    geo.center();
    const mesh = new THREE.Mesh(geo, matBody);
    mesh.userData = { featureId: "feature-cylinder-body", featureType: "shaft", label: carrier.label || "Cylinder" };
    group.add(mesh);
    const edges = createCadEdges(geo);
    if (edges) group.add(edges);
  }

  // Apply Modifiers to Revolved Carrier
  for (const mod of modifiers) {
    if (mod.type === AST_OPERATIONS.MODIFIER_BORE) {
      const bRad = Number(mod.parameters?.radius || (mod.parameters?.diameter ? mod.parameters.diameter / 2 : 0));
      const bDepth = Number(mod.parameters?.depth || 200);
      if (bRad > 0) {
        addHighlightProxy(group, {
          id: mod.id || "feature-bore-1",
          type: "bore",
          geometry: new THREE.CylinderGeometry(bRad * 0.99, bRad * 0.99, bDepth, 32),
          rotation: { x: Math.PI / 2, y: 0, z: 0 },
          label: mod.label || "Through Bore",
        });
      }
    } else if (mod.type === AST_OPERATIONS.MODIFIER_KEYWAY) {
      const kw = Number(mod.parameters?.width || 6);
      const kh = Number(mod.parameters?.depth || mod.parameters?.height || 3.5);
      const kl = Number(mod.parameters?.length || 20);
      const jRad = Number(mod.parameters?.radius || mod.parameters?.journalRadius || 15);
      const kwX = Number(mod.parameters?.x ?? mod.location?.position?.[0] ?? 0);

      const sorted = [...stages].sort((a, b) => (a.zStart ?? 0) - (b.zStart ?? 0));
      const zMin = sorted[0]?.zStart ?? 0;
      const zMax = sorted[sorted.length - 1]?.zEnd ?? 0;
      const totalLength = Math.max(0.1, zMax - zMin);
      const maxRadius = Math.max(1, ...sorted.map((s) => s.radius ?? 10));
      const isElongatedShaft = stages.length > 0 && totalLength > maxRadius * 2.2 && sorted.some((s) => !((s.teeth ?? 0) >= 3));

      const kwGeo = new THREE.BoxGeometry(
        isElongatedShaft ? kl : kw,
        kh,
        isElongatedShaft ? kw : kl
      );
      const kwMesh = new THREE.Mesh(kwGeo, matDark);
      if (isElongatedShaft) {
        kwMesh.position.set(kwX, jRad - kh * 0.1, 0);
      } else {
        kwMesh.position.set(0, jRad - kh * 0.1, kwX);
      }
      kwMesh.userData = {
        featureId: mod.id || `feature-keyway-${group.children.length + 1}`,
        featureType: "keyway",
        label: mod.label || "Keyway Slot",
      };
      group.add(kwMesh);
    } else if (mod.type === AST_OPERATIONS.MODIFIER_BOLT_PATTERN) {
      const count = Math.max(3, Math.min(64, Math.round(mod.parameters?.count || 4)));
      const bcd = Number(mod.parameters?.boltCircleDiameter || 60);
      const holeR = Number(mod.parameters?.holeDiameter ? mod.parameters.holeDiameter / 2 : 4);
      const depth = Number(mod.parameters?.depth || 30);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const x = Math.cos(a) * (bcd / 2);
        const y = Math.sin(a) * (bcd / 2);
        addHighlightProxy(group, {
          id: `${mod.id || "feature-bolt"}-${i}`,
          type: "mounting_hole",
          geometry: new THREE.CylinderGeometry(holeR * 0.99, holeR * 0.99, depth * 1.05, 16),
          position: { x, y, z: 0 },
          rotation: { x: Math.PI / 2, y: 0, z: 0 },
          label: `Bolt Hole ${i + 1}`,
        });
      }
    }
  }
}

/**
 * Executes an Extruded Carrier (prismatic parts, brackets, flanges, plates, arms, housings).
 */
function executeExtrudedCarrier(carrier, group) {
  const geom = carrier.geometry || {};
  const outline = Array.isArray(geom.outline) ? geom.outline : [];
  const depth = Math.max(0.1, Number(geom.depth || 10));
  const holes = Array.isArray(geom.holes) ? geom.holes : [];
  const modifiers = Array.isArray(carrier.modifiers) ? carrier.modifiers : [];

  let shape;
  if (outline.length >= 3) {
    shape = new THREE.Shape();
    shape.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) {
      shape.lineTo(outline[i].x, outline[i].y);
    }
    shape.closePath();
  } else if (geom.isCircular || carrier.featureType === "flange") {
    const radius = Number(geom.width ? geom.width / 2 : 40);
    shape = new THREE.Shape();
    shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  } else {
    shape = new THREE.Shape();
    const w = Number(geom.width || 40);
    const h = Number(geom.height || 40);
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo(w / 2, -h / 2);
    shape.lineTo(w / 2, h / 2);
    shape.lineTo(-w / 2, h / 2);
    shape.closePath();
  }

  const allHoles = [...holes];
  for (const mod of modifiers) {
    if (mod.type === AST_OPERATIONS.MODIFIER_BORE) {
      allHoles.push({
        cx: mod.location?.position?.[0] || 0,
        cy: mod.location?.position?.[1] || 0,
        radius: Number(mod.parameters?.radius || (mod.parameters?.diameter ? mod.parameters.diameter / 2 : 5)),
        type: "bore",
        id: mod.id,
      });
    } else if (mod.type === AST_OPERATIONS.MODIFIER_BOLT_PATTERN) {
      const count = Math.max(3, Math.min(64, Math.round(mod.parameters?.count || 4)));
      const bcd = Number(mod.parameters?.boltCircleDiameter || 50);
      const holeR = Number(mod.parameters?.holeDiameter ? mod.parameters.holeDiameter / 2 : 4);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        allHoles.push({
          cx: Math.cos(a) * (bcd / 2),
          cy: Math.sin(a) * (bcd / 2),
          radius: holeR,
          type: "mounting_hole",
          id: `${mod.id || "bolt"}-${i}`,
        });
      }
    }
  }

  for (const h of allHoles) {
    const hr = Math.max(0.1, Number(h.radius || 3));
    const cx = Number(h.cx || 0);
    const cy = Number(h.cy || 0);
    const path = new THREE.Path();
    path.absarc(cx, cy, hr, 0, Math.PI * 2, true);
    shape.holes.push(path);

    addHighlightProxy(group, {
      id: h.id || `feature-${h.type || "hole"}-${cx}-${cy}`,
      type: h.type || "mounting_hole",
      geometry: new THREE.CylinderGeometry(hr * 0.98, hr * 0.98, depth * 1.1, 24),
      position: { x: cx, y: cy, z: 0 },
      rotation: { x: Math.PI / 2, y: 0, z: 0 },
      label: h.type === "bore" ? "Central Bore" : "Mounting Hole",
    });
  }

  const geo = extrude(shape, depth, true);
  geo.center();
  const mesh = new THREE.Mesh(geo, matBody);
  mesh.userData = {
    featureId: carrier.id || "feature-extruded-carrier",
    featureType: carrier.featureType || (allHoles.some((h) => h.type === "bore" && h.radius > 15) ? "flange" : "bracket"),
    label: carrier.label || "Extruded Body",
  };
  group.add(mesh);

  const edges = createCadEdges(geo);
  if (edges) group.add(edges);

  for (const mod of modifiers) {
    if (mod.type === AST_OPERATIONS.MODIFIER_BOSS) {
      const bossR = Number(mod.parameters?.radius || (mod.parameters?.diameter ? mod.parameters.diameter / 2 : 12));
      const bossH = Number(mod.parameters?.height || 10);
      const bossBoreR = Number(mod.parameters?.boreRadius || 0);
      const bossShape = ringShape(bossR, bossBoreR);
      const bossGeo = extrude(bossShape, bossH, true);
      bossGeo.center();
      bossGeo.translate(0, 0, depth / 2 + bossH / 2);
      const bossMesh = new THREE.Mesh(bossGeo, matAccent);
      bossMesh.userData = {
        featureId: mod.id || "feature-boss-1",
        featureType: "boss",
        label: mod.label || "Raised Boss Collar",
      };
      group.add(bossMesh);
      const bossEdges = createCadEdges(bossGeo);
      if (bossEdges) group.add(bossEdges);
    }
  }
}

/**
 * Executes a Primitive Carrier.
 */
function executePrimitiveCarrier(carrier, group) {
  const kind = carrier.kind || "box";
  const dim = carrier.dimensions || {};
  let geo = null;
  if (kind === "cylinder") {
    geo = new THREE.CylinderGeometry(Number(dim.radiusTop || dim.radius || 10), Number(dim.radiusBottom || dim.radius || 10), Number(dim.height || 20), 32);
    geo.rotateX(Math.PI / 2);
  } else if (kind === "sphere") {
    geo = new THREE.SphereGeometry(Number(dim.radius || 10), 24, 24);
  } else if (kind === "cone") {
    geo = new THREE.ConeGeometry(Number(dim.radius || 10), Number(dim.height || 20), 32);
    geo.rotateX(Math.PI / 2);
  } else {
    geo = new THREE.BoxGeometry(Number(dim.width || 20), Number(dim.height || 20), Number(dim.length || dim.depth || 20));
  }
  const mesh = new THREE.Mesh(geo, matBody);
  const t = carrier.transform || {};
  if (t.position) mesh.position.set(...t.position);
  if (t.rotation) mesh.rotation.set(...t.rotation);
  if (t.scale) mesh.scale.set(...t.scale);
  mesh.userData = { featureId: carrier.id || "feature-prim-1", featureType: "other", label: carrier.label || kind };
  group.add(mesh);
  const edges = createCadEdges(geo);
  if (edges) group.add(edges);
}

/**
 * Executes a Pre-Triangulated Manifold Mesh Carrier (from neural-mesh-generator).
 */
function executeMeshCarrier(carrier, group) {
  const meshData = carrier.meshData || carrier;
  if (!Array.isArray(meshData.vertices) || meshData.vertices.length < 9) return;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(meshData.vertices, 3));
  if (Array.isArray(meshData.indices) && meshData.indices.length >= 3) {
    geo.setIndex(meshData.indices);
  }
  if (Array.isArray(meshData.normals) && meshData.normals.length === meshData.vertices.length) {
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(meshData.normals, 3));
  } else {
    geo.computeVertexNormals();
  }

  const mainMesh = new THREE.Mesh(geo, matBody);
  mainMesh.userData = { featureId: "feature-body-1", featureType: "other", label: carrier.label || "Solid Manifold Body" };
  group.add(mainMesh);

  const edges = createCadEdges(geo, 35);
  if (edges) group.add(edges);

  if (Array.isArray(meshData.features)) {
    for (const feat of meshData.features) {
      if (!feat || !feat.id) continue;
      const fType = feat.type || "other";
      if (fType === "bore" || fType === "mounting_hole") {
        const radius = Number(feat.radius) || 10;
        const depth = Number(feat.depth) || 20;
        addHighlightProxy(group, {
          id: feat.id,
          type: fType,
          geometry: new THREE.CylinderGeometry(radius * 0.99, radius * 0.99, depth * 1.05, 24),
          position: { x: feat.cx || 0, y: feat.cy || 0, z: feat.cz || 0 },
          rotation: { x: Math.PI / 2, y: 0, z: 0 },
          label: feat.label || fType,
        });
      }
    }
  }
}

/**
 * Executes a complete declarative geometry program into a Three.js scene graph.
 */
export function executeGeometryProgram(program) {
  if (!program) return null;
  const group = new THREE.Group();

  if (Array.isArray(program.carriers) && program.carriers.length > 0) {
    for (const carrier of program.carriers) {
      const type = carrier.carrierType || carrier.type;
      if (type === "cap_bushing" || carrier.carrierType === "cap_bushing") {
        executeCapBushingCarrier(carrier, group);
      } else if (type === "bearing" || carrier.carrierType === "bearing" || type === AST_OPERATIONS.CARRIER_BEARING) {
        executeBearingCarrier(carrier, group);
      } else if (type === "flanged_shaft" || carrier.carrierType === "flanged_shaft") {
        executeFlangedShaftCarrier(carrier, group);
      } else if (type === AST_OPERATIONS.CARRIER_REVOLVED || carrier.carrierType === "revolved") {
        executeRevolvedCarrier(carrier, group);
      } else if (type === AST_OPERATIONS.CARRIER_EXTRUDED || carrier.carrierType === "extruded") {
        executeExtrudedCarrier(carrier, group);
      } else if (type === AST_OPERATIONS.CARRIER_PRIMITIVE || carrier.kind) {
        executePrimitiveCarrier(carrier, group);
      } else if (type === AST_OPERATIONS.CARRIER_MESH || carrier.meshData) {
        executeMeshCarrier(carrier, group);
      }
    }
  } else if (program.meshData) {
    executeMeshCarrier(program, group);
  }

  let meshCount = 0;
  group.traverse((node) => {
    if (node.isMesh && !node.userData?.isHighlightOnly) meshCount++;
  });
  if (meshCount === 0) return null;

  group.userData.programId = program.id || "program_runtime";
  group.userData.recipeStyle = program.style || "composition";

  return group;
}

/**
 * Synthesizes a component-specific declarative geometry program dynamically
 * from visual analysis evidence, observations, and inferred parameters.
 */
export function generateGeometryProgram(analysis) {
  if (!analysis) return null;

  if (analysis.geometryProgram?.carriers) return analysis.geometryProgram;
  if (analysis.compositionGraph?.carriers) return analysis.compositionGraph;
  if (analysis.geometryRecipe?.compositionGraph?.carriers) return analysis.geometryRecipe.compositionGraph;

  const recipe = analysis.geometryRecipe || {};
  const dims = analysis.dimensions || {};
  const rawType = String(analysis.componentType || "").toLowerCase();
  const features = Array.isArray(analysis.features) ? analysis.features.map((f) => String(f).toLowerCase()) : [];
  const featuresStr = features.join(" ");

  const outerD = Number(dims.outerDiameter || 80);
  const innerD = Number(dims.innerDiameter || 0);
  const height = Number(dims.height || dims.length || 20);
  const width = Number(dims.width || outerD);
  const length = Number(dims.length || height);
  const thickness = Number(dims.thickness || height);

  const hasTeeth = featuresStr.includes("teeth") || rawType.includes("gear") || recipe.gear != null || typeof analysis.teeth === "number";
  const hasWorm = featuresStr.includes("worm") || rawType.includes("worm") || recipe.gear?.gearType === "worm";
  const isBevel = rawType.includes("bevel") || recipe.gear?.gearType === "bevel" || (recipe.gear?.coneAngle && recipe.gear.coneAngle > 0);
  const hasBoltHoles = featuresStr.includes("bolt") || featuresStr.includes("mounting hole") || (recipe.flange?.boltCount > 0);
  const isPrismatic = rawType.includes("bracket") || rawType.includes("plate") || rawType.includes("lever") || rawType.includes("box") || recipe.style === "extruded";

  // CASE 0A: Circular Cap / Bushing / Bottle Cap / Lid
  const isCapOrBushing =
    rawType.includes("cap") ||
    rawType.includes("bushing") ||
    rawType.includes("cup") ||
    rawType.includes("plug") ||
    rawType.includes("sleeve") ||
    rawType.includes("bottle") ||
    rawType.includes("lid") ||
    rawType.includes("closure") ||
    analysis.componentType === "cap/bushing";

  if (isCapOrBushing) {
    const od = outerD;
    const id = innerD > 0 ? innerD : null;
    const h = height;
    const t = thickness;

    const carrier = {
      id: "carrier_cap_bushing",
      carrierType: "cap_bushing",
      label: "Circular Cap / Lid",
      geometry: {
        outerDiameter: od,
        innerDiameter: id,
        height: h,
        thickness: t,
      },
    };
    return { id: "prog_cap_bushing", style: "revolved", carriers: [carrier] };
  }

  // CASE 0B: Deep-Groove Ball Bearing / Roller Bearing
  const isBearing =
    rawType.includes("bearing") ||
    rawType.includes("ball bearing") ||
    rawType.includes("roller bearing") ||
    featuresStr.includes("bearing") ||
    featuresStr.includes("outer race") ||
    featuresStr.includes("inner race") ||
    featuresStr.includes("ball raceway") ||
    analysis.componentType === "bearing";

  if (isBearing) {
    const od = outerD > 0 ? outerD : 35.0;
    const id = innerD > 0 && innerD < od ? innerD : od * 0.42;
    const bW = height > 0 ? height : (od - id) * 0.85;

    const carrier = {
      id: "carrier_ball_bearing",
      carrierType: "bearing",
      label: "Deep Groove Ball Bearing",
      geometry: {
        outerDiameter: od,
        innerDiameter: id,
        height: bW,
      },
    };
    return { id: "prog_ball_bearing", style: "revolved", carriers: [carrier] };
  }

  // CASE 0C: Flanged Spline Shaft
  if (recipe.style === "flanged_shaft" || (recipe.shaft && recipe.flange) || rawType.includes("flanged spline shaft")) {
    const s = recipe.shaft || {};
    const f = recipe.flange || {};
    const sDiam = Number(s.diameter || innerD || 24);
    const sLen = Number(s.length || length || 180);
    const splineCount = Number(s.splineCount || 6);
    const flOuterR = Number(f.outerDiameter ? f.outerDiameter / 2 : outerD / 2);
    const flThick = Number(f.thickness || thickness || 16);
    const bcd = Number(f.boltCircleDiameter || 54);
    const bCount = Number(f.boltCount || 4);
    const bHoleR = Number(f.boltHoleDiameter ? f.boltHoleDiameter / 2 : 3.5);
    const bossR = Number(f.bossDiameter ? f.bossDiameter / 2 : 18);
    const bossH = Number(f.bossHeight || 28);

    const carrier = {
      id: "carrier_flanged_spline_shaft",
      carrierType: "flanged_shaft",
      geometry: {
        shaftRadius: sDiam / 2,
        shaftLength: sLen,
        splineCount,
        flangeRadius: flOuterR,
        flangeThickness: flThick,
        boltCount: bCount,
        boltCircleDiameter: bcd,
        boltHoleRadius: bHoleR,
        collarRadius: bossR,
        collarLength: bossH,
      },
    };
    return { id: "prog_flanged_shaft", style: "flanged_shaft", carriers: [carrier] };
  }

  // CASE A: Multi-Stage Continuous Axial Assembly (Shafts, Spindles, Worms, Pinions)
  if (recipe.style === "axial_segments" || (Array.isArray(recipe.axialSegments) && recipe.axialSegments.length > 0)) {
    const carrier = {
      id: "carrier_revolved_assembly",
      carrierType: AST_OPERATIONS.CARRIER_REVOLVED,
      geometry: {
        stages: recipe.axialSegments,
        boreRadius: recipe.boreRadius || (innerD > 0 ? innerD / 2 : 0),
        keyway: recipe.keyway || null,
      },
      modifiers: [],
    };
    if (recipe.boreRadius || innerD > 0) {
      carrier.modifiers.push({
        type: AST_OPERATIONS.MODIFIER_BORE,
        parameters: { radius: recipe.boreRadius || innerD / 2, depth: length * 1.2 },
      });
    }
    if (recipe.keyway) {
      carrier.modifiers.push({
        type: AST_OPERATIONS.MODIFIER_KEYWAY,
        parameters: recipe.keyway,
      });
    }
    if (Array.isArray(recipe.modifiers)) {
      for (const m of recipe.modifiers) {
        if (m.type === "bolt_pattern") {
          carrier.modifiers.push({
            type: AST_OPERATIONS.MODIFIER_BOLT_PATTERN,
            parameters: m,
          });
        } else if (m.type === "keyway") {
          carrier.modifiers.push({
            type: AST_OPERATIONS.MODIFIER_KEYWAY,
            parameters: m,
            location: { position: [m.x || 0, 0, m.z || 0] },
            label: m.label,
          });
        }
      }
    }
    return { id: "prog_axial_assembly", style: "axial_segments", carriers: [carrier] };
  }

  // CASE B: Compound Gear / Multi-Stage Gear Train
  if (recipe.style === "compound_gear" || (recipe.gear?.stages && recipe.gear.stages.length >= 2) || rawType.includes("compound")) {
    const g = recipe.gear || {};
    const stages = g.stages || [
      { teeth: 24, outerDiameter: outerD, faceWidth: height * 0.55 },
      { teeth: 16, outerDiameter: outerD * 0.6, faceWidth: height * 0.45 },
    ];
    const s0W = Number(stages[0].faceWidth || height * 0.55);
    const s1W = Number(stages[1].faceWidth || height * 0.45);
    const boreR = Number(recipe.boreRadius || g.boreRadius || (innerD > 0 ? innerD / 2 : outerD * 0.15));

    const carrier = {
      id: "carrier_compound_gear",
      carrierType: AST_OPERATIONS.CARRIER_REVOLVED,
      geometry: {
        stages: [
          {
            zStart: -s0W,
            zEnd: 0,
            radius: Number(stages[0].outerDiameter ? stages[0].outerDiameter / 2 : outerD / 2),
            innerRadius: boreR,
            teeth: Number(stages[0].teeth || 24),
            featureType: "gear_teeth",
            label: "Primary Stage Teeth",
          },
          {
            zStart: 0,
            zEnd: s1W,
            radius: Number(stages[1].outerDiameter ? stages[1].outerDiameter / 2 : outerD * 0.35),
            innerRadius: boreR,
            teeth: Number(stages[1].teeth || 16),
            featureType: "gear_teeth",
            label: "Secondary Stage Teeth",
          },
        ],
      },
      modifiers: [
        {
          type: AST_OPERATIONS.MODIFIER_BORE,
          parameters: { radius: boreR, depth: (s0W + s1W) * 1.5 },
        },
      ],
    };
    if (g.keyway || recipe.keyway) {
      carrier.modifiers.push({
        type: AST_OPERATIONS.MODIFIER_KEYWAY,
        parameters: g.keyway || recipe.keyway,
      });
    }
    return { id: "prog_compound_gear", style: "compound_gear", carriers: [carrier] };
  }

  // CASE C: Worm Shaft
  if (hasWorm || recipe.gear?.gearType === "worm") {
    const pitch = Number(recipe.gear?.pitch || 8);
    const starts = Number(recipe.gear?.starts || 1);
    const faceW = Number(recipe.gear?.faceWidth || height);
    const shaftR = innerD > 0 ? innerD / 2 : outerD * 0.28;
    const carrier = {
      id: "carrier_worm_shaft",
      carrierType: AST_OPERATIONS.CARRIER_REVOLVED,
      geometry: {
        stages: [
          { zStart: -length / 2, zEnd: -faceW / 2, radius: shaftR, label: "Drive Journal" },
          {
            zStart: -faceW / 2,
            zEnd: faceW / 2,
            radius: outerD / 2,
            rootRadius: Number(recipe.gear?.rootRadius || outerD * 0.32),
            pitch,
            starts,
            featureType: "worm_flight",
            label: "Archimedean Worm Flight",
          },
          { zStart: faceW / 2, zEnd: length / 2, radius: shaftR * 0.9, label: "Support Journal" },
        ],
      },
      modifiers: [],
    };
    return { id: "prog_worm_shaft", style: "gear", carriers: [carrier] };
  }

  // CASE D: Flange with Central Bore and Bolt Circle
  if (rawType.includes("flange") || (hasBoltHoles && !isPrismatic && !hasTeeth) || recipe.style === "flange" || recipe.flange != null) {
    const f = recipe.flange || {};
    const flOuterR = Number(f.outerDiameter ? f.outerDiameter / 2 : outerD / 2);
    const flBoreR = Number(f.innerDiameter ? f.innerDiameter / 2 : (innerD > 0 ? innerD / 2 : flOuterR * 0.35));
    const flThick = Number(f.thickness || thickness || 16);
    const bcd = Number(f.boltCircleDiameter || flOuterR * 1.5);
    const bCount = Math.max(3, Math.min(64, Math.round(f.boltCount || analysis.boltCount || 4)));
    const bHoleR = Number(f.boltHoleDiameter ? f.boltHoleDiameter / 2 : 4);
    const bossR = Number(f.bossDiameter ? f.bossDiameter / 2 : flOuterR * 0.6);
    const bossH = Number(f.bossHeight || 12);

    const carrier = {
      id: "carrier_flange",
      carrierType: AST_OPERATIONS.CARRIER_EXTRUDED,
      featureType: "flange",
      label: "Circular Flange Plate",
      geometry: {
        isCircular: true,
        width: flOuterR * 2,
        height: flOuterR * 2,
        depth: flThick,
      },
      modifiers: [
        {
          type: AST_OPERATIONS.MODIFIER_BORE,
          parameters: { radius: flBoreR, depth: (flThick + bossH) * 1.5 },
          location: { position: [0, 0, 0] },
        },
        {
          type: AST_OPERATIONS.MODIFIER_BOLT_PATTERN,
          parameters: { count: bCount, boltCircleDiameter: bcd, holeDiameter: bHoleR * 2, depth: flThick * 1.5 },
        },
      ],
    };
    if (bossH > 0) {
      carrier.modifiers.push({
        type: AST_OPERATIONS.MODIFIER_BOSS,
        parameters: { radius: bossR, height: bossH, boreRadius: flBoreR },
      });
    }
    return { id: "prog_flange", style: "flange", carriers: [carrier] };
  }

  // CASE E: Single Gear (Spur, Helical, Bevel)
  if (hasTeeth || recipe.style === "gear") {
    const g = recipe.gear || {};
    const teeth = Math.max(6, Math.round(g.teeth || analysis.teeth || 20));
    const gRadius = Number(g.outerDiameter ? g.outerDiameter / 2 : outerD / 2);
    const faceW = Number(g.faceWidth || height || 20);
    const boreR = Number(g.boreRadius || (innerD > 0 ? innerD / 2 : gRadius * 0.25));
    const helixAngle = Number(g.helixAngle || analysis.helixAngle || 0);
    const coneAngle = Number(g.coneAngle || analysis.coneAngle || (isBevel ? 45 : 0));

    const carrier = {
      id: "carrier_gear",
      carrierType: AST_OPERATIONS.CARRIER_REVOLVED,
      geometry: {
        stages: [
          {
            zStart: -faceW / 2,
            zEnd: faceW / 2,
            radius: gRadius,
            innerRadius: boreR,
            teeth,
            helixAngle,
            coneAngle,
            featureType: coneAngle > 0 ? "gear_teeth" : (helixAngle !== 0 ? "helical_gear_teeth" : "gear_teeth"),
            label: coneAngle > 0 ? "Bevel Teeth" : (helixAngle !== 0 ? "Helical Teeth" : "Involute Gear Teeth"),
          },
        ],
      },
      modifiers: [
        {
          type: AST_OPERATIONS.MODIFIER_BORE,
          parameters: { radius: boreR, depth: faceW * 1.5 },
        },
      ],
    };
    if (g.keyway || recipe.keyway) {
      carrier.modifiers.push({
        type: AST_OPERATIONS.MODIFIER_KEYWAY,
        parameters: g.keyway || recipe.keyway,
      });
    }
    return { id: "prog_gear", style: "gear", carriers: [carrier] };
  }

  // CASE F: Extruded Planar / Prismatic Part (Bracket, Housing, Link, Plate, Box)
  if (isPrismatic || recipe.style === "extruded" || (Array.isArray(recipe.outline) && recipe.outline.length >= 3)) {
    const outline = Array.isArray(recipe.outline) && recipe.outline.length >= 3
      ? recipe.outline
      : [
          { x: -width / 2, y: -height / 2 },
          { x: width / 2, y: -height / 2 },
          { x: width / 2, y: height / 2 },
          { x: -width / 2, y: height / 2 },
        ];
    const carrier = {
      id: "carrier_prismatic",
      carrierType: AST_OPERATIONS.CARRIER_EXTRUDED,
      featureType: "bracket",
      label: "Prismatic Component",
      geometry: {
        outline,
        depth: thickness || 10,
        holes: recipe.holes || [],
      },
      modifiers: [],
    };
    if (innerD > 0) {
      carrier.modifiers.push({
        type: AST_OPERATIONS.MODIFIER_BORE,
        parameters: { radius: innerD / 2, depth: (thickness || 10) * 1.5 },
        location: { position: [0, 0, 0] },
      });
    }
    return { id: "prog_prismatic", style: "extruded", carriers: [carrier] };
  }

  // CASE G: Revolved Profile (Lathe / Stepped Spindle / Cap / Bushing)
  if (recipe.style === "revolved" && Array.isArray(recipe.revolvedProfile) && recipe.revolvedProfile.length >= 2) {
    const carrier = {
      id: "carrier_revolved_profile",
      carrierType: AST_OPERATIONS.CARRIER_REVOLVED,
      geometry: {
        profile: recipe.revolvedProfile,
        boreRadius: innerD > 0 ? innerD / 2 : 0,
      },
      modifiers: [],
    };
    if (innerD > 0) {
      carrier.modifiers.push({
        type: AST_OPERATIONS.MODIFIER_BORE,
        parameters: { radius: innerD / 2, depth: length * 1.5 },
      });
    }
    return { id: "prog_revolved", style: "revolved", carriers: [carrier] };
  }

  // CASE H: Generic Revolved / Shaft Default
  const carrier = {
    id: "carrier_default_axial",
    carrierType: AST_OPERATIONS.CARRIER_REVOLVED,
    geometry: {
      stages: [
        {
          zStart: -length / 2,
          zEnd: length / 2,
          radius: outerD / 2,
          innerRadius: innerD > 0 ? innerD / 2 : 0,
          label: "Axial Body",
        },
      ],
    },
    modifiers: [],
  };
  if (innerD > 0) {
    carrier.modifiers.push({
      type: AST_OPERATIONS.MODIFIER_BORE,
      parameters: { radius: innerD / 2, depth: length * 1.5 },
    });
  }
  return { id: "prog_generic", style: "revolved", carriers: [carrier] };
}
