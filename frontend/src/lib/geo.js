import * as THREE from "three";

export const matBody = new THREE.MeshStandardMaterial({ color: "#3d332c", metalness: 0.75, roughness: 0.45 });
export const matAccent = new THREE.MeshStandardMaterial({ color: "#b76308", metalness: 0.6, roughness: 0.5 });
export const matRim = new THREE.MeshStandardMaterial({ color: "#de822b", metalness: 0.8, roughness: 0.35 });
export const matDark = new THREE.MeshStandardMaterial({ color: "#271e18", metalness: 0.5, roughness: 0.6 });
export const matHighlight = new THREE.MeshStandardMaterial({
  color: "#c9f88d",
  emissive: "#c9f88d",
  emissiveIntensity: 0.8,
  transparent: true,
  opacity: 0.6,
  roughness: 0.2,
  metalness: 0.1,
  depthWrite: false,
});

export const matLathe = new THREE.MeshStandardMaterial({
  color: "#3d332c",
  metalness: 0.75,
  roughness: 0.45,
  side: THREE.DoubleSide,
});

/**
 * Revolves a meridian profile around the Y axis and closes it so the result is a
 * solid of revolution instead of an open shell. A profile whose ends share a
 * non-zero radius is treated as a closed annular loop (tube / cone shell); any
 * other profile is capped to the axis at both ends.
 */
export function cappedLatheGeometry(profile, segments = 64) {
  const points = [];
  for (const pt of Array.isArray(profile) ? profile : []) {
    const z = typeof pt?.z === "number" && isFinite(pt.z) ? pt.z : null;
    const radius = typeof pt?.radius === "number" && isFinite(pt.radius) ? Math.max(0, pt.radius) : null;
    if (z == null || radius == null) continue;
    const prev = points[points.length - 1];
    if (prev && Math.abs(prev.z - z) < 1e-9 && Math.abs(prev.radius - radius) < 1e-9) continue;
    points.push({ z, radius });
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a.z - b.z);

  const first = points[0];
  const last = points[points.length - 1];
  const annular =
    first.radius > 1e-6 &&
    last.radius > 1e-6 &&
    Math.abs(first.radius - last.radius) <= Math.max(1e-6, 0.02 * Math.max(first.radius, last.radius));

  const loop = points.slice();
  if (annular) {
    loop.push({ z: first.z, radius: first.radius });
  } else {
    if (first.radius > 1e-6) loop.unshift({ z: first.z, radius: 0 });
    if (last.radius > 1e-6) loop.push({ z: last.z, radius: 0 });
  }

  try {
    const vectors = loop.map((pt) => new THREE.Vector2(pt.radius, pt.z));
    return new THREE.LatheGeometry(vectors, Math.max(12, Math.min(128, Math.round(segments))));
  } catch {
    return null;
  }
}

/**
 * Bounding box of the visible solids only. Highlight helper meshes are hidden
 * and must not drive framing or normalisation.
 */
export function visibleBounds(root) {
  const box = new THREE.Box3();
  if (!root) return box;
  const temp = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!node.isMesh || node.visible === false || node.userData?.isHighlightOnly || !node.geometry) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    if (!node.geometry.boundingBox) return;
    temp.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
    box.union(temp);
  });
  return box;
}

export function extrude(shape, depth, bevel = true) {
  // Clamp bevel size so it never explodes thin features, teeth, or holes
  const maxBevel = Math.min(0.35, depth * 0.02);
  const useBevel = Boolean(bevel && depth > 2 && maxBevel >= 0.1);
  return new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: useBevel,
    bevelThickness: useBevel ? maxBevel : 0,
    bevelSize: useBevel ? maxBevel : 0,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 36,
  });
}

function borePath(boreR, keyway) {
  const hole = new THREE.Path();
  const kwWidth = Number(keyway?.width || keyway?.w || 0);
  const kwHeight = Number(keyway?.height || keyway?.depth || keyway?.h || 0);
  if (kwWidth > 0 && kwHeight > 0) {
    const halfW = Math.min(kwWidth / 2, boreR * 0.65);
    const notchTop = boreR + kwHeight;
    const yInter = Math.sqrt(Math.max(0, boreR * boreR - halfW * halfW));
    const startAngle = Math.atan2(yInter, halfW);
    const endAngle = Math.atan2(yInter, -halfW);

    hole.absarc(0, 0, boreR, endAngle, startAngle, false);
    hole.lineTo(halfW, notchTop);
    hole.lineTo(-halfW, notchTop);
    hole.lineTo(-halfW, yInter);
  } else {
    hole.absarc(0, 0, boreR, 0, Math.PI * 2, true);
  }
  return hole;
}

export function ringShape(outerR, innerR, boltHoles = [], keyway = null) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
  if (innerR > 0) {
    shape.holes.push(borePath(innerR, keyway));
  }
  for (const hole of boltHoles) {
    shape.holes.push(hole);
  }
  return shape;
}

/**
 * Generates an engineering-accurate 2D involute gear profile shape.
 * Features true involute curve flanks (based on 20 deg pressure angle),
 * tip land, dedendum transition, and optional central bore / lightening holes.
 * Mathematically guaranteed to form a continuous, non-self-intersecting closed polygon.
 */
