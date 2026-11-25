/**
 * three-dimensions.js
 * 3D Dimension Callout & Technical Annotation Overlay for Three.js Viewports.
 *
 * Renders technical dimension lines, arrows, ticks, extension lines,
 * and high-visibility canvas-rendered billboard text sprites directly in 3D.
 */

import * as THREE from 'three';

const DIM_COLOR = '#ffb77f';
const DIM_LINE_COLOR = 0xffb77f;
const DIM_ACCENT_COLOR = 0xb5e67e;
const DIM_ACCENT_HEX = 0xb5e67e;

/**
 * Creates a crisp billboard Sprite with rendered canvas text.
 */
function createTextSprite(text, { color = '#ffb77f', bg = 'rgba(18, 12, 8, 0.90)', borderColor = '#ffb77f', scale = 1.0 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 440;
  canvas.height = 100;
  const ctx = canvas.getContext('2d');

  // Background rounded pill
  ctx.fillStyle = bg;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 4;

  const r = 18;
  const x = 6;
  const y = 6;
  const w = canvas.width - 12;
  const h = canvas.height - 12;

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Typography
  ctx.font = 'bold 34px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(1.5 * scale, 0.38 * scale, 1.0);
  return sprite;
}

/**
 * Constructs a 3D linear dimension with extension lines, main line, arrow ticks, and text.
 */
function createLinearDimension3D({
  p1,
  p2,
  offsetVec,
  label,
  color = DIM_LINE_COLOR,
  textColor = DIM_COLOR,
  spriteScale = 1.0,
}) {
  const group = new THREE.Group();

  const p1Offset = p1.clone().add(offsetVec);
  const p2Offset = p2.clone().add(offsetVec);

  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });

  // 1. Extension line 1 (from p1 to p1Offset + small overhang)
  const overhang = offsetVec.clone().normalize().multiplyScalar(0.25);
  const ext1End = p1Offset.clone().add(overhang);
  const ext1Geo = new THREE.BufferGeometry().setFromPoints([p1, ext1End]);
  group.add(new THREE.Line(ext1Geo, mat));

  // 2. Extension line 2 (from p2 to p2Offset + small overhang)
  const ext2End = p2Offset.clone().add(overhang);
  const ext2Geo = new THREE.BufferGeometry().setFromPoints([p2, ext2End]);
  group.add(new THREE.Line(ext2Geo, mat));

  // 3. Dimension bar between p1Offset and p2Offset
  const dimGeo = new THREE.BufferGeometry().setFromPoints([p1Offset, p2Offset]);
  group.add(new THREE.Line(dimGeo, mat));

  // 4. Arrow / tick marks at endpoints
  const dir = p2Offset.clone().sub(p1Offset).normalize();
  const perp = new THREE.Vector3().crossVectors(dir, offsetVec.clone().normalize()).multiplyScalar(0.14);
  if (perp.length() < 0.02) {
    perp.set(0, 0.14, 0);
  }

  const tick1Geo = new THREE.BufferGeometry().setFromPoints([
    p1Offset.clone().sub(perp),
    p1Offset.clone().add(perp),
  ]);
  group.add(new THREE.Line(tick1Geo, mat));

  const tick2Geo = new THREE.BufferGeometry().setFromPoints([
    p2Offset.clone().sub(perp),
    p2Offset.clone().add(perp),
  ]);
  group.add(new THREE.Line(tick2Geo, mat));

  // 5. Billboard Text Sprite at midpoint
  const mid = p1Offset.clone().add(p2Offset).multiplyScalar(0.5);
  const textOffset = offsetVec.clone().normalize().multiplyScalar(0.28);
  const sprite = createTextSprite(label, { color: textColor, borderColor: color, scale: spriteScale });
  sprite.position.copy(mid.add(textOffset));
  group.add(sprite);

  return group;
}

/**
 * Builds a complete 3D dimensions annotation group from the component's bounding box & analysis dimensions.
 */
