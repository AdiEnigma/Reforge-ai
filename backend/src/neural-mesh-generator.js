/**
 * neural-mesh-generator.js
 * 
 * Generates continuous, watertight 3D triangle surface meshes from 2D contours,
 * depth cues, and feature segmentations without rigid archetype templates.
 * 
 * Pipeline stages implemented:
 * - Polygon triangulation with hole bridges (Ear Clipping)
 * - 3D watertight manifold construction (front cap, back cap, outer wall skirt, internal bore walls)
 * - Surface depth relief mapping (Z perturbation from continuous depth cues)
 * - Physical metric scaling and auto-centering at (0, 0, 0)
 * - Autonomous feature segmentation (bores, bolt holes, mounting faces, bosses)
 */

/**
 * Computes signed area of a 2D polygon. Positive = Counter-Clockwise (CCW).
 */
export function polygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

/**
 * Ensures points are in Counter-Clockwise (CCW) order.
 */
export function ensureCCW(points) {
  if (polygonArea(points) < 0) {
    return [...points].reverse();
  }
  return [...points];
}

/**
 * Ensures points are in Clockwise (CW) order (for holes).
 */
export function ensureCW(points) {
  if (polygonArea(points) > 0) {
    return [...points].reverse();
  }
  return [...points];
}

/**
 * Tests if point P is inside triangle (A, B, C).
 */
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const invDenom = 1 / (dot00 * dot11 - dot01 * dot01 + 1e-12);
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

  return u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6;
}

/**
 * Triangulates a simple 2D polygon using Ear Clipping.
 * Returns array of triangle index triples [[i, j, k], ...].
 */
export function triangulateSimplePolygon(points) {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const indices = [];
  const V = Array.from({ length: n }, (_, i) => i);
  let count = n;

  // Safety limit to prevent infinite loops on degenerate/self-intersecting inputs
  let iterations = 0;
  const maxIterations = 3 * n * n;

  while (count > 2 && iterations < maxIterations) {
    iterations++;
    let earFound = false;

    for (let i = 0; i < count; i++) {
      const prevIdx = (i - 1 + count) % count;
      const currIdx = i;
      const nextIdx = (i + 1) % count;

      const u = V[prevIdx];
      const v = V[currIdx];
      const w = V[nextIdx];

      const ax = points[u].x, ay = points[u].y;
      const bx = points[v].x, by = points[v].y;
      const cx = points[w].x, cy = points[w].y;

      // Check convexity (CCW)
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross <= 1e-7) continue;

      // Check if any other vertex lies inside triangle (ax, ay), (bx, by), (cx, cy)
      let hasPointInside = false;
      for (let p = 0; p < count; p++) {
        if (p === prevIdx || p === currIdx || p === nextIdx) continue;
        const px = points[V[p]].x;
        const py = points[V[p]].y;
        if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
          hasPointInside = true;
          break;
        }
      }

      if (!hasPointInside) {
        indices.push([u, v, w]);
        V.splice(currIdx, 1);
        count--;
        earFound = true;
        break;
      }
    }

    if (!earFound) {
      // 1. Check for duplicate or collinear points causing numerical stall
      let cleaned = false;
      for (let i = 0; i < count; i++) {
        const curr = V[i];
        const next = V[(i + 1) % count];
        const prev = V[(i - 1 + count) % count];
        const d = Math.hypot(points[curr].x - points[next].x, points[curr].y - points[next].y);
        if (d < 1e-5) {
          V.splice(i, 1);
          count--;
          cleaned = true;
          break;
        }
        const cross =
          (points[curr].x - points[prev].x) * (points[next].y - points[prev].y) -
          (points[curr].y - points[prev].y) * (points[next].x - points[prev].x);
        if (Math.abs(cross) < 1e-7) {
          V.splice(i, 1);
          count--;
          cleaned = true;
          break;
        }
      }
      if (cleaned) continue;

      // 2. Strict policy: If no valid ear exists, avoid creating self-intersecting ribbons
      break;
    }
  }

  return indices;
}

/**
 * Discretizes a circle hole into a polygon ring of N points.
 */
export function circleToPolygon(cx, cy, radius, segments = 16) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    pts.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  }
  return ensureCW(pts);
}

/**
 * Merges an outer CCW boundary ring and CW hole rings into a single
 * continuous boundary polygon using bridge cuts.
 */