export function gearShape(teeth, outerR, toothHeight, boreR, lighteningHoles = [], pressureAngleDeg = 20, keyway = null) {
  const shape = new THREE.Shape();
  const z = Math.max(4, Math.round(teeth || 16));
  const alpha = (pressureAngleDeg * Math.PI) / 180;
  const Ra = Math.max(0.1, outerR || 50);
  const m = (2 * Ra) / (z + 2);
  const Rp = (z * m) / 2;
  const Rb = Rp * Math.cos(alpha);
  const th = toothHeight && toothHeight > 0 ? toothHeight : 2.25 * m;
  const Rf = Math.max(Ra * 0.1, Ra - th);

  const invAlpha = Math.tan(alpha) - alpha;
  const halfPitchAngle = Math.PI / (2 * z);
  const flankSamples = 3;
  let first = true;

  for (let i = 0; i < z; i++) {
    const centerA = (i * 2 * Math.PI) / z;

    // Up flank: from root circle Rf up to tip circle Ra
    for (let s = 0; s <= flankSamples; s++) {
      const frac = s / flankSamples;
      const r = Rf + (Ra - Rf) * frac;
      let thetaR;
      if (r <= Rb) {
        thetaR = halfPitchAngle + invAlpha;
      } else {
        const cosA = Math.min(1, Math.max(-1, Rb / r));
        const alphaR = Math.acos(cosA);
        const invA = Math.tan(alphaR) - alphaR;
        thetaR = Math.max(0.005, halfPitchAngle + invAlpha - invA);
      }
      const a = centerA - thetaR;
      const x = r * Math.cos(a);
      const y = r * Math.sin(a);
      if (first) {
        shape.moveTo(x, y);
        first = false;
      } else {
        shape.lineTo(x, y);
      }
    }

    // Down flank: from tip circle Ra down to root circle Rf
    for (let s = flankSamples; s >= 0; s--) {
      const frac = s / flankSamples;
      const r = Rf + (Ra - Rf) * frac;
      let thetaR;
      if (r <= Rb) {
        thetaR = halfPitchAngle + invAlpha;
      } else {
        const cosA = Math.min(1, Math.max(-1, Rb / r));
        const alphaR = Math.acos(cosA);
        const invA = Math.tan(alphaR) - alphaR;
        thetaR = Math.max(0.005, halfPitchAngle + invAlpha - invA);
      }
      const a = centerA + thetaR;
      shape.lineTo(r * Math.cos(a), r * Math.sin(a));
    }
  }
  shape.closePath();

  if (boreR && boreR > 0 && boreR < Ra) {
    const hole = borePath(boreR, keyway);
    shape.holes.push(hole);
  }

  if (Array.isArray(lighteningHoles)) {
    for (const h of lighteningHoles) {
      if (h instanceof THREE.Path) {
        shape.holes.push(h);
      } else if (h && typeof h.cx === "number" && typeof h.cy === "number" && h.radius > 0) {
        const hole = new THREE.Path();
        hole.absarc(h.cx, h.cy, h.radius, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    }
  }

  return shape;
}

// ============================================================================
// LEGACY COMPONENT-SPECIFIC BUILDERS (PRESERVED FOR RECOVERY SAFETY ONLY)
// Note: Superseded by runtime-geometry-engine.js declarative AST execution.
// ============================================================================

/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 * Builds a true 3D conical Bevel Gear with tapered teeth radiating on a pitch cone,
 * rear cylindrical mounting hub collar, and center bore.
 */
export function buildBevelGearGroup({
  teeth = 20,
  outerRadius = 2.8,
  faceWidth = 1.1,
  coneAngleDeg = 45,
  boreRadius = 0.8,
  hubRadius = null,
  hubHeight = null,
}) {
  const group = new THREE.Group();
  const z = Math.max(6, Math.min(120, Math.round(teeth || 20)));
  const Ra = Math.max(0.5, outerRadius || 2.8);
  const gamma = ((coneAngleDeg || 45) * Math.PI) / 180;
  const F = faceWidth && faceWidth > 0 ? faceWidth : Ra * 0.45;
  const boreR = boreRadius && boreRadius > 0 ? Math.min(boreRadius, Ra * 0.9) : 0;

  const Hcone = F * Math.cos(gamma);
  const deltaR = F * Math.sin(gamma);
  const Rfront = Math.max(boreR * 1.12, Ra - deltaR);

  // 1. Conical Gear Body Blank
  // Three.js CylinderGeometry: radiusTop, radiusBottom, height, radialSegments
  // In our local coordinate system, Z axis is gear axis:
  // - Front (small radius Rfront) at +Hcone / 2
  // - Back (large radius Ra) at -Hcone / 2
  const coneProfile = [
    { z: -Hcone / 2, radius: boreR },
    { z: -Hcone / 2, radius: Ra },
    { z: Hcone / 2, radius: Rfront },
    { z: Hcone / 2, radius: boreR },
  ];
  const hollowConeGeo = boreR > 0 ? cappedLatheGeometry(coneProfile, Math.max(32, z * 2)) : null;
  const coneGeo = hollowConeGeo || new THREE.CylinderGeometry(Rfront, Ra, Hcone, Math.max(32, z * 2));
  // LatheGeometry revolves around Y; the gear axis is Z, same as the original cylinder.
  coneGeo.rotateX(Math.PI / 2);
  const coneMesh = new THREE.Mesh(coneGeo, hollowConeGeo ? matLathe : matBody);
  coneMesh.userData = { featureId: "feature-gear-teeth-1", featureType: "gear_teeth" };
  group.add(coneMesh);

  // 2. Conical Tapered Teeth Crown
  // Build 3D tapered teeth mesh covering the cone face
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

    // Back face (z = -Hcone / 2)
    const zB = -Hcone / 2;
    const rB_bot = Ra - hBack * 0.3;
    const rB_top = Ra + hBack * 0.7;

    const b0 = { x: cosA * rB_bot - perpX * wBackHalf, y: sinA * rB_bot - perpY * wBackHalf, z: zB };
    const b1 = { x: cosA * rB_bot + perpX * wBackHalf, y: sinA * rB_bot + perpY * wBackHalf, z: zB };
    const b2 = { x: cosA * rB_top + perpX * (wBackHalf * 0.5), y: sinA * rB_top + perpY * (wBackHalf * 0.5), z: zB };
    const b3 = { x: cosA * rB_top - perpX * (wBackHalf * 0.5), y: sinA * rB_top - perpY * (wBackHalf * 0.5), z: zB };

    // Front face (z = +Hcone / 2)
    const zF = Hcone / 2;
    const rF_bot = Rfront - hFront * 0.3;
    const rF_top = Rfront + hFront * 0.7;

    const f0 = { x: cosA * rF_bot - perpX * wFrontHalf, y: sinA * rF_bot - perpY * wFrontHalf, z: zF };
    const f1 = { x: cosA * rF_bot + perpX * wFrontHalf, y: sinA * rF_bot + perpY * wFrontHalf, z: zF };
    const f2 = { x: cosA * rF_top + perpX * (wFrontHalf * 0.5), y: sinA * rF_top + perpY * (wFrontHalf * 0.5), z: zF };
    const f3 = { x: cosA * rF_top - perpX * (wFrontHalf * 0.5), y: sinA * rF_top - perpY * (wFrontHalf * 0.5), z: zF };

    const toothVerts = [b0, b1, b2, b3, f0, f1, f2, f3];
    for (const v of toothVerts) {
      positions.push(v.x, v.y, v.z);
    }

    const base = vertIdx;
    // Top crest (3, 2, 6, 7)
    indices.push(base + 3, base + 2, base + 6);
    indices.push(base + 3, base + 6, base + 7);
    // Right flank (2, 1, 5, 6)
    indices.push(base + 2, base + 1, base + 5);
    indices.push(base + 2, base + 5, base + 6);
    // Left flank (0, 3, 7, 4)
    indices.push(base + 0, base + 3, base + 7);
    indices.push(base + 0, base + 7, base + 4);
    // Front face (4, 5, 6, 7)
    indices.push(base + 4, base + 5, base + 6);
    indices.push(base + 4, base + 6, base + 7);
    // Back face (0, 1, 2, 3)
    indices.push(base + 0, base + 2, base + 1);
    indices.push(base + 0, base + 3, base + 2);

    vertIdx += 8;
  }

  const teethGeo = new THREE.BufferGeometry();
  teethGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  teethGeo.setIndex(indices);
  teethGeo.computeVertexNormals();

  const teethMesh = new THREE.Mesh(teethGeo, matAccent);
  teethMesh.userData = { featureId: "feature-gear-teeth-1", featureType: "gear_teeth" };
  group.add(teethMesh);

  // 3. Rear Shaft Hub Collar
  const hubR = hubRadius || Ra * 0.60;
  const hubH = hubHeight || Hcone * 0.9;
  const hubRingR = boreR > 0 ? Math.max(hubR, boreR * 1.1) : hubR;
  const hubGeo = boreR > 0
    ? extrude(ringShape(hubRingR, boreR), hubH, false)
    : new THREE.CylinderGeometry(hubRingR, hubRingR, hubH, 32);
  if (boreR > 0) {
    hubGeo.center();
  } else {
    hubGeo.rotateX(Math.PI / 2);
  }
  const hubMesh = new THREE.Mesh(hubGeo, matAccent);
  hubMesh.position.z = -Hcone / 2 - hubH / 2;
  hubMesh.userData = { featureId: "feature-boss-1", featureType: "boss" };
  group.add(hubMesh);

  // 4. Central Bore and Highlight
  if (boreR > 0) {
    const totalLength = Hcone + hubH;
    const boreHighlight = new THREE.Mesh(
      new THREE.CylinderGeometry(boreR * 0.99, boreR * 0.99, totalLength * 1.05, 32),
      matHighlight
    );
    boreHighlight.rotation.x = Math.PI / 2;
    boreHighlight.position.z = -hubH / 2;
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }

  return group;
}

/**
 * Builds an authentic 3D Compound / Cluster Gear with two stacked gear stages,
 * central through-bore with keyway, and face drive pin holes.
 */
/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 */
export function buildCompoundGearGroup({
  stage1Teeth = 24,
  stage1Radius = 2.8,
  stage1FaceWidth = 1.2,
  stage2Teeth = 16,
  stage2Radius = 1.7,
  stage2FaceWidth = 1.0,
  boreRadius = 0.7,
  keywayWidth = 0.28,
  keywayHeight = 0.16,
  pinHoles = false,
} = {}) {
  const group = new THREE.Group();
  const r1 = Math.max(0.5, stage1Radius);
  const t1 = Math.max(0.2, stage1FaceWidth);
  const z1 = Math.max(6, Math.round(stage1Teeth));

  const r2 = Math.max(0.3, stage2Radius);
  const t2 = Math.max(0.2, stage2FaceWidth);
  const z2 = Math.max(6, Math.round(stage2Teeth));

  const bore = Math.max(0.1, boreRadius);
  const totalH = t1 + t2;
  const kw = (keywayWidth > 0 && keywayHeight > 0) ? { width: keywayWidth, height: keywayHeight } : null;

  // 1. Base Stage: Large Gear
  const toothH1 = r1 * 0.08;
  const baseShape = gearShape(z1, r1, toothH1, bore, [], 20, kw);
  const baseGeo = extrude(baseShape, t1);
  baseGeo.center();
  const baseMesh = new THREE.Mesh(baseGeo, matBody);
  baseMesh.position.z = -t2 / 2;
  baseMesh.userData = { featureId: "feature-gear-stage-1", featureType: "gear_teeth" };
  group.add(baseMesh);

  // 2. Secondary Stage: Small Pinion Gear (stacked on top of base gear)
  const toothH2 = r2 * 0.09;
  const pinHolePaths = [];
  
  // Two pin / dowel holes on the front face of the pinion gear
  const pinR = Math.max(0.04, bore * 0.16);
  const pinDist = (bore + r2 * 0.82) / 2;
  for (let p = 0; p < 2; p++) {
    const pa = p * Math.PI + Math.PI / 2;
    const pPath = new THREE.Path();
    pPath.absarc(Math.cos(pa) * pinDist, Math.sin(pa) * pinDist, pinR, 0, Math.PI * 2, true);
    pinHolePaths.push(pPath);
  }

  const topShape = gearShape(z2, r2, toothH2, bore, pinHolePaths, 20, kw);
  const topGeo = extrude(topShape, t2);
  topGeo.center();
  const topMesh = new THREE.Mesh(topGeo, matAccent);
  topMesh.position.z = t1 / 2;
  topMesh.userData = { featureId: "feature-gear-stage-2", featureType: "gear_teeth" };
  group.add(topMesh);

  // 3. Central Bore Highlight Cylinder
  const boreHighlight = new THREE.Mesh(
    new THREE.CylinderGeometry(bore * 0.99, bore * 0.99, totalH * 1.05, 32),
    matHighlight
  );
  boreHighlight.rotation.x = Math.PI / 2;
  boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
  boreHighlight.visible = false;
  group.add(boreHighlight);

  // 4. Keyway Slot Notch Highlight Proxy
  if (keywayWidth > 0 && keywayHeight > 0) {
    const kwGeo = new THREE.BoxGeometry(keywayWidth, keywayHeight, totalH * 1.02);
    const kwMesh = new THREE.Mesh(kwGeo, matDark);
    kwMesh.position.set(0, bore + keywayHeight / 2, 0);
    kwMesh.userData = { featureId: "feature-keyway-1", featureType: "keyway", isHighlightOnly: true };
    kwMesh.visible = false;
    group.add(kwMesh);
  }

  return group;
}

/**
 * Builds an authentic 3D Flanged Shaft / Linear Spline Bushing assembly,
 * comprising a longitudinal spline shaft, circular mounting flange collar,
 * precision counterbored bolt holes, and ground bearing sleeve.
 */
/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 */
export function buildFlangedShaftGroup({
  shaftRadius = 0.8,
  shaftLength = 6.5,
  flangeRadius = 2.4,
  flangeThickness = 0.65,
  collarRadius = 1.4,
  collarLength = 1.6,
  boltCount = 4,
  boltHoleRadius = 0.22,
  splineCount = 6,
} = {}) {
  const group = new THREE.Group();
  const sR = Math.max(0.3, shaftRadius);
  const sL = Math.max(2.0, shaftLength);
  const fR = Math.max(sR * 1.5, flangeRadius);
  const fTh = Math.max(0.2, flangeThickness);
  const cR = Math.max(sR * 1.2, collarRadius);
  const cL = Math.max(0.4, collarLength);
  const bCount = Math.max(3, Math.min(16, boltCount || 4));
  const bHoleR = Math.max(0.08, boltHoleRadius);
  const bcd = (sR * 1.4 + fR) / 2;

  // 1. Central Longitudinal Shaft
  const shaftGeo = new THREE.CylinderGeometry(sR, sR, sL, 32);
  shaftGeo.rotateZ(Math.PI / 2); // Along X axis
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
      gMesh.userData = { featureId: "feature-spline-1", featureType: "spline" };
      group.add(gMesh);
    }
  }

  // 3. Circular Mounting Flange Collar (positioned towards front-third of shaft)
  const flangeX = -sL * 0.15;
  const boltHoles = [];
  for (let i = 0; i < bCount; i++) {
    const a = (i / bCount) * Math.PI * 2;
    const pathHole = new THREE.Path();
    pathHole.absarc(Math.cos(a) * bcd, Math.sin(a) * bcd, bHoleR, 0, Math.PI * 2, true);
    boltHoles.push(pathHole);

    // Bolt hole highlight cylinder
    const holeHighlight = new THREE.Mesh(
      new THREE.CylinderGeometry(bHoleR * 0.98, bHoleR * 0.98, fTh * 1.1, 16),
      matHighlight
    );
    holeHighlight.rotateZ(Math.PI / 2);
    holeHighlight.position.set(flangeX, Math.cos(a) * bcd, Math.sin(a) * bcd);
    holeHighlight.userData = { featureId: "feature-mounting-holes-1", featureType: "mounting_hole", isHighlightOnly: true };
    holeHighlight.visible = false;
    group.add(holeHighlight);
  }

  const flangeShape = ringShape(fR, sR * 1.02, boltHoles);
  const flangeGeo = extrude(flangeShape, fTh);
  flangeGeo.center();
  flangeGeo.rotateY(Math.PI / 2); // Perpendicular to shaft along X
  const flangeMesh = new THREE.Mesh(flangeGeo, matAccent);
  flangeMesh.position.x = flangeX;
  flangeMesh.userData = { featureId: "feature-flange-1", featureType: "flange" };
  group.add(flangeMesh);

  // 4. Bushing / Collar Hub Extension (behind flange)
  const collarGeo = new THREE.CylinderGeometry(cR, cR, cL, 32);
  collarGeo.rotateZ(Math.PI / 2);
  const collarMesh = new THREE.Mesh(collarGeo, matRim);
  collarMesh.position.x = flangeX + fTh / 2 + cL / 2;
  collarMesh.userData = { featureId: "feature-boss-1", featureType: "boss" };
  group.add(collarMesh);

  return group;
}

