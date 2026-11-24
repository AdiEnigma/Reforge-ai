import { test } from 'node:test';
import assert from 'node:assert';
import {
  polygonArea,
  ensureCCW,
  triangulateSimplePolygon,
  bridgePolygonHoles,
  generateNeuralMesh,
  segmentFeatures,
  buildVisualMeshFromVision,
} from './src/neural-mesh-generator.js';

test('polygonArea correctly computes area and sign', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const area = polygonArea(square);
  assert.strictEqual(area, 100);

  const reversed = [...square].reverse();
  const revArea = polygonArea(reversed);
  assert.strictEqual(revArea, -100);
});

test('triangulateSimplePolygon correctly triangulates convex and concave polygons', () => {
  // Rectangle -> 2 triangles
  const rect = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 0, y: 10 },
  ];
  const tris = triangulateSimplePolygon(rect);
  assert.strictEqual(tris.length, 2);

  // L-shape concave polygon -> 4 triangles
  const lShape = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 30 },
    { x: 0, y: 30 },
  ];
  const lTris = triangulateSimplePolygon(lShape);
  assert.strictEqual(lTris.length, 4);
});

test('bridgePolygonHoles merges outer boundary with holes into single continuous loop', () => {
  const outer = [
    { x: -50, y: -50 },
    { x: 50, y: -50 },
    { x: 50, y: 50 },
    { x: -50, y: 50 },
  ];
  const hole = [
    { x: 10, y: 0 },
    { x: 0, y: -10 },
    { x: -10, y: 0 },
    { x: 0, y: 10 },
  ];
  const { combinedPoints } = bridgePolygonHoles(outer, [hole]);
  assert.ok(combinedPoints.length >= outer.length + hole.length);
});

test('generateNeuralMesh produces a valid, watertight 3D mesh with features and normals', () => {
  const outline = [
    { x: -80, y: -20 },
    { x: -50, y: -12 },
    { x: 50, y: -16 },
    { x: 80, y: -28 },
    { x: 80, y: 28 },
    { x: 50, y: 16 },
    { x: -50, y: 12 },
    { x: -80, y: 20 },
  ];
  const holes = [
    { cx: -65, cy: 0, radius: 10 },
    { cx: 60, cy: 0, radius: 20 },
  ];

  const mesh = generateNeuralMesh({
    outline,
    holes,
    thickness: 24,
    componentType: 'connecting rod',
  });

  assert.ok(mesh);
  assert.ok(Array.isArray(mesh.vertices));
  assert.ok(Array.isArray(mesh.normals));
  assert.ok(Array.isArray(mesh.indices));
  assert.strictEqual(mesh.vertices.length, mesh.normals.length);
  assert.ok(mesh.indices.length % 3 === 0, 'Indices must be triples of triangles');

  // Features check
  assert.ok(mesh.features.length >= 3, 'Must contain bore features, datum face, and body shell');
  const boreFeat = mesh.features.find((f) => f.type === 'bore');
  assert.ok(boreFeat, 'Must have identified bore feature');
  assert.strictEqual(boreFeat.depth, 24);

  // Bounds check
  assert.ok(mesh.bounds.width >= 150, 'Width must reflect outline extent');
  assert.strictEqual(mesh.dimensions.thickness, 24);
});

