/**
 * geometry-projection.js
 * Projects the actual reconstructed THREE geometry into orthographic drawing
 * entities. No component-specific silhouette templates are used here: the
 * visible/hidden edges, extents and verified dimensions all come from the
 * meshes returned by buildModel(analysis).
 */

import * as THREE from "three";
import { buildModel } from "../reconstruct.js";
import { line, centerMark } from "./geometry.js";

const SHARP_COS = Math.cos((25 * Math.PI) / 180);
const VIEWS = [
  { key: "front", direction: new THREE.Vector3(0, 0, 1), project: (v) => ({ x: v.x, y: -v.y }) },
  { key: "top", direction: new THREE.Vector3(0, 1, 0), project: (v) => ({ x: v.x, y: v.z }) },
  { key: "side", direction: new THREE.Vector3(1, 0, 0), project: (v) => ({ x: -v.z, y: -v.y }) },
];

function quantize(value, step = 0.0001) {
  return Math.round(value / step);
}

function pointKey(point) {
  return `${quantize(point.x)},${quantize(point.y)},${quantize(point.z)}`;
}

function segmentKey(a, b) {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function collectTriangles(meshes) {
  const triangles = [];
  for (const mesh of meshes) {
    const position = mesh.geometry?.getAttribute?.("position");
    if (!position) continue;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      const a = new THREE.Vector3().fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
      const c = new THREE.Vector3().fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
      const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (normal.lengthSq() < 1e-12) continue;
      normal.normalize();
      triangles.push({ a, b, c, normal });
    }
  }
  return triangles;
}

function collectEdges(triangles) {
  const edges = new Map();
  const addEdge = (a, b, normal) => {
    const key = segmentKey(a, b);
    const existing = edges.get(key);
    if (existing) existing.normals.push(normal);
    else edges.set(key, { a, b, normals: [normal] });
  };
  for (const triangle of triangles) {
    addEdge(triangle.a, triangle.b, triangle.normal);
    addEdge(triangle.b, triangle.c, triangle.normal);
    addEdge(triangle.c, triangle.a, triangle.normal);
  }
  return [...edges.values()];
}

function countTeeth(vertices, center, mmPerWorld, maxRadius) {
  if (maxRadius <= 0) return 0;
  const binCount = 720;
  const bins = new Array(binCount).fill(0);

  for (const vertex of vertices) {
    const dx = vertex.x - center.x;
    const dy = vertex.y - center.y;
    const radius = Math.hypot(dx, dy) * mmPerWorld;
    if (!Number.isFinite(radius) || radius < maxRadius * 0.5) continue;
    let theta = Math.atan2(dy, dx);
    if (theta < 0) theta += Math.PI * 2;
    const bin = Math.min(binCount - 1, Math.floor((theta / (Math.PI * 2)) * binCount));
    bins[bin] = Math.max(bins[bin], radius);
  }

  const tipThreshold = maxRadius * 0.99;
  const peaks = [];
  for (let i = 0; i < binCount; i += 1) {
    if (bins[i] < tipThreshold) continue;
    let isPeak = true;
    for (let offset = -2; offset <= 2 && isPeak; offset += 1) {
      if (offset === 0) continue;
      const neighbor = bins[(i + offset + binCount) % binCount];
      if (neighbor > bins[i] + 0.001) isPeak = false;
    }
    if (isPeak) peaks.push(i);
  }

  if (peaks.length <= 1) return 0;
  const gaps = peaks.map((peak, index) => {
    const next = peaks[(index + 1) % peaks.length];
    return next > peak ? next - peak : next + binCount - peak;
  }).sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const pairedTips = gaps.filter((gap) => gap < medianGap * 0.6).length;
  const teeth = pairedTips >= peaks.length * 0.3 ? pairedTips : peaks.length;
  return teeth > 1 ? teeth : 0;
}

function buildRadialFacts(vertices, center, mmPerWorld) {
  const histogram = new Map();
  let maxRadius = 0;

  for (const vertex of vertices) {
    const dx = vertex.x - center.x;
    const dy = vertex.y - center.y;
    const radius = Math.hypot(dx, dy) * mmPerWorld;
    if (!Number.isFinite(radius) || radius < 0.05) continue;
    maxRadius = Math.max(maxRadius, radius);
    const bucket = Math.round(radius * 2) / 2;
    histogram.set(bucket, (histogram.get(bucket) || 0) + 1);
  }

  const minVotes = Math.max(4, Math.ceil(vertices.length * 0.002));
  const radialPeaks = [...histogram.entries()]
    .filter(([, votes]) => votes >= minVotes)
    .map(([radius, votes]) => ({ radius, votes }))
    .sort((a, b) => a.radius - b.radius);
  if (maxRadius > 0) radialPeaks.push({ radius: Math.round(maxRadius * 100) / 100, votes: vertices.length });

  return {
    radialPeaks,
    outerDiameterMm: maxRadius * 2,
    teethCount: countTeeth(vertices, center, mmPerWorld, maxRadius),
  };
}