/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 */
export function buildPinionShaftGroup({
  gearTeeth = 16,
  gearRadius = 2.4,
  gearFaceWidth = 1.8,
  helixAngle = 20,
  shaftRadius = 1.1,
  shaftLength = 7.0,
  driveJournalRadius = 1.0,
  supportJournalRadius = 0.9,
  keywayWidth = 0.35,
  keywayHeight = 0.22,
  splineCount = 0,
} = {}) {
  const group = new THREE.Group();
  const gR = Math.max(0.6, gearRadius);
  const gW = Math.max(0.4, gearFaceWidth);
  const z = Math.max(6, Math.round(gearTeeth));
  const sL = Math.max(gW * 1.5, shaftLength);
  const sR = Math.max(0.3, Math.min(gR * 0.85, shaftRadius));
  const jDriveR = Math.max(0.25, driveJournalRadius || sR * 0.9);
  const jSuppR = Math.max(0.25, supportJournalRadius || sR * 0.8);

  // Position gear along the shaft: standard pinion shaft has gear section slightly offset
  const gearCenterOffset = -sL * 0.12;

  // 1. Helical or Spur Pinion Gear Mesh
  const toothH = gR * 0.11;
  const gearSpurShape = gearShape(z, gR, toothH, 0); // Solid core (no through bore on pinion shaft)
  const gearGeo = extrude(gearSpurShape, gW);
  gearGeo.center();
  gearGeo.rotateY(Math.PI / 2); // Lay horizontally along X axis
  const gearMesh = new THREE.Mesh(gearGeo, matBody);
  gearMesh.position.x = gearCenterOffset;
  gearMesh.userData = { featureId: "feature-gear-teeth-1", featureType: "gear_teeth" };
  group.add(gearMesh);

  // 2. Main Drive Shaft Section (Left extension from gear to drive end)
  const leftLen = Math.max(0.5, sL / 2 + gearCenterOffset - gW / 2);
  const leftCenterX = gearCenterOffset - gW / 2 - leftLen / 2;
  const leftShaftGeo = new THREE.CylinderGeometry(sR, sR, leftLen, 32);
  leftShaftGeo.rotateZ(Math.PI / 2);
  const leftShaftMesh = new THREE.Mesh(leftShaftGeo, matBody);
  leftShaftMesh.position.x = leftCenterX;
  leftShaftMesh.userData = { featureId: "feature-shaft-1", featureType: "shaft" };
  group.add(leftShaftMesh);

  // 3. Precision Ground Bearing Journal on drive side
  const jDriveLen = leftLen * 0.55;
  const jDriveGeo = new THREE.CylinderGeometry(jDriveR, jDriveR, jDriveLen, 32);
  jDriveGeo.rotateZ(Math.PI / 2);
  const jDriveMesh = new THREE.Mesh(jDriveGeo, matAccent);
  jDriveMesh.position.x = leftCenterX - leftLen * 0.18;
  jDriveMesh.userData = { featureId: "feature-bearing-journal-1", featureType: "shaft" };
  group.add(jDriveMesh);

  // 4. Support Shaft Section (Right extension from gear to support end)
  const rightLen = Math.max(0.5, sL / 2 - gearCenterOffset - gW / 2);
  const rightCenterX = gearCenterOffset + gW / 2 + rightLen / 2;
  const rightShaftGeo = new THREE.CylinderGeometry(sR, sR, rightLen, 32);
  rightShaftGeo.rotateZ(Math.PI / 2);
  const rightShaftMesh = new THREE.Mesh(rightShaftGeo, matBody);
  rightShaftMesh.position.x = rightCenterX;
  rightShaftMesh.userData = { featureId: "feature-shaft-2", featureType: "shaft" };
  group.add(rightShaftMesh);

  // 5. Precision Ground Bearing Journal on support side
  const jSuppLen = rightLen * 0.60;
  const jSuppGeo = new THREE.CylinderGeometry(jSuppR, jSuppR, jSuppLen, 32);
  jSuppGeo.rotateZ(Math.PI / 2);
  const jSuppMesh = new THREE.Mesh(jSuppGeo, matAccent);
  jSuppMesh.position.x = rightCenterX + rightLen * 0.15;
  jSuppMesh.userData = { featureId: "feature-bearing-journal-2", featureType: "shaft" };
  group.add(jSuppMesh);

  // 6. Keyway on drive end
  if (keywayWidth > 0) {
    const kwGeo = new THREE.BoxGeometry(leftLen * 0.35, keywayHeight, keywayWidth);
    const kwMesh = new THREE.Mesh(kwGeo, matDark);
    kwMesh.position.set(-sL / 2 + leftLen * 0.25, jDriveR, 0);
    kwMesh.userData = { featureId: "feature-keyway-1", featureType: "keyway" };
    group.add(kwMesh);
  }

  return group;
}