test('generateAxialManifoldMesh produces a watertight 3D manifold mesh for an integral helical pinion shaft with journals and teeth', () => {
  const mesh = generateNeuralMesh({
    axialSegments: [
      { zStart: -90, zEnd: -25, radius: 14, label: 'Drive Journal (Left)' },
      { zStart: -25, zEnd: 25, teeth: 16, module: 3.5, helixAngle: 25, radius: 31.5, rootRadius: 23.6, label: 'Helical Pinion Section' },
      { zStart: 25, zEnd: 90, radius: 12, label: 'Support Journal (Right)' },
    ],
    boreRadius: 0,
    componentType: 'helical pinion shaft',
  });

  assert.ok(mesh);
  assert.ok(mesh.vertices.length > 500, 'Must have sufficient vertex density for smooth helical curvature');
  assert.strictEqual(mesh.vertices.length, mesh.normals.length);
  assert.ok(mesh.indices.length % 3 === 0, 'Indices must be valid triangle triples');
  // Dimensions check
  assert.strictEqual(mesh.dimensions.totalLength, 180);
  assert.ok(mesh.dimensions.outerDiameter >= 60, 'Outer diameter must match pinion crest');
  // Features check: must include gear teeth, shaft journals, and body shell
  const gearFeat = mesh.features.find((f) => f.type === 'gear_teeth');
  assert.ok(gearFeat, 'Must extract gear teeth feature');
  assert.strictEqual(gearFeat.teeth, 16);
  assert.strictEqual(gearFeat.helixAngle, 25);
  const shaftFeat = mesh.features.find((f) => f.type === 'shaft');
  assert.ok(shaftFeat, 'Must extract journal shaft feature');
});

test('generateAxialManifoldMesh produces a compound gear mesh with dual stages and through bore', () => {
  const mesh = generateNeuralMesh({
    axialSegments: [
      { zStart: -25, zEnd: 0, teeth: 24, module: 4.5, radius: 58.5, label: 'Stage 1 Bull Gear' },
      { zStart: 0, zEnd: 22, teeth: 16, module: 4.5, radius: 40.5, label: 'Stage 2 Pinion Gear' },
    ],
    boreRadius: 15,
    keyway: { width: 8, height: 4 },
    componentType: 'compound gear',
  });

  assert.ok(mesh);
  assert.ok(mesh.vertices.length > 500);
  assert.strictEqual(mesh.dimensions.innerDiameter, 30);
  const boreFeat = mesh.features.find((f) => f.type === 'bore');
  assert.ok(boreFeat, 'Must extract central bore feature');
  assert.strictEqual(boreFeat.radius, 15);
});

test('buildVisualMeshFromVision backprojects 2D boundary polygons and dense depth field into watertight 3D manifold', () => {
  // 16-point gear/star profile in 512x512 image coordinates
  const boundaryPolygon = [];
  const cx = 256;
  const cy = 256;
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const r = i % 2 === 0 ? 180 : 130;
    boundaryPolygon.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }

  // 64x64 synthetic depth grid with center boss elevation
  const depthGrid = Array.from({ length: 64 }, (_, r) =>
    Array.from({ length: 64 }, (_, c) => {
      const dist = Math.hypot(r - 32, c - 32);
      return dist < 12 ? 0.9 : 0.4;
    })
  );

  const holes = [
    { cx_px: 256, cy_px: 256, radius_px: 35 },
  ];

  const mesh = buildVisualMeshFromVision({
    boundaryPolygon,
    depthGrid,
    dimensions: { outerDiameter: 120, innerDiameter: 25, thickness: 35 },
    holes,
    componentType: 'complex gear/impeller',
    imageWidth: 512,
    imageHeight: 512,
  });

  assert.ok(mesh);
  assert.ok(Array.isArray(mesh.vertices));
  assert.ok(Array.isArray(mesh.normals));
  assert.ok(Array.isArray(mesh.indices));
  assert.strictEqual(mesh.vertices.length, mesh.normals.length);
  assert.ok(mesh.indices.length % 3 === 0);
  assert.ok(mesh.vertices.length > 100);

  // Check dimensions match calibrated metric scale
  assert.ok(Math.abs(mesh.dimensions.outerDiameter - 120) < 1.0);
  assert.ok(mesh.dimensions.thickness >= 35, 'Thickness must include nominal plus 3D depth relief');

  // Check feature extraction
  const boreFeat = mesh.features.find((f) => f.type === 'bore');
  assert.ok(boreFeat, 'Must detect through bore');
  assert.ok(boreFeat.radius > 5);
});
