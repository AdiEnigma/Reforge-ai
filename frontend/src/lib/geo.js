import * as THREE from "three";

export const matBody = new THREE.MeshStandardMaterial({ color: "#3d332c", metalness: 0.75, roughness: 0.45 });
export const matAccent = new THREE.MeshStandardMaterial({ color: "#b76308", metalness: 0.6, roughness: 0.5 });
export const matRim = new THREE.MeshStandardMaterial({ color: "#de822b", metalness: 0.8, roughness: 0.35 });
export const matDark = new THREE.MeshStandardMaterial({ color: "#271e18", metalness: 0.5, roughness: 0.6 });

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

export function gearShape(teeth, outerR, toothHeight, boreR) {
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  const s = step / 4;
  const rootR = outerR - toothHeight;
  shape.moveTo(outerR, 0);
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    shape.lineTo(Math.cos(a) * outerR, Math.sin(a) * outerR);
    shape.lineTo(Math.cos(a + s) * outerR, Math.sin(a + s) * outerR);
    shape.lineTo(Math.cos(a + s * 2) * rootR, Math.sin(a + s * 2) * rootR);
    shape.lineTo(Math.cos(a + s * 3) * rootR, Math.sin(a + s * 3) * rootR);
    shape.lineTo(Math.cos(a + s * 4) * outerR, Math.sin(a + s * 4) * outerR);
  }
  shape.closePath();
  if (boreR > 0) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, boreR, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return shape;
}