export function bridgePolygonHoles(outerRing, holeRings) {
  if (!holeRings || holeRings.length === 0) {
    return { combinedPoints: ensureCCW(outerRing), bridgeMap: [] };
  }

  let currentPolygon = ensureCCW(outerRing);

  // Sort holes by max X descending to connect rightmost holes first
  const sortedHoles = [...holeRings].map((hole) => ensureCW(hole));
  sortedHoles.sort((a, b) => {
    const maxA = Math.max(...a.map((p) => p.x));
    const maxB = Math.max(...b.map((p) => p.x));
    return maxB - maxA;
  });

  for (const hole of sortedHoles) {
    // Find rightmost vertex of hole
    let rightmostHoleIdx = 0;
    let maxX = -Infinity;
    for (let i = 0; i < hole.length; i++) {
      if (hole[i].x > maxX) {
        maxX = hole[i].x;
        rightmostHoleIdx = i;
      }
    }
    const hPoint = hole[rightmostHoleIdx];

    // Find best outer polygon vertex to bridge with (closest X >= hPoint.x)
    let bestOuterIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < currentPolygon.length; i++) {
      const oPoint = currentPolygon[i];
      const dist = Math.hypot(oPoint.x - hPoint.x, oPoint.y - hPoint.y);
      if (dist < minDist) {
        minDist = dist;
        bestOuterIdx = i;
      }
    }

    // Splice hole into currentPolygon at bestOuterIdx with 2 bridge edges
    const reorderedHole = [
      ...hole.slice(rightmostHoleIdx),
      ...hole.slice(0, rightmostHoleIdx),
    ];

    const spliced = [
      ...currentPolygon.slice(0, bestOuterIdx + 1),
      ...reorderedHole,
      reorderedHole[0], // loop back to hole entry
      currentPolygon[bestOuterIdx], // bridge back to outer
      ...currentPolygon.slice(bestOuterIdx + 1),
    ];
    currentPolygon = spliced;
  }

  return { combinedPoints: currentPolygon };
}

/**
 * Normalized tooth profile elevation between 0 (dedendum root) and 1 (addendum crest).
 * Computes a smooth involute-approximation profile.
 */
function smoothToothModulation(phase) {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.22) {
    // Crest (Top Land)
    return 1.0;
  } else if (p < 0.48) {
    // Down Flank (Smooth Cosine Fall)
    const f = (p - 0.22) / 0.26;
    return 0.5 + 0.5 * Math.cos(f * Math.PI);
  } else if (p < 0.74) {
    // Root (Bottom Land)
    return 0.0;
  } else {
    // Up Flank (Smooth Cosine Rise)
    const f = (p - 0.74) / 0.26;
    return 0.5 - 0.5 * Math.cos(f * Math.PI);
  }
}

/**
 * Spline groove radial modulation.
 */
function splineFluteModulation(angle, splineCount, splineDepth, baseRadius) {
  const p = (((angle * splineCount) / (Math.PI * 2)) % 1 + 1) % 1;
  // Flute notch occupies ~30% of pitch
  if (p > 0.35 && p < 0.65) {
    return Math.max(0.5, baseRadius - splineDepth);
  }
  return baseRadius;
}

/**
 * Generates an axial/rotational watertight 3D manifold mesh with localized
 * geometric features (helical/spur gear teeth, splines, flange collars, bearing journals, step shoulders).
 *
 * @param {Object} options
 * @param {Array<Object>} options.segments - Ordered axial segments along Z axis
 * @param {number} [options.boreRadius] - Central through-bore radius (0 if solid)
 * @param {Object} [options.keyway] - Optional keyway { width, height }
 * @param {string} [options.componentType] - Semantic label
 * @returns {Object} Complete meshData structure ready for Three.js GLTF/BufferGeometry
 */
