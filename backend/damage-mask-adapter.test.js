import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDamageMasks } from "./damage-mask-adapter.js";

test("valid pixel masks are normalised for the uploaded images", () => {
  const result = normalizeDamageMasks(
    {
      ok: true,
      masks: [
        {
          imageIndex: 0,
          width: 640,
          height: 480,
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          stats: {
            maskedPixels: 1200,
            severity: "severe",
            extent: "widespread",
            damageRatioOfComponent: 0.24,
            types: ["rust", "rust", "surface_pitting"],
            confidence: 1.7,
          },
        },
      ],
    },
    2
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].imageIndex, 0);
  assert.equal(result[0].stats.confidence, 1);
  assert.deepEqual(result[0].stats.types, ["rust", "surface_pitting"]);
  assert.equal(result[0].stats.severity, "severe");
});

test("invalid or missing masks are discarded instead of painted", () => {
  const result = normalizeDamageMasks(
    {
      ok: true,
      masks: [
        { imageIndex: 0, dataUrl: "javascript:alert(1)", stats: {} },
        { imageIndex: 0, width: 10, height: 10, dataUrl: "data:image/png;base64,AAAA", stats: null },
      ],
    },
    1
  );
  assert.deepEqual(result, []);
});
