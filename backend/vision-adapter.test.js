import test from "node:test";
import assert from "node:assert/strict";
import { isVisionEnabled, callVisionService, buildVisionEvidenceSummary } from "./vision-adapter.js";

test("isVisionEnabled defaults to false", () => {
  assert.equal(isVisionEnabled(), false);
});

test("callVisionService returns null when vision is disabled", async () => {
  const result = await callVisionService(
    [{ data: "AAA", mimeType: "image/png" }],
    { outerDiameter: 50 }
  );
  assert.equal(result, null);
});

test("buildVisionEvidenceSummary returns null on empty or null input", () => {
  assert.equal(buildVisionEvidenceSummary(null), null);
  assert.equal(buildVisionEvidenceSummary({}), null);
  assert.equal(buildVisionEvidenceSummary({ images: "not-an-array" }), null);
});

test("buildVisionEvidenceSummary preserves structure and strips heavy arrays", () => {
  const mockVisionResult = {
    schema_version: "1.0",
    status: "ok",
    device: { requested: "auto", actual: "cpu", sam2_loaded: false, depth_loaded: false },
    images: [
      {
        image_index: 0,
        width: 640,
        height: 480,
        quality: { blur_score: 120.5, contrast_score: 45.2, clipped_fraction: 0.01 },
        segmentation: {
          status: "ok",
          bbox_xyxy_px: [10, 20, 200, 220],
          mask_area_ratio: 0.25,
          candidate_count: 1,
          score: 0.95,
          needs_user_selection: false,
        },
        opencv: {
          contours: [{ type: "outer_contour" }, { type: "inner_contour" }],
          circles: [{ cx_px: 100, cy_px: 100, radius_px: 50 }],
          ellipses: [],
          lines: [{ length_px: 80 }],
          bounding_box: { axis_aligned: [10, 20, 190, 200] },
          symmetry_hints: { bilateral: true },
          warnings: ["Perspective warning"],
        },
        depth: {
          status: "ok",
          depth_type: "relative",
          metric: false,
          warnings: ["Relative depth only; not a measurement in millimetres."],
        },
        calibration: {
          status: "calibrated",
          mm_per_pixel: 0.5,
          confidence: 0.85,
        },
      },
    ],
    warnings: [],
  };

  const summary = buildVisionEvidenceSummary(mockVisionResult);
  assert.equal(summary.schema_version, "1.0");
  assert.equal(summary.status, "ok");
  assert.equal(summary.images.length, 1);

  const img = summary.images[0];
  assert.equal(img.width, 640);
  assert.equal(img.height, 480);
  assert.equal(img.segmentation.status, "ok");
  assert.equal(img.segmentation.score, 0.95);

  // Notice opencv contours array was reduced to contour_count
  assert.equal(img.opencv.contour_count, 2);
  assert.equal(img.opencv.circle_count, 1);
  assert.equal(img.opencv.line_count, 1);
  assert.equal(img.depth.depth_type, "relative");
  assert.equal(img.depth.metric, false);
});

