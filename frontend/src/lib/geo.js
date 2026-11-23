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
  return new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel,
    bevelThickness: bevel ? depth * 0.08 : 0,
    bevelSize: bevel ? depth * 0.06 : 0,
    bevelSegments: 4,
    steps: 2,
    curveSegments: 48,
  });
}

export function ringShape(outerR, innerR, boltHoles = []) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
  if (innerR > 0) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
    shape.holes.push(hole);
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
 */
export function gearShape(teeth, outerR, toothHeight, boreR, lighteningHoles = [], pressureAngleDeg = 20) {
  const shape = new THREE.Shape();
  const z = Math.max(4, Math.round(teeth || 16));
  const alpha = (pressureAngleDeg * Math.PI) / 180;
  const Ra = Math.max(0.1, outerR || 50);
  const m = (2 * Ra) / (z + 2);
  const Rp = (z * m) / 2;
  const Rb = Rp * Math.cos(alpha);
  const th = toothHeight && toothHeight > 0 ? toothHeight : 2.25 * m;
  const Rf = Math.max(0.01, Math.min(Ra - 0.01, Ra - th));

  function involuteTheta(r) {
    if (r <= Rb) return 0;
    const cosPhi = Math.max(-1, Math.min(1, Rb / r));
    const phi = Math.acos(cosPhi);
    return Math.tan(phi) - phi;
  }

  const invAlpha = Math.tan(alpha) - alpha;
  const invAlphaA = involuteTheta(Ra);
  const halfToothAtPitch = Math.PI / (2 * z);
  const halfToothAtBase = Math.max(0, halfToothAtPitch + invAlpha);

  const points = [];
  const samples = 3;

  for (let i = 0; i < z; i++) {
    const centerAngle = (2 * Math.PI * i) / z;
    const pitchToothAngle = Math.PI / z;
    const rootAngle1 = centerAngle - pitchToothAngle;

    if (Rf < Rb) {
      const thetaBase1 = centerAngle - halfToothAtBase;
      points.push(new THREE.Vector2(Rf * Math.cos(rootAngle1), Rf * Math.sin(rootAngle1)));
      points.push(new THREE.Vector2(Rb * Math.cos(thetaBase1), Rb * Math.sin(thetaBase1)));
    } else {
      points.push(new THREE.Vector2(Rf * Math.cos(rootAngle1), Rf * Math.sin(rootAngle1)));
    }

    for (let s = 1; s <= samples; s++) {
      const frac = s / samples;
      const r = Rb + (Ra - Rb) * frac;
      const theta = involuteTheta(r);
      const a = centerAngle - (halfToothAtBase - theta);
      points.push(new THREE.Vector2(r * Math.cos(a), r * Math.sin(a)));
    }

    const aTipRising = centerAngle - (halfToothAtBase - invAlphaA);
    const aTipFalling = centerAngle + (halfToothAtBase - invAlphaA);
    points.push(new THREE.Vector2(Ra * Math.cos(aTipRising), Ra * Math.sin(aTipRising)));
    points.push(new THREE.Vector2(Ra * Math.cos(aTipFalling), Ra * Math.sin(aTipFalling)));

    for (let s = samples - 1; s >= 0; s--) {
      const frac = s / samples;
      const r = Rb + (Ra - Rb) * frac;
      const theta = involuteTheta(r);
      const a = centerAngle + (halfToothAtBase - theta);
      points.push(new THREE.Vector2(r * Math.cos(a), r * Math.sin(a)));
    }

    if (Rf < Rb) {
      const rootAngle2 = centerAngle + halfToothAtBase;
      points.push(new THREE.Vector2(Rf * Math.cos(rootAngle2), Rf * Math.sin(rootAngle2)));
    }
  }

  if (points.length > 0) {
    shape.moveTo(points[0].x, points[0].y);
    for (let k = 1; k < points.length; k++) {
      shape.lineTo(points[k].x, points[k].y);
    }
    shape.closePath();
  }

  if (boreR && boreR > 0 && boreR < Ra) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, boreR, 0, Math.PI * 2, true);
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

/**
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
 * Builds an authentic 3D Stepped Shaft with multi-diameter journals,
 * transition shoulders, and optional spline head.
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