export function generateAxialManifoldMesh({
  segments = [],
  boreRadius = 0,
  keyway = null,
  componentType = 'engineered component',
}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    // Fallback: 100mm x Ø30mm cylindrical shaft
    segments = [{ zStart: -50, zEnd: 50, radius: 15, label: 'Main Shaft' }];
  }

  const angularSamples = 144; // 144 radial divisions for ultra-crisp tooth and round profile
  const segMaxBore = Array.isArray(segments) && segments.length > 0
    ? Math.max(0, ...segments.map((s) => Number(s.innerRadius ?? s.inner_radius ?? s.boreRadius ?? 0)))
    : 0;
  const boreR = typeof boreRadius === 'number' && boreRadius > 0 ? boreRadius : segMaxBore;
  const vertices = [];
  const indices = [];
  const features = [];

  // Sort segments by zStart ascending
  const sortedSegments = [...segments].sort((a, b) => a.zStart - b.zStart);

  // We will build a continuous sequence of rings along Z
  // Each ring has `angularSamples` outer vertices, and optionally `angularSamples` inner bore vertices
  const rings = []; // { z, outerIndices: number[], innerIndices: number[] }

  sortedSegments.forEach((seg, sIdx) => {
    const zStart = seg.zStart;
    const zEnd = seg.zEnd;
    const len = Math.max(0.1, zEnd - zStart);
    const teeth = seg.teeth && seg.teeth >= 4 ? Math.round(seg.teeth) : 0;
    const helixAngle = seg.helixAngle || 0;
    const splines = seg.splineCount && seg.splineCount >= 2 ? Math.round(seg.splineCount) : 0;
    const splineDepth = seg.splineDepth || (seg.radius ? seg.radius * 0.16 : 2);
    const m = seg.module || (teeth > 0 ? (seg.radius * 2) / (teeth + 2) : 3.0);
    const rOuter = seg.radius || (teeth > 0 ? (teeth * m) / 2 + m : 15);
    const rRoot = seg.rootRadius || (teeth > 0 ? Math.max(0.5, rOuter - 2.25 * m) : rOuter * 0.78);
    const rPitch = teeth > 0 ? (teeth * m) / 2 : rOuter * 0.9;

    // Register inspection feature
    if (seg.featureType === 'worm_thread' || (seg.pitch && seg.pitch > 0)) {
      const p = seg.pitch || 8.0;
      const starts = seg.starts || 1;
      features.push({
        id: `feature-worm-thread-${sIdx + 1}`,
        type: 'worm_thread',
        label: `${starts}-Start Archimedean Worm Thread (p${Math.round(p * 10) / 10}mm)`,
        pitch: p,
        starts,
        faceWidth: len,
        radius: rOuter,
        rootRadius: seg.rootRadius || (rOuter * 0.70),
        cx: 0,
        cy: 0,
        cz: (zStart + zEnd) / 2,
        confidence: 0.98,
      });
    } else if (teeth > 0) {
      features.push({
        id: `feature-gear-teeth-${sIdx + 1}`,
        type: 'gear_teeth',
        label: `${teeth}T ${helixAngle > 0 ? 'Helical' : 'Spur'} Teeth (m${Math.round(m * 10) / 10})`,
        teeth,
        module: m,
        helixAngle,
        faceWidth: len,
        cx: 0,
        cy: 0,
        cz: (zStart + zEnd) / 2,
        confidence: 0.98,
        metadata: {
          teeth,
          helixAngle,
          pitchDiameter: Math.round(rPitch * 2 * 10) / 10,
          faceWidth: len,
        },
      });
    } else if (splines > 0) {
      features.push({
        id: `feature-spline-${sIdx + 1}`,
        type: 'spline',
        label: `${splines}-Spline Precision Shaft Section`,
        radius: rOuter,
        depth: len,
        cx: 0,
        cy: 0,
        cz: (zStart + zEnd) / 2,
        confidence: 0.95,
      });
    } else if (seg.flangeHoles || rOuter >= 30) {
      features.push({
        id: `feature-flange-${sIdx + 1}`,
        type: 'flange',
        label: seg.label || `Mounting Flange Ø${Math.round(rOuter * 2)}mm`,
        radius: rOuter,
        depth: len,
        cx: 0,
        cy: 0,
        cz: (zStart + zEnd) / 2,
        confidence: 0.95,
      });
    } else {
      features.push({
        id: `feature-shaft-${sIdx + 1}`,
        type: 'shaft',
        label: seg.label || `Bearing Journal Ø${Math.round(rOuter * 2)}mm x ${Math.round(len)}mm`,
        radius: rOuter,
        length: len,
        cx: 0,
        cy: 0,
        cz: (zStart + zEnd) / 2,
        confidence: 0.95,
      });
    }

    // Determine number of axial slices for this segment
    let slices = 2;
    if (seg.featureType === 'worm_thread' || (seg.pitch && seg.pitch > 0)) {
      slices = Math.max(48, Math.ceil(len * 2.5));
    } else if (teeth > 0 && Math.abs(helixAngle) > 0) {
      slices = Math.max(12, Math.min(36, Math.ceil(len / 2.5)));
    } else if (teeth > 0 || splines > 0) {
      slices = Math.max(4, Math.ceil(len / 8));
    }

    for (let sl = 0; sl < slices; sl++) {
      const alpha = sl / (slices - 1);
      const z = zStart + alpha * len;

      const outerIndices = [];
      const innerIndices = [];

      for (let j = 0; j < angularSamples; j++) {
        const theta = (j / angularSamples) * Math.PI * 2;
        let r = rOuter;

        if (seg.featureType === 'worm_thread' || (seg.pitch && seg.pitch > 0)) {
          const p = seg.pitch || 8.0;
          const starts = seg.starts || 1;
          const lead = seg.lead || starts * p;
          const rTip = rOuter;
          const rBase = seg.rootRadius || rOuter * 0.7;
          const threadZ = (theta * lead) / (Math.PI * 2);
          const halfTooth = (p * 0.35) / 2;
          const halfSpace = (p * 0.85) / 2;
          let maxElev = 0;
          for (let s = 0; s < starts; s++) {
            const startOffset = (s / starts) * lead;
            const delta = Math.abs((((z - threadZ - startOffset) % p) + 1.5 * p) % p - 0.5 * p);
            let elev = 0;
            if (delta <= halfTooth) elev = 1.0;
            else if (delta < halfSpace) elev = (halfSpace - delta) / (halfSpace - halfTooth);
            if (elev > maxElev) maxElev = elev;
          }
          let endFade = 1.0;
          const runout = p * 0.75;
          if (z - zStart < runout) endFade = Math.min(endFade, Math.max(0, (z - zStart) / runout));
          if (zEnd - z < runout) endFade = Math.min(endFade, Math.max(0, (zEnd - z) / runout));
          r = rBase + (rTip - rBase) * maxElev * endFade;
        } else if (teeth > 0) {
          // Helical tooth twist
          const twist = (helixAngle !== 0 && rPitch > 0)
            ? (z * Math.tan((helixAngle * Math.PI) / 180)) / rPitch
            : 0;
          const phase = ((theta - twist) * teeth) / (Math.PI * 2);
          const elev = smoothToothModulation(phase);
          r = rRoot + (rOuter - rRoot) * elev;
        } else if (splines > 0) {
          r = splineFluteModulation(theta, splines, splineDepth, rOuter);
        }

        // Outer vertex
        const ox = r * Math.cos(theta);
        const oy = r * Math.sin(theta);
        const oIdx = vertices.length / 3;
        vertices.push(ox, oy, z);
        outerIndices.push(oIdx);

        // Inner bore vertex (if through bore exists)
        if (boreR > 0) {
          const ix = boreR * Math.cos(theta);
          const iy = boreR * Math.sin(theta);
          const iIdx = vertices.length / 3;
          vertices.push(ix, iy, z);
          innerIndices.push(iIdx);
        }
      }

      rings.push({ z, outerIndices, innerIndices });
    }
  });

  // Connect consecutive rings with quad strips (2 triangles per quad)
  for (let r = 0; r < rings.length - 1; r++) {
    const ringA = rings[r];
    const ringB = rings[r + 1];
    const dz = ringB.z - ringA.z;
    const isStepShoulder = Math.abs(dz) < 1e-3;

    for (let j = 0; j < angularSamples; j++) {
      const next = (j + 1) % angularSamples;

      const a0 = ringA.outerIndices[j];
      const a1 = ringA.outerIndices[next];
      const b0 = ringB.outerIndices[j];
      const b1 = ringB.outerIndices[next];

      if (isStepShoulder) {
        // Step transition shoulders along Z face outwards with consistent winding
        indices.push(a0, a1, b0);
        indices.push(a1, b1, b0);
      } else {
        // Outer cylindrical/profile surface (outward normal: +r)
        indices.push(a0, a1, b0);
        indices.push(a1, b1, b0);
      }

      // Inner bore surface (inward normal towards bore axis: -r, only for longitudinal spans)
      if (boreR > 0 && !isStepShoulder) {
        const ia0 = ringA.innerIndices[j];
        const ia1 = ringA.innerIndices[next];
        const ib0 = ringB.innerIndices[j];
        const ib1 = ringB.innerIndices[next];

        indices.push(ia0, ib0, ia1);
        indices.push(ia1, ib0, ib1);
      }
    }
  }

  // End Cap at zStart of first ring (normal points -Z)
  const firstRing = rings[0];
  const zFirst = firstRing.z;
  if (boreR <= 0) {
    const centerIdx = vertices.length / 3;
    vertices.push(0, 0, zFirst);
    for (let j = 0; j < angularSamples; j++) {
      const next = (j + 1) % angularSamples;
      indices.push(centerIdx, firstRing.outerIndices[next], firstRing.outerIndices[j]);
    }
  } else {
    for (let j = 0; j < angularSamples; j++) {
      const next = (j + 1) % angularSamples;
      const o0 = firstRing.outerIndices[j];
      const o1 = firstRing.outerIndices[next];
      const i0 = firstRing.innerIndices[j];
      const i1 = firstRing.innerIndices[next];
      indices.push(o0, i0, i1);
      indices.push(o0, i1, o1);
    }
  }

  // End Cap at zEnd of last ring (normal points +Z)
  const lastRing = rings[rings.length - 1];
  const zLast = lastRing.z;
  if (boreR <= 0) {
    const centerIdx = vertices.length / 3;
    vertices.push(0, 0, zLast);
    for (let j = 0; j < angularSamples; j++) {
      const next = (j + 1) % angularSamples;
      indices.push(centerIdx, lastRing.outerIndices[j], lastRing.outerIndices[next]);
    }
  } else {
    for (let j = 0; j < angularSamples; j++) {
      const next = (j + 1) % angularSamples;
      const o0 = lastRing.outerIndices[j];
      const o1 = lastRing.outerIndices[next];
      const i0 = lastRing.innerIndices[j];
      const i1 = lastRing.innerIndices[next];
      indices.push(o0, o1, i1);
      indices.push(o0, i1, i0);
    }
  }

  // Add Central Bore inspection feature if bore exists
  if (boreR > 0) {
    const totalLen = Math.abs(zLast - zFirst);
    features.unshift({
      id: 'feature-bore-1',
      type: 'bore',
      label: `Central Through Bore Ø${Math.round(boreR * 2 * 10) / 10}mm`,
      radius: boreR,
      depth: totalLen,
      cx: 0,
      cy: 0,
      cz: (zFirst + zLast) / 2,
      confidence: 1.0,
      metadata: {
        diameter: boreR * 2,
        depth: totalLen,
      },
    });
  }

  // Compute normals and bounds
  const normals = computeNormals(vertices, indices);
  const bounds = computeBounds(vertices);

  // Overall Manifold Shell Feature
  features.push({
    id: 'feature-body-1',
    type: 'other',
    label: `${String(componentType || 'Engineered Component').toUpperCase()} 3D Manifold Shell`,
    confidence: 1.0,
    metadata: {
      envelopeDimensions: [bounds.width, bounds.length, bounds.height],
    },
  });

  return {
    vertices,
    normals,
    indices,
    features,
    bounds,
    dimensions: {
      width: Math.round(bounds.width * 10) / 10,
      length: Math.round(bounds.length * 10) / 10,
      thickness: Math.round(bounds.height * 10) / 10,
      outerDiameter: Math.round(Math.max(bounds.width, bounds.length) * 10) / 10,
      innerDiameter: boreR * 2,
      totalLength: Math.round(bounds.height * 10) / 10,
    },
  };
}
function computeBounds(points3D) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < points3D.length; i += 3) {
    const x = points3D[i];
    const y = points3D[i + 1];
    const z = points3D[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  return {
    minX, maxX, minY, maxY, minZ, maxZ,
    width: Math.max(0.1, maxX - minX),
    length: Math.max(0.1, maxY - minY),
    height: Math.max(0.1, maxZ - minZ),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

/**
 * Computes vertex normals for a triangle mesh by accumulating weighted face normals.
 */
function computeNormals(vertices, indices) {
  const normals = new Float32Array(vertices.length);

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;

    const ax = vertices[i0], ay = vertices[i0 + 1], az = vertices[i0 + 2];
    const bx = vertices[i1], by = vertices[i1 + 1], bz = vertices[i1 + 2];
    const cx = vertices[i2], cy = vertices[i2 + 1], cz = vertices[i2 + 2];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz;
    normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz;
    normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz;
  }

  // Normalize each normal vector
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-6) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    } else {
      normals[i + 2] = 1.0;
    }
  }

  return Array.from(normals);
}

