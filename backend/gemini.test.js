import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeRecipe } from "./gemini.js";
import { applyReferenceDimensions } from "./assumptions.js";

test("sanitizeRecipe preserves centered outline coordinates", () => {
  const recipe = sanitizeRecipe({
    style: "extruded",
    outline: [
      { x: -50, y: -30 },
      { x: 50, y: -30 },
      { x: 50, y: 30 },
      { x: -50, y: 30 },
    ],
    depth: 10,
  });

  assert.ok(recipe);
  assert.deepEqual(recipe.outline, [
    { x: -50, y: -30 },
    { x: 50, y: -30 },
    { x: 50, y: 30 },
    { x: -50, y: 30 },
  ]);
});

test("sanitizeRecipe preserves negative revolved profile z values", () => {
  const recipe = sanitizeRecipe({
    style: "revolved",
    revolvedProfile: [
      { z: -20, radius: 10 },
      { z: 20, radius: 10 },
    ],
  });

  assert.ok(recipe);
  assert.deepEqual(recipe.revolvedProfile, [
    { z: -20, radius: 10 },
    { z: 20, radius: 10 },
  ]);
});

test("dimension ratio clamp caps magnitude but keeps sign", () => {
  const recipe = sanitizeRecipe({
    style: "revolved",
    revolvedProfile: [
      { z: -1e9, radius: 10 },
      { z: 0, radius: 10 },
    ],
  });

  assert.ok(recipe);
  const zValues = recipe.revolvedProfile.map((point) => point.z);
  assert.equal(zValues[0], -10000);
  assert.equal(zValues[1], 0);
});

test("applyReferenceDimensions overwrites matching dimensions and records user provenance", () => {
  const analysis = {
    dimensions: {
      outerDiameter: 55,
      innerDiameter: 20,
      height: 15,
      width: null,
      length: null,
      thickness: null,
    },
    teeth: null,
    module: null,
    helixAngle: null,
  };

  const { analysis: next, dimensionSources } = applyReferenceDimensions(analysis, {
    outerDiameter: 62,
    height: 18,
    teeth: 24,
  });

  assert.equal(next.dimensions.outerDiameter, 62);
  assert.equal(next.dimensions.height, 18);
  assert.equal(next.teeth, 24);
  assert.equal(next.dimensions.innerDiameter, 20);
  assert.equal(dimensionSources.outerDiameter, "user");
  assert.equal(dimensionSources.height, "user");
  assert.equal(dimensionSources.teeth, "user");
  assert.equal(next.anchorDimension, "outerDiameter");
});

test("applyReferenceDimensions leaves nulls untouched when no reference is given", () => {
  const analysis = { dimensions: { outerDiameter: null }, teeth: null };
  const { analysis: next, dimensionSources } = applyReferenceDimensions(analysis, {});

  assert.equal(next.dimensions.outerDiameter, null);
  assert.deepEqual(dimensionSources, {});
  assert.equal(next.anchorDimension, null);
});