function projectView(view, edges, meshes, worldCenter, mmPerWorld, worldExtent) {
  const center2D = view.project(worldCenter);
  const raycaster = new THREE.Raycaster();
  const rayOffset = worldExtent * 2 + 1;
  const rayDirection = view.direction.clone().negate();
  const projected = [];

  for (const edge of edges) {
    const first = edge.a;
    const second = edge.b;
    const mid = new THREE.Vector3().addVectors(first, second).multiplyScalar(0.5);
    const depth = new THREE.Vector3().subVectors(mid, worldCenter).dot(view.direction);
    const faceDots = edge.normals.map((normal) => normal.dot(view.direction));
    const isBoundary = edge.normals.length === 1;
    const isSharp = !isBoundary && edge.normals[0].dot(edge.normals[1]) < SHARP_COS;
    const isSilhouette = faceDots.some((dot) => dot > 0) && faceDots.some((dot) => dot < 0);
    if (!isBoundary && !isSharp && !isSilhouette) continue;

    const p1 = view.project(first);
    const p2 = view.project(second);
    const x1 = (p1.x - center2D.x) * mmPerWorld;
    const y1 = (p1.y - center2D.y) * mmPerWorld;
    const x2 = (p2.x - center2D.x) * mmPerWorld;
    const y2 = (p2.y - center2D.y) * mmPerWorld;
    if (Math.hypot(x2 - x1, y2 - y1) < 0.02) continue;

    let occluded = false;
    if (isBoundary || isSharp || isSilhouette) {
      raycaster.set(mid.clone().addScaledVector(view.direction, rayOffset), rayDirection);
      raycaster.far = rayOffset * 2;
      occluded = raycaster.intersectObjects(meshes, false).some(
        (hit) => rayOffset - hit.distance > worldExtent * 0.02
      );
    }
    const hidden = occluded || ((isBoundary || isSharp) && depth < -worldExtent * 0.01);
    projected.push({ x1, y1, x2, y2, hidden });
  }

  const unique = new Map();
  for (const segment of projected) {
    const ax = quantize(segment.x1, 0.01);
    const ay = quantize(segment.y1, 0.01);
    const bx = quantize(segment.x2, 0.01);
    const by = quantize(segment.y2, 0.01);
    const key = ax < bx || (ax === bx && ay <= by)
      ? `${ax},${ay}|${bx},${by}`
      : `${bx},${by}|${ax},${ay}`;
    const existing = unique.get(key);
    if (!existing || (existing.hidden && !segment.hidden)) unique.set(key, segment);
  }

  const segments = [...unique.values()];
  const xs = segments.flatMap((s) => [s.x1, s.x2]);
  const ys = segments.flatMap((s) => [s.y1, s.y2]);
  const xsSafe = xs.length ? xs : [0, 0];
  const ysSafe = ys.length ? ys : [0, 0];
  const width = Math.max(...xsSafe) - Math.min(...xsSafe);
  const height = Math.max(...ysSafe) - Math.min(...ysSafe);

  const entities = segments.map((segment) => line(
    segment.x1,
    segment.y1,
    segment.x2,
    segment.y2,
    segment.hidden ? "hidden" : "visible",
    { source: "reconstructedGeometry" }
  ));

  const halfX = width / 2 + 8;
  const halfY = height / 2 + 8;
  entities.push(line(-halfX, 0, halfX, 0, "centerline", { source: "reconstructedGeometry" }));
  entities.push(line(0, -halfY, 0, halfY, "centerline", { source: "reconstructedGeometry" }));

  return { entities, dimensions: [], width, height };
}