/**
 * Autonomous 3D feature segmentation over the geometric entities.
 * Automatically classifies bores, mounting holes, datum faces, and exterior bosses.
 */
export function segmentFeatures({ holes, thickness, bounds, componentType }) {
  const features = [];
  const cleanHoles = Array.isArray(holes) ? holes : [];

  // 1. Bore & Mounting Hole Classification
  if (cleanHoles.length > 0) {
    const maxRadius = Math.max(...cleanHoles.map((h) => h.radius || 0));

    cleanHoles.forEach((h, idx) => {
      const radius = h.radius || 5;
      const isLarge = radius >= maxRadius * 0.75;
      const isCenter = Math.abs(h.cx || 0) < 5 && Math.abs(h.cy || 0) < 5;

      const isBore = isCenter || (cleanHoles.length <= 2 && isLarge);
      const featureId = isBore ? `feature-bore-${idx + 1}` : `feature-mounting-holes-${idx + 1}`;
      const featureType = isBore ? 'bore' : 'mounting_hole';
      const diaMm = Math.round(radius * 2 * 10) / 10;

      features.push({
        id: featureId,
        type: featureType,
        label: isBore
          ? `Bore Ø${diaMm}mm`
          : `Mounting Hole Ø${diaMm}mm`,
        radius,
        depth: thickness,
        cx: h.cx || 0,
        cy: h.cy || 0,
        cz: 0,
        confidence: 0.95,
        metadata: {
          diameter: diaMm,
          depth: thickness,
          center: [h.cx || 0, h.cy || 0, 0],
        },
      });
    });
  }

  // 2. Primary Datum Mounting Face
  features.push({
    id: 'feature-face-1',
    type: 'mounting_face',
    label: 'Primary Datum Mounting Face',
    width: Math.round(bounds.width * 10) / 10,
    height: Math.round(bounds.length * 10) / 10,
    cx: 0,
    cy: 0,
    cz: thickness / 2,
    confidence: 1.0,
    metadata: {
      surfaceAreaMm2: Math.round(bounds.width * bounds.length),
      normal: [0, 0, 1],
    },
  });

  // 3. Main Continuous Solid Body
  features.push({
    id: 'feature-body-1',
    type: 'other',
    label: `${String(componentType || 'Engineered Component').toUpperCase()} 3D Manifold Shell`,
    confidence: 1.0,
    metadata: {
      envelopeDimensions: [bounds.width, bounds.length, bounds.height],
    },
  });

  return features;
}