/**
 * Builds an authentic 3D Stepped Shaft with multi-diameter journals,
 * transition shoulders, and optional spline head.
 */
/**
 * Builds an authentic 3D Circular Cap / Bushing / Bottle Cap component with a top disc,
 * cylindrical outer wall (skirt), vertical knurling flutes, and an open hollow cavity.
 */
/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 */
export function buildCapBushingGroup({
  outerDiameter = 30.0,
  innerDiameter = null,
  height = 12.0,
  thickness = null,
}) {
  const group = new THREE.Group();
  const od = typeof outerDiameter === "number" && outerDiameter > 0 ? outerDiameter : 30.0;
  const outerR = od / 2;
  const h = typeof height === "number" && height > 0 ? height : Math.max(8.0, outerR * 0.75);

  const wallThick = typeof thickness === "number" && thickness > 0
    ? thickness
    : (typeof innerDiameter === "number" && innerDiameter > 0 && innerDiameter < od
        ? (od - innerDiameter) / 2
        : Math.max(1.0, Math.min(2.5, outerR * 0.08)));
  const innerR = typeof innerDiameter === "number" && innerDiameter > 0
    ? innerDiameter / 2
    : Math.max(0, outerR - wallThick);

  const topCeilingThick = Math.max(1.2, wallThick * 1.1);
  const hollowDepth = Math.max(1.0, h - topCeilingThick);

  // 1. Solid Top Cap Disc with subtle chamfer
  const topDiscGeo = new THREE.CylinderGeometry(outerR * 0.98, outerR, topCeilingThick, 64);
  const topMesh = new THREE.Mesh(topDiscGeo, matBody);
  topMesh.position.y = (h / 2) - (topCeilingThick / 2);
  topMesh.userData = { featureId: "feature-cap-top-1", featureType: "cap_top" };
  group.add(topMesh);

  // 2. Outer Cylindrical Wall (Skirt / Rim)
  const skirtGeo = extrude(ringShape(outerR, innerR), hollowDepth, false);
  skirtGeo.center();
  const skirtMesh = new THREE.Mesh(skirtGeo, matBody);
  skirtMesh.rotation.x = Math.PI / 2;
  skirtMesh.position.y = - (topCeilingThick / 2);
  skirtMesh.userData = { featureId: "feature-cap-wall-1", featureType: "cap_wall" };
  group.add(skirtMesh);

  // 3. Knurled Flutes (standard plastic bottle cap ribbing)
  const numRibs = 48;
  const fluteGeo = new THREE.BoxGeometry(outerR * 0.035, hollowDepth * 0.95, outerR * 0.04);
  const flutesGroup = new THREE.Group();
  for (let i = 0; i < numRibs; i++) {
    const angle = (i / numRibs) * Math.PI * 2;
    const flute = new THREE.Mesh(fluteGeo, matAccent);
    flute.position.set(Math.cos(angle) * (outerR * 0.995), -(topCeilingThick / 2), Math.sin(angle) * (outerR * 0.995));
    flute.rotation.y = -angle;
    flutesGroup.add(flute);
  }
  flutesGroup.userData = { featureId: "feature-cap-knurl-1", featureType: "knurling" };
  group.add(flutesGroup);

  // 4. Inner Hollow Bore Highlight (for interactive inspection)
  if (innerR > 0) {
    const boreHighlight = new THREE.Mesh(
      new THREE.CylinderGeometry(innerR * 0.99, innerR * 0.99, hollowDepth * 1.05, 32, 1, true),
      matHighlight
    );
    boreHighlight.position.y = - (topCeilingThick / 2);
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }

  return group;
}