function near(value, candidate, tolerance) {
  return finiteNumber(value) && finiteNumber(candidate) && Math.abs(value - candidate) <= tolerance;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toleranceFor(value) {
  return Math.max(0.75, Math.abs(value) * 0.06);
}

function matchCandidates(value, candidates) {
  if (!finiteNumber(value)) return false;
  return (candidates || []).some((candidate) => near(value, candidate, toleranceFor(value)));
}

/**
 * Drops nominal dimensions that cannot be found in the projected mesh. This is
 * the geometry-to-drawing validation gate used before any dimension is emitted.
 */
export function validateDrawingDimensions(dims, facts) {
  const validated = { ...dims };
  const planarCandidates = [facts.planarExtentMm, facts.outerDiameterMm];
  const radialCandidates = (facts.radialPeaks || []).map((peak) => peak.radius * 2);
  const axialCandidates = [
    facts.overallAxialExtentMm,
    ...(facts.meshAxialExtentsMm || []),
  ];

  const checks = {
    outerDia: planarCandidates,
    width: [facts.planarXExtentMm, facts.planarExtentMm],
    height: [facts.planarYExtentMm, facts.planarExtentMm, ...axialCandidates],
    depth: axialCandidates,
    innerDia: radialCandidates,
  };
  for (const [key, candidates] of Object.entries(checks)) {
    if (!matchCandidates(validated[key], candidates)) delete validated[key];
  }

  if (finiteNumber(validated.teeth) && facts.teethCount > 0) {
    if (Math.abs(validated.teeth - facts.teethCount) > 1) delete validated.teeth;
  } else {
    delete validated.teeth;
  }

  if (finiteNumber(validated.module)) {
    const derivedModule = finiteNumber(validated.outerDia) && finiteNumber(validated.teeth)
      ? validated.outerDia / (validated.teeth + 2)
      : null;
    if (!near(validated.module, derivedModule, Math.max(0.15, Math.abs(derivedModule || 0) * 0.08))) {
      delete validated.module;
    }
  }

  validated.holeDiameters = (facts.radialPeaks || [])
    .filter((peak) => peak.radius > 1)
    .map((peak) => peak.radius * 2);
  return validated;
}

/** Builds verified orthographic views directly from the reconstructed model. */
export function projectReconstructedGeometry(analysis, nominalDims = {}) {
  const model = buildModel(analysis);
  const group = model?.group;
  if (!group) return null;
  group.updateMatrixWorld(true);

  const meshes = [];
  group.traverse((node) => {
    if (node.isMesh && node.visible && node.geometry) meshes.push(node);
  });
  if (!meshes.length) return null;

  const worldBox = new THREE.Box3().setFromObject(group);
  if (worldBox.isEmpty()) return null;
  const worldSize = worldBox.getSize(new THREE.Vector3());
  const worldCenter = worldBox.getCenter(new THREE.Vector3());
  const worldExtent = Math.max(worldSize.x, worldSize.y, worldSize.z, 0.0001);
  const expectedExtent = Math.max(
    finiteNumber(nominalDims.outerDia) ? nominalDims.outerDia : 0,
    finiteNumber(nominalDims.width) ? nominalDims.width : 0,
    finiteNumber(nominalDims.height) ? nominalDims.height : 0,
    finiteNumber(nominalDims.depth) ? nominalDims.depth : 0,
    0.0001
  );
  const mmPerWorld = expectedExtent / worldExtent;

  const triangles = collectTriangles(meshes);
  if (!triangles.length) return null;
  const edges = collectEdges(triangles);

  const vertices = [];
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i += 1) {
      vertices.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    }
  }

  const meshAxialExtentsMm = meshes.map((mesh) => {
    const meshBox = new THREE.Box3().setFromObject(mesh);
    return Math.max(0, meshBox.max.z - meshBox.min.z) * mmPerWorld;
  });
  const radial = buildRadialFacts(vertices, worldCenter, mmPerWorld);
  const facts = {
    valid: true,
    source: "reconstructedGeometry",
    meshCount: meshes.length,
    triangleCount: triangles.length,
    mmPerWorld,
    planarXExtentMm: worldSize.x * mmPerWorld,
    planarYExtentMm: worldSize.y * mmPerWorld,
    planarExtentMm: Math.max(worldSize.x, worldSize.y) * mmPerWorld,
    overallAxialExtentMm: worldSize.z * mmPerWorld,
    meshAxialExtentsMm,
    radialPeaks: radial.radialPeaks,
    outerDiameterMm: radial.outerDiameterMm,
    teethCount: radial.teethCount,
  };

  const views = {};
  for (const view of VIEWS) views[view.key] = projectView(view, edges, meshes, worldCenter, mmPerWorld, worldExtent);
  if (radial.radialPeaks.length > 0) {
    views.front.entities.push(centerMark(0, 0, Math.max(views.front.width, views.front.height) * 0.18, {
      source: "reconstructedGeometry",
    }));
  }

  return { views, facts };
}