/**
 * Generates a complete, watertight 3D Neural/Surface Mesh from 2D contours,
 * depth cues, holes, and physical dimensions.
 *
 * @param {Object} options
 * @param {Array<{x: number, y: number}>} options.outline - Closed 2D contour points in mm
 * @param {Array<{cx: number, cy: number, radius: number}>} [options.holes] - Through-holes
 * @param {number} [options.thickness] - Physical depth in mm (defaults to 18mm)
 * @param {Array<number>} [options.surfaceRelief] - Optional heightmap perturbation
 * @param {string} [options.componentType] - Component label
 * @returns {Object} Complete meshData structure ready for Three.js GLTF/BufferGeometry
 */
export function generateNeuralMesh({
  outline,
  holes = [],
  thickness = 18,
  surfaceRelief = null,
  componentType = 'engineered component',
  axialSegments = null,
  boreRadius = 0,
  keyway = null,
}) {
  // If axial segments are provided, generate a continuous 3D axial manifold mesh
  if (Array.isArray(axialSegments) && axialSegments.length > 0) {
    return generateAxialManifoldMesh({
      segments: axialSegments,
      boreRadius,
      keyway,
      componentType,
    });
  }

  const cleanOutline = ensureCCW(Array.isArray(outline) && outline.length >= 3 ? outline : [
    { x: -50, y: -25 },
    { x: 50, y: -25 },
    { x: 50, y: 25 },
    { x: -50, y: 25 },
  ]);

  const t = typeof thickness === 'number' && thickness > 0 ? thickness : 18;
  const halfT = t / 2;

  const nOuter = cleanOutline.length;
  const vertices = [];
  const indices = [];

  // 1. Outer Perimeter Vertices
  // Front Outer [0 .. nOuter - 1] at +halfT
  for (let i = 0; i < nOuter; i++) {
    const pt = cleanOutline[i];
    const zOffset = surfaceRelief && surfaceRelief[i] ? surfaceRelief[i] : 0;
    vertices.push(pt.x, pt.y, halfT + zOffset);
  }
  // Back Outer [nOuter .. 2 * nOuter - 1] at -halfT
  const outerBackStart = nOuter;
  for (let i = 0; i < nOuter; i++) {
    const pt = cleanOutline[i];
    vertices.push(pt.x, pt.y, -halfT);
  }

  // 2. Outer Boundary Skirt (outward facing normal: +r)
  for (let i = 0; i < nOuter; i++) {
    const next = (i + 1) % nOuter;
    const f0 = i;
    const f1 = next;
    const b0 = outerBackStart + i;
    const b1 = outerBackStart + next;

    indices.push(f0, b0, f1);
    indices.push(f1, b0, b1);
  }

  // 3. Internal Hole Vertices & Skirts
  const cleanHoles = Array.isArray(holes) ? holes.filter((h) => h && h.radius > 0) : [];
  const taggedHoleRings = [];

  for (const hole of cleanHoles) {
    const segs = 16;
    const hFrontStart = vertices.length / 3;
    const holeRingPts = [];

    // Front hole ring at +halfT
    for (let i = 0; i < segs; i++) {
      const angle = (i / segs) * Math.PI * 2;
      const x = (hole.cx || 0) + Math.cos(angle) * hole.radius;
      const y = (hole.cy || 0) + Math.sin(angle) * hole.radius;
      vertices.push(x, y, halfT);
    }

    // Back hole ring at -halfT
    const hBackStart = vertices.length / 3;
    for (let i = 0; i < segs; i++) {
      const angle = (i / segs) * Math.PI * 2;
      const x = (hole.cx || 0) + Math.cos(angle) * hole.radius;
      const y = (hole.cy || 0) + Math.sin(angle) * hole.radius;
      vertices.push(x, y, -halfT);

      holeRingPts.push({
        x,
        y,
        frontIdx: hFrontStart + i,
        backIdx: hBackStart + i,
      });
    }

    // Cylindrical through-hole skirt (inward normal facing bore axis: -r)
    for (let i = 0; i < segs; i++) {
      const next = (i + 1) % segs;
      const f0 = hFrontStart + i;
      const f1 = hFrontStart + next;
      const b0 = hBackStart + i;
      const b1 = hBackStart + next;

      indices.push(f0, f1, b0);
      indices.push(f1, b1, b0);
    }

    taggedHoleRings.push(ensureCW(holeRingPts));
  }

  // 4. Endcap Triangulation (Front Cap +Z, Back Cap -Z)
  if (taggedHoleRings.length === 0) {
    const capTriangles = triangulateSimplePolygon(cleanOutline);
    for (const tri of capTriangles) {
      indices.push(tri[0], tri[1], tri[2]);
      indices.push(outerBackStart + tri[0], outerBackStart + tri[2], outerBackStart + tri[1]);
    }
  } else {
    const taggedOuter = cleanOutline.map((p, i) => ({
      ...p,
      frontIdx: i,
      backIdx: outerBackStart + i,
    }));
    const { combinedPoints } = bridgePolygonHoles(taggedOuter, taggedHoleRings);
    const capTriangles = triangulateSimplePolygon(combinedPoints);
    for (const tri of capTriangles) {
      const p0 = combinedPoints[tri[0]];
      const p1 = combinedPoints[tri[1]];
      const p2 = combinedPoints[tri[2]];
      indices.push(p0.frontIdx, p1.frontIdx, p2.frontIdx);
      indices.push(p0.backIdx, p2.backIdx, p1.backIdx);
    }
  }

  // 5. Normal Vectors
  const normals = computeNormals(vertices, indices);

  // 6. Tight Bounds & Feature Segmentation
  const bounds = computeBounds(vertices);
  const features = segmentFeatures({ holes: cleanHoles, thickness: t, bounds, componentType });

  return {
    vertices,
    normals,
    indices,
    features,
    bounds,
    dimensions: {
      width: Math.round(bounds.width * 10) / 10,
      length: Math.round(bounds.length * 10) / 10,
      thickness: Math.round(bounds.height * 10) / 10,
    },
  };
}