/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 */
export function buildSteppedShaftGroup({
  outerRadius = 1.8,
  length = 6.0,
  innerRadius = 0,
  profile = null,
}) {
  const group = new THREE.Group();
  const maxR = outerRadius || 1.8;
  const L = length || maxR * 3.8;
  const innerR = innerRadius || 0;

  // A revolved profile from the recipe is what the image measured; use it
  // instead of the parametric five-journal template whenever it is available.
  const profilePoints = Array.isArray(profile)
    ? profile.filter((pt) => pt && typeof pt.z === "number" && isFinite(pt.z) && typeof pt.radius === "number" && isFinite(pt.radius))
    : [];
  if (profilePoints.length >= 2) {
    const profileGeo = cappedLatheGeometry(profilePoints, 64);
    if (profileGeo) {
      profileGeo.rotateZ(-Math.PI / 2);
      const mesh = new THREE.Mesh(profileGeo, matLathe);
      mesh.userData = { featureId: "feature-shaft-1", featureType: "shaft" };
      group.add(mesh);
      if (innerR > 0) {
        const boreHighlight = new THREE.Mesh(
          new THREE.CylinderGeometry(innerR * 0.99, innerR * 0.99, L * 1.05, 32),
          matHighlight
        );
        boreHighlight.rotateZ(Math.PI / 2);
        boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
        boreHighlight.visible = false;
        group.add(boreHighlight);
      }
      return group;
    }
  }

  // Authentic 5-step industrial transmission drive shaft proportions
  const steps = [
    { name: "spline_journal", len: L * 0.22, r: maxR * 0.65, isSpline: true },
    { name: "bearing_seat_1", len: L * 0.22, r: maxR * 0.82 },
    { name: "center_shoulder", len: L * 0.30, r: maxR * 1.0 },
    { name: "bearing_seat_2", len: L * 0.16, r: maxR * 0.85 },
    { name: "tail_journal", len: L * 0.10, r: maxR * 0.70 },
  ];

  let currentX = -L / 2;
  steps.forEach((step, idx) => {
    const segCenter = currentX + step.len / 2;
    const segGeo = new THREE.CylinderGeometry(step.r, step.r, step.len, 32);
    segGeo.rotateZ(Math.PI / 2); // Lay along X axis
    const segMesh = new THREE.Mesh(segGeo, idx % 2 === 0 ? matBody : matAccent);
    segMesh.position.x = segCenter;
    segMesh.userData = { featureId: `feature-journal-${idx + 1}`, featureType: "shaft" };
    group.add(segMesh);

    // If spline journal, add longitudinal spline teeth ridges
    if (step.isSpline) {
      const splineCount = 12;
      const toothW = ((Math.PI * 2 * step.r) / splineCount) * 0.45;
      const toothH = step.r * 0.14;
      for (let s = 0; s < splineCount; s++) {
        const sa = (s / splineCount) * Math.PI * 2;
        const toothGeo = new THREE.BoxGeometry(step.len * 0.85, toothH, toothW);
        const toothMesh = new THREE.Mesh(toothGeo, matRim);
        toothMesh.position.set(
          segCenter,
          Math.sin(sa) * (step.r + toothH * 0.3),
          Math.cos(sa) * (step.r + toothH * 0.3)
        );
        toothMesh.rotation.x = -sa;
        toothMesh.userData = { featureId: "feature-spline-1", featureType: "spline" };
        group.add(toothMesh);
      }
    }

    // Shoulder transition ring
    if (idx < steps.length - 1) {
      const nextR = steps[idx + 1].r;
      const shoulderR = Math.max(step.r, nextR);
      const ringGeo = new THREE.TorusGeometry(shoulderR * 0.98, Math.abs(nextR - step.r) * 0.18, 12, 32);
      ringGeo.rotateY(Math.PI / 2);
      const ringMesh = new THREE.Mesh(ringGeo, matRim);
      ringMesh.position.x = currentX + step.len;
      ringMesh.userData = { featureId: `feature-shoulder-${idx + 1}`, featureType: "shoulder" };
      group.add(ringMesh);
    }

    currentX += step.len;
  });

  if (innerR > 0) {
    const boreHighlight = new THREE.Mesh(
      new THREE.CylinderGeometry(innerR * 0.99, innerR * 0.99, L * 1.05, 32),
      matHighlight
    );
    boreHighlight.rotateZ(Math.PI / 2);
    boreHighlight.userData = { featureId: "feature-bore-1", featureType: "bore", isHighlightOnly: true };
    boreHighlight.visible = false;
    group.add(boreHighlight);
  }

  return group;
}

