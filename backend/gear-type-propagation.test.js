import test from "node:test";
import assert from "node:assert/strict";
import {
  fallbackDeterministicAnalysis,
  reconcileGeminiWithVision,
  resolveGeometryFromVision,
} from "./src/vision-geometry-resolver.js";

const CONFIRMED_TYPES = [
  "spur",
  "helical",
  "bevel",
  "worm",
  "rack",
  "internal",
  "compound",
  "pinion",
  "stepped",
  "flanged",
];

function pngData(width, height) {
  const hex =
    "89504e470d0a1a0a0000000d49484452" +
    width.toString(16).padStart(8, "0") +
    height.toString(16).padStart(8, "0") +
    "0806000000";
  return Buffer.from(hex, "hex").toString("base64");
}

function visionWithTeeth(teeth, width, height) {
  return {
    images: [
      {
        width,
        height,
        opencv: {
          circles: [{ radius_px: 90 }, { radius_px: 22 }],
          symmetry_hints: [`teeth: ${teeth}`],
          bounding_box: { rotated_size_px: [width, height] },
        },
        calibration: { status: "calibrated", mm_per_pixel: 0.5 },
      },
    ],
  };
}

test("resolveGeometryFromVision preserves each explicit gear type from distinct image fixtures", () => {
  CONFIRMED_TYPES.forEach((gearType, index) => {
    const width = 180 + index * 16;
    const height = 174 + index * 19;
    const reference = {
      gearType,
      teeth: 18 + index,
      outerDiameter: 92 + index * 2,
      thickness: 18 + index,
    };
    const result = resolveGeometryFromVision(
      visionWithTeeth(reference.teeth, width, height),
      reference
    );

    assert.equal(result.analysis.gearType, gearType, `${gearType} analysis type`);
    assert.equal(
      result.analysis.geometryRecipe.gear.gearType,
      gearType,
      `${gearType} recipe type`
    );
    assert.equal(result.analysis.requiresGearTypeConfirmation, false, gearType);
    assert.equal(result.analysis.classificationSource, "user_reference", gearType);
  });
});

test("resolveGeometryFromVision does not let an elongated image overwrite an explicit non-pinion type", () => {
  const result = resolveGeometryFromVision(
    visionWithTeeth(20, 640, 120),
    { gearType: "bevel", teeth: 20, outerDiameter: 90, thickness: 20 }
  );
  assert.equal(result.analysis.gearType, "bevel");
  assert.equal(result.analysis.componentType, "bevel gear");
  assert.equal(result.analysis.geometryRecipe.gear.gearType, "bevel");
});

test("fallbackDeterministicAnalysis preserves each explicit gear type from distinct PNG fixtures", () => {
  CONFIRMED_TYPES.forEach((gearType, index) => {
    const width = 160 + index * 12;
    const image = [{ data: pngData(width, width - 4), mimeType: "image/png" }];
    const analysis = fallbackDeterministicAnalysis(
      {
        gearType,
        componentType: "gear",
        name: `${gearType} reference ${index}`,
        teeth: 16 + index,
        outerDiameter: 80 + index * 3,
        thickness: 16 + index,
      },
      "offline",
      image
    );

    assert.equal(analysis.gearType, gearType, `${gearType} analysis type`);
    assert.equal(analysis.requiresGearTypeConfirmation, false, gearType);
    if (gearType === "worm") {
      assert.equal(analysis.geometryType, "worm_drive_spindle");
    } else if (gearType === "compound") {
      assert.equal(analysis.geometryType, "compound_gear_cluster");
    } else if (gearType === "rack") {
      assert.equal(analysis.geometryType, "linear_rack");
    } else if (gearType === "internal") {
      assert.equal(analysis.geometryType, "internal_ring_gear");
    } else if (gearType === "pinion") {
      assert.equal(analysis.geometryType, "integral_pinion_shaft");
    } else if (gearType === "bevel") {
      assert.equal(analysis.geometryType, "bevel_gear");
    } else {
      assert.equal(analysis.geometryRecipe.style, "gear", gearType);
      assert.equal(analysis.geometryRecipe.gear.gearType, gearType, gearType);
    }
  });
});

test("fallbackDeterministicAnalysis keeps explicit unknown unconfirmed even for an elongated image", () => {
  const image = [{ data: pngData(640, 120), mimeType: "image/png" }];
  const analysis = fallbackDeterministicAnalysis(
    { gearType: "unknown", componentType: "gear", teeth: 20 },
    "offline",
    image
  );
  assert.equal(analysis.gearType, "unknown");
  assert.equal(analysis.requiresGearTypeConfirmation, true);
  assert.match(analysis.uncertainties.join(" "), /Gear type could not be identified/);
  assert.notEqual(analysis.geometryType, "integral_pinion_shaft");
});

test("reconcileGeminiWithVision lets explicit metadata override a conflicting Gemini type", () => {
  const reconciled = reconcileGeminiWithVision(
    {
      componentType: "spur gear",
      gearType: "spur",
      teeth: 20,
      dimensions: { outerDiameter: 100 },
      geometryRecipe: { style: "gear", gear: { gearType: "spur", teeth: 20 } },
    },
    visionWithTeeth(20, 600, 140),
    { gearType: "bevel", teeth: 20, outerDiameter: 100 }
  );
  assert.equal(reconciled.gearType, "bevel");
  assert.equal(reconciled.componentType, "bevel gear");
  assert.equal(reconciled.geometryRecipe.gear.gearType, "bevel");
});
