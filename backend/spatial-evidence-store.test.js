import test from "node:test";
import assert from "node:assert/strict";
import {
  storeSpatialEvidence,
  getSpatialEvidence,
  computeEvidenceHash,
} from "./src/spatial-evidence-store.js";

test("spatial-evidence-store stores and retrieves full depth grid and contour coordinates without loss", () => {
  const mockSpatialEvidence = {
    schema_version: "1.0",
    status: "ok",
    images: [
      {
        image_index: 0,
        width: 1024,
        height: 768,
        segmentation: {
          status: "ok",
          boundary_polygon_px: [[10.5, 20.3], [15.2, 45.1], [80.4, 99.2]],
          mask_area_ratio: 0.35,
        },
        depth: {
          status: "ok",
          depth_type: "relative",
          metric: false,
          depth_grid: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
            [0.7, 0.8, 0.9],
          ],
        },
        opencv: {
          contours: [
            {
              type: "outer_contour",
              points_px: [[10, 20], [30, 40], [50, 60]],
              area_px2: 15420.5,
            },
          ],
          circles: [
            { cx_px: 512, cy_px: 384, radius_px: 120, confidence: 0.98 },
          ],
        },
      },
    ],
  };

  const evidenceId = storeSpatialEvidence(mockSpatialEvidence);
  assert.ok(evidenceId);
  assert.match(evidenceId, /^ev_/);

  const retrieved = getSpatialEvidence(evidenceId);
  assert.ok(retrieved);
  assert.deepEqual(retrieved.images[0].segmentation.boundary_polygon_px, [[10.5, 20.3], [15.2, 45.1], [80.4, 99.2]]);
  assert.deepEqual(retrieved.images[0].depth.depth_grid, [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
    [0.7, 0.8, 0.9],
  ]);
  assert.deepEqual(retrieved.images[0].opencv.contours[0].points_px, [[10, 20], [30, 40], [50, 60]]);
  assert.equal(retrieved.images[0].opencv.circles[0].radius_px, 120);
});

test("computeEvidenceHash produces deterministic hashes", () => {
  const dataA = { foo: "bar", count: 10 };
  const dataB = { foo: "bar", count: 10 };
  const dataC = { foo: "baz", count: 10 };

  assert.equal(computeEvidenceHash(dataA), computeEvidenceHash(dataB));
  assert.notEqual(computeEvidenceHash(dataA), computeEvidenceHash(dataC));
});