export function build3DDimensionsGroup(mainGroup, analysis) {
  const dimGroup = new THREE.Group();
  dimGroup.name = "dimensions3DOverlay";

  if (!mainGroup || !analysis) return dimGroup;

  const box = new THREE.Box3().setFromObject(mainGroup);
  if (box.isEmpty()) return dimGroup;

  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const dims = analysis.dimensions || {};
  const od = dims.outerDiameter;
  const id = dims.innerDiameter;
  const length = dims.length;
  const width = dims.width;
  const height = dims.height;
  const thickness = dims.thickness;
  const teeth = analysis.teeth;
  const moduleVal = analysis.module;

  // Determine major geometric orientation
  // Turned shafts lie along X axis in this system
  // Revolved parts and gears lie in XY plane, extruded along Z
  const isXShaft = size.x > size.y * 1.35 && size.x > size.z * 1.35;
  const isZAxisPart = size.z > size.x * 1.35 && size.z > size.y * 1.35;

  if (isXShaft) {
    // -------------------------------------------------------------
    // SHAFT / PINION ALONG X AXIS
    // -------------------------------------------------------------
    const lenVal = length || height || thickness || (size.x * 20);
    const lenLabel = `L = ${Number(lenVal).toFixed(1)} mm`;
    const dimLength = createLinearDimension3D({
      p1: new THREE.Vector3(box.min.x, box.min.y, center.z),
      p2: new THREE.Vector3(box.max.x, box.min.y, center.z),
      offsetVec: new THREE.Vector3(0, -0.75, 0.5),
      label: lenLabel,
      color: DIM_ACCENT_HEX,
      textColor: DIM_ACCENT_COLOR,
    });
    dimGroup.add(dimLength);

    const diaVal = od || width || (size.y * 20);
    const diaLabel = `Ø ${Number(diaVal).toFixed(1)} mm`;
    const dimDia = createLinearDimension3D({
      p1: new THREE.Vector3(box.max.x, box.min.y, center.z),
      p2: new THREE.Vector3(box.max.x, box.max.y, center.z),
      offsetVec: new THREE.Vector3(0.75, 0, 0.5),
      label: diaLabel,
      color: DIM_LINE_COLOR,
      textColor: DIM_COLOR,
    });
    dimGroup.add(dimDia);

    // If shaft has bore or internal hollow
    if (id && id > 0) {
      const boreR = (Number(id) / 2).toFixed(1);
      const boreSprite = createTextSprite(`BORE Ø ${Number(id).toFixed(1)} mm (R = ${boreR} mm)`, {
        color: '#c9f88d',
        borderColor: '#b5e67e',
        scale: 0.9,
      });
      boreSprite.position.set(box.min.x - 0.9, center.y, center.z);
      dimGroup.add(boreSprite);
    }
  } else if (
    String(analysis?.componentType || "").toLowerCase().includes("bracket") ||
    String(analysis?.componentType || "").toLowerCase().includes("box") ||
    String(analysis?.componentType || "").toLowerCase().includes("plate") ||
    String(analysis?.componentType || "").toLowerCase().includes("housing") ||
    String(analysis?.componentType || "").toLowerCase().includes("packaging") ||
    String(analysis?.componentType || "").toLowerCase().includes("block") ||
    String(analysis?.componentType || "").toLowerCase().includes("enclosure") ||
    String(analysis?.componentType || "").toLowerCase().includes("chassis") ||
    String(analysis?.geometryType || "").toLowerCase().includes("prismatic") ||
    analysis?.geometryRecipe?.style === "extruded"
  ) {
    // -------------------------------------------------------------
    // PRISMATIC / EXTRUDED (Bracket, Packaging Box, Plate, Housing)
    // -------------------------------------------------------------
    const lenVal = length || width || (Math.max(size.x, size.y) * 20);
    const lenLabel = `L = ${Number(lenVal).toFixed(1)} mm`;
    const dimLength = createLinearDimension3D({
      p1: new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      p2: new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      offsetVec: new THREE.Vector3(0, -0.75, 0.45),
      label: lenLabel,
      color: DIM_LINE_COLOR,
      textColor: DIM_COLOR,
    });
    dimGroup.add(dimLength);

    const widVal = width || (Math.min(size.x, size.y) * 20);
    const widLabel = `W = ${Number(widVal).toFixed(1)} mm`;
    const dimWidth = createLinearDimension3D({
      p1: new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      p2: new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      offsetVec: new THREE.Vector3(-0.75, 0, 0.45),
      label: widLabel,
      color: DIM_LINE_COLOR,
      textColor: DIM_COLOR,
    });
    dimGroup.add(dimWidth);

    const hVal = height || thickness || (size.z * 20);
    const hLabel = `H = ${Number(hVal).toFixed(1)} mm`;
    const dimHeight = createLinearDimension3D({
      p1: new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      p2: new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      offsetVec: new THREE.Vector3(0.65, -0.4, 0),
      label: hLabel,
      color: DIM_ACCENT_HEX,
      textColor: DIM_ACCENT_COLOR,
    });
    dimGroup.add(dimHeight);

    if (id && id > 0) {
      const boreR = (Number(id) / 2).toFixed(1);
      const boreSprite = createTextSprite(`HOLE Ø ${Number(id).toFixed(1)} mm (R = ${boreR} mm)`, {
        color: '#c9f88d',
        bg: 'rgba(12, 22, 10, 0.92)',
        borderColor: '#b5e67e',
        scale: 0.92,
      });
      boreSprite.position.set(center.x, box.max.y + 0.65, center.z);
      dimGroup.add(boreSprite);
    }
  } else {
    // -------------------------------------------------------------
    // GEAR / COMPOUND GEAR / DISC / REVOLVED / PRISMATIC PART
    // -------------------------------------------------------------
    // 1. Primary Diameter (Outer Diameter or Width)
    const diaVal = od || width || (Math.max(size.x, size.y) * 20);
    const diaLabel = `Ø ${Number(diaVal).toFixed(1)} mm`;
    const dimDia = createLinearDimension3D({
      p1: new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      p2: new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      offsetVec: new THREE.Vector3(0, -0.75, 0.45),
      label: diaLabel,
      color: DIM_LINE_COLOR,
      textColor: DIM_COLOR,
    });
    dimGroup.add(dimDia);

    // 2. Face Width / Axial Thickness
    const thickVal = thickness || height || length || (size.z * 20);
    const thickLabel = `W = ${Number(thickVal).toFixed(1)} mm`;
    const dimThick = createLinearDimension3D({
      p1: new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      p2: new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      offsetVec: new THREE.Vector3(0.65, -0.4, 0),
      label: thickLabel,
      color: DIM_ACCENT_HEX,
      textColor: DIM_ACCENT_COLOR,
    });
    dimGroup.add(dimThick);

    // 3. Central Bore Dimension Callout
    if (id && id > 0) {
      const boreR = (Number(id) / 2).toFixed(1);
      const boreSprite = createTextSprite(`BORE Ø ${Number(id).toFixed(1)} mm (R = ${boreR} mm)`, {
        color: '#c9f88d',
        bg: 'rgba(12, 22, 10, 0.92)',
        borderColor: '#b5e67e',
        scale: 0.92,
      });
      boreSprite.position.set(center.x, box.max.y + 0.65, center.z);
      dimGroup.add(boreSprite);

      // Dash leader line from center to billboard
      const leaderMat = new THREE.LineDashedMaterial({
        color: 0xb5e67e,
        dashSize: 0.1,
        gapSize: 0.05,
        depthTest: false,
      });
      const leaderGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(center.x, center.y, box.max.z),
        new THREE.Vector3(center.x, box.max.y + 0.45, center.z),
      ]);
      const leaderLine = new THREE.Line(leaderGeo, leaderMat);
      leaderLine.computeLineDistances();
      dimGroup.add(leaderLine);
    }

    // 4. Teeth & Module Callout (for gear / compound gear)
    if (teeth && teeth > 0) {
      const teethText = moduleVal ? `${teeth}T (m = ${Number(moduleVal).toFixed(2)})` : `${teeth} TEETH`;
      const teethSprite = createTextSprite(teethText, {
        color: '#7ed8e6',
        bg: 'rgba(8, 20, 24, 0.92)',
        borderColor: '#7ed8e6',
        scale: 0.88,
      });
      teethSprite.position.set(box.min.x - 0.75, center.y + 0.6, center.z);
      dimGroup.add(teethSprite);
    }
  }

  return dimGroup;
}
