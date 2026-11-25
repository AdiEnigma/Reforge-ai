import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeRecipe } from "./gemini.js";

const analysis = {
  componentType: "ball bearing",
  ballCount: 9,
  dimensions: { outerDiameter: 80, innerDiameter: 30, thickness: 18 },
};

test("bearing recipes preserve image-derived races, bore and rolling-ball count", () => {
  const recipe = sanitizeRecipe({
    style: "bearing",
    bearing: {
      outerDiameter: 80,
      innerDiameter: 30,
      width: 18,
      outerRaceInnerDiameter: 63,
      innerRaceOuterDiameter: 47,
      pitchDiameter: 55,
      ballDiameter: 10,
      ballCount: 9,
      grooveDepth: 3,
      grooveRadius: 2.5,
      rows: 1,
      shieldType: "shielded",
    },
  }, analysis);

  assert.ok(recipe);
  assert.equal(recipe.style, "bearing");
  assert.equal(recipe.bearing.ballCount, 9);
  assert.equal(recipe.bearing.innerDiameter, 30);
  assert.equal(recipe.bearing.outerRaceInnerDiameter, 63);
  assert.equal(recipe.bearing.innerRaceOuterDiameter, 47);
  assert.equal(recipe.bearing.shieldType, "shielded");
});

test("bearing recipes derive missing ball and race values from measured diameters", () => {
  const recipe = sanitizeRecipe({
    style: "bearing",
    bearing: { outerDiameter: 80, innerDiameter: 30, width: 18 },
  }, { ...analysis, ballCount: null });

  assert.ok(recipe);
  assert.equal(recipe.style, "bearing");
  assert.ok(recipe.bearing.ballCount >= 6 && recipe.bearing.ballCount <= 120);
  assert.ok(recipe.bearing.pitchDiameter > recipe.bearing.innerDiameter);
  assert.ok(recipe.bearing.outerRaceInnerDiameter < recipe.bearing.outerDiameter);
  assert.ok(recipe.bearing.innerRaceOuterDiameter > recipe.bearing.innerDiameter);
});

test("bearing style is inferred from a bearing object even without an explicit style", () => {
  const recipe = sanitizeRecipe({
    bearing: { outerDiameter: 80, innerDiameter: 30, width: 18, ballCount: 9 },
  }, analysis);

  assert.ok(recipe);
  assert.equal(recipe.style, "bearing");
  assert.equal(recipe.bearing.ballCount, 9);
});