/**
 * Generates an authentic 3D continuous helical worm screw flight geometry.
 * Discretises the Archimedean / Involute screw flight along a continuous 3D helix:
 *   theta(z) = (2 * PI * z) / lead
 * Creates a fully watertight, non-manifold quad-strip surface with smooth feather-edge runouts.
 */
/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 */
export function buildWormFlightGeometry({
  length = 60,
  pitch = 8,
  starts = 1,
  tipRadius = 30,
  rootRadius = 21,
  pressureAngleDeg = 20,
  hand = "right",
} = {}) {
  const lead = Math.max(0.1, starts * pitch);
  const numZ = Math.max(80, Math.ceil(length * 3));
  const numTheta = 72;
  const vertices = [];
  const indices = [];

  const halfTooth = (pitch * 0.35) / 2;
  const halfSpace = (pitch * 0.85) / 2;
  const runoutLen = pitch * 0.75;

  for (let iz = 0; iz <= numZ; iz++) {
    const tz = iz / numZ;
    const z = -length / 2 + tz * length;

    // Runout tapering at ends
    let endFade = 1.0;
    const distFromStart = z - (-length / 2);
    const distFromEnd = length / 2 - z;
    if (distFromStart < runoutLen) endFade = Math.min(endFade, Math.max(0, distFromStart / runoutLen));
    if (distFromEnd < runoutLen) endFade = Math.min(endFade, Math.max(0, distFromEnd / runoutLen));

    for (let it = 0; it < numTheta; it++) {
      const theta = (it / numTheta) * Math.PI * 2;
      const sign = hand === "left" ? -1 : 1;
      const threadZ = (sign * theta * lead) / (Math.PI * 2);

      let maxElevation = 0;
      for (let s = 0; s < starts; s++) {
        const startOffset = (s / starts) * lead;
        const delta = Math.abs((((z - threadZ - startOffset) % pitch) + 1.5 * pitch) % pitch - 0.5 * pitch);
        let elev = 0;
        if (delta <= halfTooth) {
          elev = 1.0;
        } else if (delta < halfSpace) {
          elev = (halfSpace - delta) / (halfSpace - halfTooth);
        }
        if (elev > maxElevation) maxElevation = elev;
      }

      const r = rootRadius + (tipRadius - rootRadius) * maxElevation * endFade;
      vertices.push(Math.cos(theta) * r, Math.sin(theta) * r, z);
    }
  }

  // Indices (quad strips)
  for (let iz = 0; iz < numZ; iz++) {
    for (let it = 0; it < numTheta; it++) {
      const nextT = (it + 1) % numTheta;
      const row1 = iz * numTheta;
      const row2 = (iz + 1) * numTheta;

      const a = row1 + it;
      const b = row1 + nextT;
      const c = row2 + it;
      const d = row2 + nextT;

      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  // Endcaps at -length/2 and +length/2
  const firstRingStart = 0;
  const lastRingStart = numZ * numTheta;
  const centerBottomIdx = vertices.length / 3;
  vertices.push(0, 0, -length / 2);
  for (let it = 0; it < numTheta; it++) {
    const nextT = (it + 1) % numTheta;
    indices.push(centerBottomIdx, firstRingStart + nextT, firstRingStart + it);
  }

  const centerTopIdx = vertices.length / 3;
  vertices.push(0, 0, length / 2);
  for (let it = 0; it < numTheta; it++) {
    const nextT = (it + 1) % numTheta;
    indices.push(centerTopIdx, lastRingStart + it, lastRingStart + nextT);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * OPERATOR A: Generalised Axial Segment Assembly Builder
 *
 * Universal continuous geometry builder for rotational mechanical components.
 * Constructs an authentic 3D assembly from an ordered sequence of K continuous axial segments.
 * Unifies single gears, compound gears, multi-stage gear clusters, stepped shafts,
 * pinion shafts, splined spindles, hollow shafts, and hybrid machinery into one parametric continuous operator.
 *
 * @param {Object} options
 * @param {Array<Object>} options.segments - Array of axial segments:
 *   [{ zStart, zEnd, radius, innerRadius, teeth, module, pressureAngle, helixAngle, splineCount, label }, ...]
 * @param {number} [options.boreRadius=0] - Central through-bore radius
 * @param {Object} [options.keyway=null] - Keyway { width, height, length, angle }
 * @param {Array<Object>} [options.booleans=[]] - Boolean features (cross holes, slots, grooves)
 * @param {Array<Object>} [options.modifiers=[]] - Multi-station modifications (keyways, grooves, threads)
 * @returns {THREE.Group} Cohesive solid 3D assembly group with inspection metadata
 */
/**
 * @deprecated Superseded by runtime-geometry-engine.js. Preserved for recovery safety.
 */
export function buildAxialSegmentAssembly({
  segments = [],
  boreRadius = 0,
  keyway = null,
  booleans = [],
  modifiers = [],
} = {}) {
  const group = new THREE.Group();
  if (!Array.isArray(segments) || segments.length === 0) {
    return group;
  }

  // Sort segments by zStart ascending
  const sorted = [...segments].sort(
    (a, b) => (a.zStart ?? a.z_start ?? 0) - (b.zStart ?? b.z_start ?? 0)
  );
  const bore = Math.max(0, typeof boreRadius === "number" && isFinite(boreRadius) ? boreRadius : 0);

  const zMin = sorted[0].zStart ?? sorted[0].z_start ?? 0;
  const zMax = sorted[sorted.length - 1].zEnd ?? sorted[sorted.length - 1].z_end ?? 0;
  const totalLength = Math.max(0.1, zMax - zMin);
  const maxRadius = Math.max(...sorted.map((s) => Math.max(0.1, s.radius ?? s.outer_radius ?? s.outerRadius ?? 10)));
  const isElongatedShaft = totalLength > maxRadius * 2.2 && sorted.some((s) => !((s.teeth ?? 0) >= 3));

  sorted.forEach((seg, idx) => {
    const zStart = seg.zStart ?? seg.z_start ?? 0;
    const zEnd = seg.zEnd ?? seg.z_end ?? (zStart + 10);
    const segLen = Math.max(0.1, zEnd - zStart);
    const segPos = (zStart + zEnd) / 2;
    const rOuter = Math.max(0.1, seg.radius ?? seg.outer_radius ?? seg.outerRadius ?? 10);
    const segBore = Math.max(bore, seg.innerRadius ?? seg.inner_radius ?? seg.boreRadius ?? 0);
    const teeth = Math.round(seg.teeth ?? 0);
    const helix = seg.helixAngle ?? seg.helix_angle ?? 0;
    const splines = Math.round(seg.splineCount ?? seg.spline_count ?? 0);

    let segMesh;

    if (seg.featureType === "worm_thread" || (seg.pitch && seg.pitch > 0)) {
      // Continuous 3D helical worm screw thread flight
      const p = seg.pitch || 8.0;
      const starts = seg.starts || 1;
      const rTip = rOuter;
      const rRoot = seg.rootRadius || rOuter * 0.7;
      const geo = buildWormFlightGeometry({
        length: segLen,
        pitch: p,
        starts,
        tipRadius: rTip,
        rootRadius: rRoot,
        pressureAngleDeg: seg.pressureAngle || 20,
        hand: seg.hand || "right",
      });
      if (isElongatedShaft) {
        geo.rotateY(Math.PI / 2);
        segMesh = new THREE.Mesh(geo, matAccent);
        segMesh.position.x = segPos;
      } else {
        segMesh = new THREE.Mesh(geo, matAccent);
        segMesh.position.z = segPos;
      }
      segMesh.userData = {
        featureId: `feature-worm-thread-${idx + 1}`,
        featureType: "worm_thread",
        pitch: p,
        starts,
        length: segLen,
        radius: rOuter,
        rootRadius: rRoot,
      };
    } else if (seg.featureType === "threaded_stud" || seg.thread) {
      // Threaded fastener stud on shaft end
      const geo = new THREE.CylinderGeometry(rOuter * 0.95, rOuter, segLen, 36);
      if (isElongatedShaft) {
        geo.rotateZ(Math.PI / 2);
      } else {
        geo.rotateX(Math.PI / 2);
      }
      segMesh = new THREE.Mesh(geo, matDark);
      if (isElongatedShaft) {
        segMesh.position.x = segPos;
      } else {
        segMesh.position.z = segPos;
      }
      segMesh.userData = {
        featureId: `feature-threaded-stud-${idx + 1}`,
        featureType: "threaded_stud",
        thread: seg.thread || "M16x1.5",
        length: segLen,
        radius: rOuter,
      };
    } else if (teeth >= 3) {
      // Involute gear section
      const m = seg.module ?? ((rOuter * 2) / (teeth + 2));
      const toothH = Math.min(rOuter * 0.25, 2.25 * m);
      const shape = gearShape(teeth, rOuter, toothH, segBore, [], 20, keyway);
      const geo = extrude(shape, segLen);
      geo.center();
      if (isElongatedShaft) {
        geo.rotateY(Math.PI / 2);
        segMesh = new THREE.Mesh(geo, idx % 2 === 0 ? matBody : matAccent);
        segMesh.position.x = segPos;
      } else {
        segMesh = new THREE.Mesh(geo, idx % 2 === 0 ? matBody : matAccent);
        segMesh.position.z = segPos;
      }
      segMesh.userData = {
        featureId: `feature-gear-segment-${idx + 1}`,
        featureType: "gear_teeth",
        teeth,
        module: m,
        faceWidth: segLen,
        radius: rOuter,
        helixAngle: helix,
      };
    } else if (splines >= 2) {
      // Spline drive shaft section
      const splineDepth = seg.splineDepth ?? seg.spline_depth ?? (rOuter * 0.16);
      const shape = new THREE.Shape();
      const numPts = 72;
      for (let p = 0; p < numPts; p++) {
        const theta = (p / numPts) * Math.PI * 2;
        const phase = (((theta * splines) / (Math.PI * 2)) % 1 + 1) % 1;
        let r = rOuter;
        if (phase < 0.25 || phase > 0.75) {
          r = Math.max(0.1, rOuter - splineDepth);
        }
        const px = Math.cos(theta) * r;
        const py = Math.sin(theta) * r;
        if (p === 0) shape.moveTo(px, py);
        else shape.lineTo(px, py);
      }
      shape.closePath();
      if (segBore > 0) {
        const holePath = new THREE.Path();
        const kwWidth = Number(keyway?.width || keyway?.w || 0);
        const kwHeight = Number(keyway?.height || keyway?.depth || keyway?.h || 0);
        if (kwWidth > 0 && kwHeight > 0) {
          const halfW = Math.min(kwWidth / 2, segBore * 0.65);
          const notchTop = segBore + kwHeight;
          const yInter = Math.sqrt(Math.max(0, segBore * segBore - halfW * halfW));
          const startAngle = Math.atan2(yInter, halfW);
          const endAngle = Math.atan2(yInter, -halfW);
          holePath.absarc(0, 0, segBore, endAngle, startAngle, false);
          holePath.lineTo(halfW, notchTop);
          holePath.lineTo(-halfW, notchTop);
          holePath.lineTo(-halfW, yInter);
        } else {
          holePath.absarc(0, 0, segBore, 0, Math.PI * 2, true);
        }
        shape.holes.push(holePath);
      }
      const geo = extrude(shape, segLen);
      geo.center();
      if (isElongatedShaft) {
        geo.rotateY(Math.PI / 2);
        segMesh = new THREE.Mesh(geo, matBody);
        segMesh.position.x = segPos;
      } else {
        segMesh = new THREE.Mesh(geo, matBody);
        segMesh.position.z = segPos;
      }
      segMesh.userData = {
        featureId: `feature-spline-segment-${idx + 1}`,
        featureType: "spline",
        splineCount: splines,
        radius: rOuter,
        length: segLen,
      };
    } else {
      // Cylindrical journal / collar / bearing seat / hollow sleeve
      let geo;
      if (segBore > 0) {
        const shape = ringShape(rOuter, segBore);
        geo = extrude(shape, segLen);
        geo.center();
        if (isElongatedShaft) {
          geo.rotateY(Math.PI / 2);
        }
      } else {
        geo = new THREE.CylinderGeometry(rOuter, rOuter, segLen, 36);
        if (isElongatedShaft) {
          geo.rotateZ(Math.PI / 2);
        } else {
          geo.rotateX(Math.PI / 2);
        }
      }
      segMesh = new THREE.Mesh(geo, idx % 2 === 0 ? matBody : matAccent);
      if (isElongatedShaft) {
        segMesh.position.x = segPos;
      } else {
        segMesh.position.z = segPos;
      }
      segMesh.userData = {
        featureId: `feature-axial-segment-${idx + 1}`,
        featureType: rOuter > 25 ? "flange" : "shaft",
        label: seg.label || `Segment ${idx + 1}`,
        radius: rOuter,
        length: segLen,
      };
    }

    group.add(segMesh);

    // Shoulder transition ring if stepping between smooth shaft journals
    // NEVER add over gear teeth or splines
    if (idx < sorted.length - 1) {
      const nextSeg = sorted[idx + 1];
      const nextTeeth = Math.round(nextSeg.teeth ?? 0);
      const nextSplines = Math.round(nextSeg.splineCount ?? nextSeg.spline_count ?? 0);
      const nextR = Math.max(0.1, nextSeg.radius ?? nextSeg.outer_radius ?? 10);
      const deltaR = Math.abs(nextR - rOuter);
      if (deltaR > 0.5 && !teeth && !nextTeeth && !splines && !nextSplines && isElongatedShaft) {
        const shoulderR = Math.max(rOuter, nextR);
        const ringGeo = new THREE.TorusGeometry(shoulderR * 0.98, Math.min(deltaR * 0.25, 2.0), 12, 32);
        ringGeo.rotateY(Math.PI / 2);
        const ringMesh = new THREE.Mesh(ringGeo, matRim);
        ringMesh.position.x = zEnd;
        ringMesh.userData = { featureId: `feature-shoulder-${idx + 1}`, featureType: "shoulder" };
        group.add(ringMesh);
      }
    }
  });

  // Central bore inspection proxy
  if (bore > 0) {
    const boreGeo = new THREE.CylinderGeometry(bore * 0.99, bore * 0.99, totalLength * 1.02, 32);
    if (isElongatedShaft) {
      boreGeo.rotateZ(Math.PI / 2);
    } else {
      boreGeo.rotateX(Math.PI / 2);
    }
    const boreMesh = new THREE.Mesh(boreGeo, matHighlight);
    if (isElongatedShaft) {
      boreMesh.position.x = (zMin + zMax) / 2;
    } else {
      boreMesh.position.z = (zMin + zMax) / 2;
    }
    boreMesh.userData = { featureId: "feature-central-bore", featureType: "bore", isHighlightOnly: true };
    boreMesh.visible = false;
    group.add(boreMesh);
  }

  // Keyway slot inspection proxy
  if (keyway && (keyway.width || keyway.height)) {
    const kw = keyway.width || Math.max(2, bore * 0.4);
    const kh = keyway.height || Math.max(1.5, bore * 0.22);
    const kl = keyway.length || totalLength * 0.7;
    let kwMesh;
    if (isElongatedShaft) {
      kwMesh = new THREE.Mesh(new THREE.BoxGeometry(kl, kh, kw), matHighlight);
      kwMesh.position.set((zMin + zMax) / 2, bore + kh / 2, 0);
    } else {
      kwMesh = new THREE.Mesh(new THREE.BoxGeometry(kw, kh, kl), matHighlight);
      kwMesh.position.set(0, bore + kh / 2, (zMin + zMax) / 2);
    }
    kwMesh.userData = { featureId: "feature-keyway-slot", featureType: "keyway", isHighlightOnly: true };
    kwMesh.visible = false;
    group.add(kwMesh);
  }

  // Boolean features & multi-station modifiers (Operator D)
  const allModifiers = Array.from(new Set([...(Array.isArray(modifiers) ? modifiers : []), ...(Array.isArray(booleans) ? booleans : [])]));
  allModifiers.forEach((feat, bIdx) => {
    if (!feat) return;
    const fType = feat.type || "other";
    if (fType === "keyway") {
      const kwWidth = feat.width || 6;
      const kwHeight = feat.depth || feat.height || 3.5;
      const kwLen = feat.length || 20;
      const kwX = feat.x ?? feat.z ?? 0;
      const kwGeo = new THREE.BoxGeometry(
        isElongatedShaft ? kwLen : kwWidth,
        kwHeight,
        isElongatedShaft ? kwWidth : kwLen
      );
      const kwMesh = new THREE.Mesh(kwGeo, matDark);
      if (isElongatedShaft) {
        kwMesh.position.set(kwX, (feat.radius || maxRadius * 0.5) - kwHeight * 0.1, 0);
      } else {
        kwMesh.position.set(0, (feat.radius || maxRadius * 0.5) - kwHeight * 0.1, kwX);
      }
      kwMesh.userData = {
        featureId: feat.id || `feature-keyway-${bIdx + 1}`,
        featureType: "keyway",
        label: feat.label || `Keyway Slot ${kwWidth}x${kwHeight}mm`,
      };
      group.add(kwMesh);
    } else if (fType === "mounting_hole" || fType === "radial_hole" || fType === "through_hole") {
      const rad = Number(feat.radius) || 3.5;
      const dep = Number(feat.depth) || 20;
      const hMesh = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, dep, 16), matHighlight);
      hMesh.position.set(feat.cx || 0, feat.cy || 0, feat.cz || 0);
      hMesh.userData = {
        featureId: feat.id || `feature-bool-${bIdx + 1}`,
        featureType: fType,
        isHighlightOnly: true,
      };
      hMesh.visible = false;
      group.add(hMesh);
    }
  });

  return group;
}

