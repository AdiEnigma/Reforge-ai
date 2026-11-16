import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAssumptions,
  buildCadDimensions,
  deriveUserDimensions,
  hasAnchorDimension,
} from "./assumptions.js";

function gearAnalysis() {
  return {
    componentType: "spur gear",
    confidence: 0.7,
    dimensions: { outerDiameter: 48, innerDiameter: 10, height: 20 },
    teeth: 22,
    module: 2.1,
    helixAngle: 0,
    geometryRecipe: {
      style: "gear",
      gear: { module: 2.1, teeth: 22, boreRadius: 5, faceWidth: 20, helixAngle: 0 },
    },
  };
}

test("deriveAssumptions marks unreferenced dimensions as estimated", () => {
  const { analysis, hasEstimates, anchorDimension, anchorSource } = deriveAssumptions(
    gearAnalysis()
  );

  assert.equal(hasEstimates, true);
  assert.equal(anchorDimension, null);
  assert.equal(anchorSource, null);
  assert.equal(analysis.dimensionSources.outerDiameter, "estimated");
  assert.ok(analysis.dimensionConfidence.outerDiameter > 0);
  assert.ok(analysis.dimensionsDetail.length > 0);
});

test("deriveAssumptions promotes user reference to anchor and keeps other sources", () => {
  const { analysis, anchorDimension, anchorSource, hasEstimates } = deriveAssumptions(
    gearAnalysis(),
    { reference: { teeth: 24 } }
  );

  assert.equal(analysis.teeth, 24);
  assert.equal(analysis.dimensionSources.teeth, "user");
  assert.equal(anchorDimension, "teeth");
  assert.equal(anchorSource, "user");
  assert.equal(hasEstimates, true);
});

test("deriveAssumptions snaps gear module to ISO series and derives outer diameter", () => {
  const { analysis } = deriveAssumptions(gearAnalysis());
  assert.equal(analysis.module, 2);
  assert.equal(analysis.dimensions.outerDiameter, 48);
  assert.equal(analysis.geometryRecipe.gear.module, 2);
  assert.ok(
    analysis.assumptions.some((note) => note.includes("ISO standard 2 mm")),
    "module snap should be recorded"
  );
});

test("deriveAssumptions snaps bearing bore and outer diameter to standard sizes", () => {
  const bearing = {
    componentType: "ball bearing",
    confidence: 0.6,
    dimensions: { outerDiameter: 47.4, innerDiameter: 20.3, width: 14 },
  };

  const { analysis } = deriveAssumptions(bearing);
  assert.equal(analysis.dimensions.innerDiameter, 20);
  assert.equal(analysis.dimensions.outerDiameter, 47);
  assert.ok(analysis.assumptions.some((note) => note.startsWith("Bearing bore")));
});

test("deriveAssumptions captures calibrated scale from vision evidence", () => {
  const { analysis, scale } = deriveAssumptions(gearAnalysis(), {
    visionEvidence: {
      images: [
        { calibration: { status: "calibrated", mm_per_pixel: 0.25, confidence: 0.4 } },
        {
          calibration: {
            status: "calibrated",
            mm_per_pixel: 0.12,
            confidence: 0.85,
            source: "reference",
          },
        },
      ],
    },
  });

  assert.deepEqual(scale, {
    status: "calibrated",
    mmPerPixel: 0.12,
    confidence: 0.85,
    source: "reference",
  });
  assert.equal(analysis.scale.mmPerPixel, 0.12);
});

test("deriveAssumptions ignores low confidence calibration", () => {
  const { analysis } = deriveAssumptions(gearAnalysis(), {
    visionEvidence: {
      images: [{ calibration: { status: "calibrated", mm_per_pixel: 0.1, confidence: 0.2 } }],
    },
  });
  assert.equal(analysis.scale, null);
});

test("buildCadDimensions and deriveUserDimensions expose provenance", () => {
  const { analysis } = deriveAssumptions(gearAnalysis(), {
    reference: { height: 25 },
  });

  const dimensions = buildCadDimensions(analysis);
  const height = dimensions.find((dimension) => dimension.key === "height");
  assert.equal(height.value, 25);
  assert.equal(height.unit, "mm");
  assert.equal(height.source, "user");
  assert.equal(height.anchor, true);

  const teeth = dimensions.find((dimension) => dimension.key === "teeth");
  assert.equal(teeth.unit, "count");

  assert.deepEqual(deriveUserDimensions(analysis), { height: 25 });
  assert.equal(hasAnchorDimension(analysis.dimensionSources), true);
  assert.equal(hasAnchorDimension([]), false);
});