/**
 * Backprojects 2D boundary polygons and dense depth fields into a continuous,
 * watertight 3D manifold mesh directly from visual input — without archetype pigeonholing.
 *
 * @param {Object} options
 * @param {Array<Array<number>>|Array<{x: number, y: number}>} options.boundaryPolygon - 2D contour points in pixel space
 * @param {Array<Array<number>>} [options.depthGrid] - 2D matrix (e.g. 64x64) of normalized depth values (0..1)
 * @param {Object} [options.dimensions] - Physical dimensions in mm { outerDiameter, innerDiameter, width, length, thickness, height }
 * @param {Array<Object>} [options.holes] - Internal circular features or holes { cx_px, cy_px, radius_px } or { cx, cy, radius }
 * @param {string} [options.componentType] - Semantic label
 * @param {number} [options.imageWidth] - Original image width
 * @param {number} [options.imageHeight] - Original image height
 * @param {number} [options.mmPerPixel] - Calibration ratio if known
 * @returns {Object} Complete meshData structure ready for Three.js BufferGeometry
 */
export function buildVisualMeshFromVision({
  boundaryPolygon = [],
  depthGrid = null,
  dimensions = {},
  holes = [],
  componentType = "engineered component",
  imageWidth = 512,
  imageHeight = 512,
  mmPerPixel = null,
}) {
  // 1. Clean and normalize input boundary polygon points
  const rawPts = Array.isArray(boundaryPolygon) ? boundaryPolygon : [];
  const pts = [];

  for (const p of rawPts) {
    if (Array.isArray(p) && p.length >= 2) {
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
    } else if (p && typeof p === "object") {
      const x = Number(p.x ?? p[0]);
      const y = Number(p.y ?? p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
    }
  }

  // Fallback: If not enough points, construct an authentic 16-point circular profile
  if (pts.length < 3) {
    const defaultR = 120;
    const cx = imageWidth / 2;
    const cy = imageHeight / 2;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * defaultR, y: cy + Math.sin(a) * defaultR });
    }
  }

  // 2. Compute pixel bounds & center
  let minPxX = Infinity, maxPxX = -Infinity;
  let minPxY = Infinity, maxPxY = -Infinity;
  for (const pt of pts) {
    if (pt.x < minPxX) minPxX = pt.x;
    if (pt.x > maxPxX) maxPxX = pt.x;
    if (pt.y < minPxY) minPxY = pt.y;
    if (pt.y > maxPxY) maxPxY = pt.y;
  }

  const cxPx = (minPxX + maxPxX) / 2;
  const cyPx = (minPxY + maxPxY) / 2;
  const spanPxX = Math.max(1, maxPxX - minPxX);
  const spanPxY = Math.max(1, maxPxY - minPxY);
  const maxSpanPx = Math.max(spanPxX, spanPxY);

  // 3. Determine metric scale (mm per pixel)
  let scaleMm = 0.2; // default 0.2 mm/pixel
  if (typeof mmPerPixel === "number" && mmPerPixel > 0) {
    scaleMm = mmPerPixel;
  } else if (dimensions?.outerDiameter && dimensions.outerDiameter > 0) {
    scaleMm = dimensions.outerDiameter / maxSpanPx;
  } else if (dimensions?.width && dimensions.width > 0) {
    scaleMm = Math.max(dimensions.width, dimensions.length || 0) / maxSpanPx;
  } else if (dimensions?.length && dimensions.length > 0) {
    scaleMm = dimensions.length / maxSpanPx;
  } else {
    // Standard engineered component span ~ 80mm
    scaleMm = 80 / maxSpanPx;
  }

  // 4. Physical thickness
  const t = Math.max(
    4,
    Number(dimensions?.thickness) ||
      Number(dimensions?.height) ||
      Number(dimensions?.length && dimensions.length < 50 ? dimensions.length : 24) ||
      24
  );
  const halfT = t / 2;

  // 5. Transform polygon points to centered mm coordinates
  const outlineMm = pts.map((p) => ({
    x: Math.round((p.x - cxPx) * scaleMm * 100) / 100,
    y: Math.round(-(p.y - cyPx) * scaleMm * 100) / 100, // Invert Y so up in image is +Y in CAD
  }));
  const cleanOutline = ensureCCW(outlineMm);

  // 6. Process internal holes / bores
  const rawHoles = Array.isArray(holes) ? holes : [];
  const cleanHoles = [];
  const holeRings = [];

  for (const h of rawHoles) {
    if (!h) continue;
    let hx = 0;
    let hy = 0;
    let hr = 0;

    if (h.cx_px != null && h.cy_px != null && h.radius_px != null) {
      hx = (Number(h.cx_px) - cxPx) * scaleMm;
      hy = -(Number(h.cy_px) - cyPx) * scaleMm;
      hr = Number(h.radius_px) * scaleMm;
    } else {
      hx = Number(h.cx || 0);
      hy = Number(h.cy || 0);
      hr = Number(h.radius || 0);
    }

    // Keep hole if valid radius and inside the component envelope
    const maxBoundR = (maxSpanPx * scaleMm) / 2;
    if (hr >= 1.0 && hr < maxBoundR * 0.85 && Math.hypot(hx, hy) < maxBoundR * 0.95) {
      cleanHoles.push({ cx: Math.round(hx * 10) / 10, cy: Math.round(hy * 10) / 10, radius: Math.round(hr * 10) / 10 });
      holeRings.push(circleToPolygon(hx, hy, hr, 16));
    }
  }

  // 7. Depth Relief sampling
  const hasDepthGrid = Array.isArray(depthGrid) && depthGrid.length >= 4 && Array.isArray(depthGrid[0]);
  const sampleDepth = (normU, normV) => {
    if (!hasDepthGrid) return 0.5;
    const rows = depthGrid.length;
    const cols = depthGrid[0].length;
    const r = Math.max(0, Math.min(rows - 1, normV * (rows - 1)));
    const c = Math.max(0, Math.min(cols - 1, normU * (cols - 1)));
    const r0 = Math.floor(r), r1 = Math.min(rows - 1, r0 + 1);
    const c0 = Math.floor(c), c1 = Math.min(cols - 1, c0 + 1);
    const dr = r - r0, dc = c - c0;
    const v00 = Number(depthGrid[r0][c0]) || 0;
    const v01 = Number(depthGrid[r0][c1]) || 0;
    const v10 = Number(depthGrid[r1][c0]) || 0;
    const v11 = Number(depthGrid[r1][c1]) || 0;
    return (v00 * (1 - dc) + v01 * dc) * (1 - dr) + (v10 * (1 - dc) + v11 * dc) * dr;
  };

  const nOuter = cleanOutline.length;
  const vertices = [];
  const indices = [];

  // 8. Sample mean depth for centering relief
  let sumDepth = 0;
  for (let i = 0; i < nOuter; i++) {
    const pt = cleanOutline[i];
    const u = Math.max(0, Math.min(1, (pt.x / scaleMm + cxPx - minPxX) / spanPxX));
    const v = Math.max(0, Math.min(1, (-pt.y / scaleMm + cyPx - minPxY) / spanPxY));
    sumDepth += sampleDepth(u, v);
  }
  const meanDepth = nOuter > 0 ? sumDepth / nOuter : 0.5;
  const reliefScale = hasDepthGrid ? t * 0.25 : 0;

  // 8a. Outer Perimeter Vertices
  // Front Outer [0 .. nOuter - 1] at +halfT (+ depth relief)
  for (let i = 0; i < nOuter; i++) {
    const pt = cleanOutline[i];
    const u = Math.max(0, Math.min(1, (pt.x / scaleMm + cxPx - minPxX) / spanPxX));
    const v = Math.max(0, Math.min(1, (-pt.y / scaleMm + cyPx - minPxY) / spanPxY));
    const dVal = sampleDepth(u, v);
    const zOffset = (dVal - meanDepth) * reliefScale;
    vertices.push(pt.x, pt.y, halfT + zOffset);
  }

  // Back Outer [nOuter .. 2 * nOuter - 1] at -halfT
  const outerBackStart = nOuter;
  for (let i = 0; i < nOuter; i++) {
    const pt = cleanOutline[i];
    vertices.push(pt.x, pt.y, -halfT);
  }

  // 8b. Outer Boundary Skirt (outward facing normal: +r)
  for (let i = 0; i < nOuter; i++) {
    const next = (i + 1) % nOuter;
    const f0 = i;
    const f1 = next;
    const b0 = outerBackStart + i;
    const b1 = outerBackStart + next;

    indices.push(f0, b0, f1);
    indices.push(f1, b0, b1);
  }

  // 8c. Internal Hole Vertices & Skirts
  const taggedHoleRings = [];
  for (const hole of cleanHoles) {
    const segs = 16;
    const hFrontStart = vertices.length / 3;
    const holeRingPts = [];

    // Front hole ring at +halfT
    for (let i = 0; i < segs; i++) {
      const angle = (i / segs) * Math.PI * 2;
      const x = hole.cx + Math.cos(angle) * hole.radius;
      const y = hole.cy + Math.sin(angle) * hole.radius;
      vertices.push(x, y, halfT);
    }

    // Back hole ring at -halfT
    const hBackStart = vertices.length / 3;
    for (let i = 0; i < segs; i++) {
      const angle = (i / segs) * Math.PI * 2;
      const x = hole.cx + Math.cos(angle) * hole.radius;
      const y = hole.cy + Math.sin(angle) * hole.radius;
      vertices.push(x, y, -halfT);

      holeRingPts.push({
        x,
        y,
        frontIdx: hFrontStart + i,
        backIdx: hBackStart + i,
      });
    }

    // Cylindrical through-hole skirt (inward normal facing bore axis: -r)
    for (let i = 0; i < segs; i++) {
      const next = (i + 1) % segs;
      const f0 = hFrontStart + i;
      const f1 = hFrontStart + next;
      const b0 = hBackStart + i;
      const b1 = hBackStart + next;

      indices.push(f0, f1, b0);
      indices.push(f1, b1, b0);
    }

    taggedHoleRings.push(ensureCW(holeRingPts));
  }

  // 8d. Endcap Triangulation (Front Cap +Z, Back Cap -Z)
  if (taggedHoleRings.length === 0) {
    const capTriangles = triangulateSimplePolygon(cleanOutline);
    for (const tri of capTriangles) {
      indices.push(tri[0], tri[1], tri[2]);
      indices.push(outerBackStart + tri[0], outerBackStart + tri[2], outerBackStart + tri[1]);
    }
  } else {
    const taggedOuter = cleanOutline.map((p, i) => ({
      ...p,
      frontIdx: i,
      backIdx: outerBackStart + i,
    }));
    const { combinedPoints } = bridgePolygonHoles(taggedOuter, taggedHoleRings);
    const capTriangles = triangulateSimplePolygon(combinedPoints);
    for (const tri of capTriangles) {
      const p0 = combinedPoints[tri[0]];
      const p1 = combinedPoints[tri[1]];
      const p2 = combinedPoints[tri[2]];
      indices.push(p0.frontIdx, p1.frontIdx, p2.frontIdx);
      indices.push(p0.backIdx, p2.backIdx, p1.backIdx);
    }
  }

  // 9. Normals & Bounding Box
  const normals = computeNormals(vertices, indices);
  const bounds = computeBounds(vertices);
  const features = segmentFeatures({ holes: cleanHoles, thickness: t, bounds, componentType });

  return {
    vertices,
    normals,
    indices,
    features,
    bounds,
    dimensions: {
      width: Math.round(bounds.width * 10) / 10,
      length: Math.round(bounds.length * 10) / 10,
      thickness: Math.round(bounds.height * 10) / 10,
      outerDiameter: Math.round(Math.max(bounds.width, bounds.length) * 10) / 10,
      innerDiameter: cleanHoles.length > 0 ? cleanHoles[0].radius * 2 : 0,
    },
  };
}
