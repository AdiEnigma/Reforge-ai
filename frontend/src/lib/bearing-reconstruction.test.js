import test from "node:test";
import assert from "node:assert/strict";
import { buildModel, resolveComponentType } from "./reconstruct.js";

function countFeatures(group, featureType) {
  let count = 0;
  group.traverse((node) => {
    if (node.userData?.featureType === featureType) count += 1;
  });
  return count;
}

const bearingAnalysis = {
  componentType: "deep groove ball bearing",
  ballCount: 9,
  dimensions: { outerDiameter: 80, innerDiameter: 30, height: 18, thickness: 18 },
  geometryRecipe: {
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
      shieldType: "open",
    },
  },
};

test("bearing recipe renders both races, the bore, grooves and every visible ball", () => {
  assert.equal(resolveComponentType(bearingAnalysis), "bearing");

  const model = buildModel(bearingAnalysis);
  assert.equal(countFeatures(model.group, "ball_bearing"), 9);
  assert.equal(countFeatures(model.group, "groove"), 2);
  let races = 0;
  let bores = 0;
  model.group.traverse((node) => {
    if (node.userData?.bearingRole === "inner_race" || node.userData?.bearingRole === "outer_race") races += 1;
    if (node.userData?.featureType === "bore") bores += 1;
  });
  assert.equal(races, 2);
  assert.equal(bores, 1);
});

test("bearing fallback uses the image-derived ball count, not a hardcoded ten", () => {
  const analysis = {
    componentType: "ball bearing",
    ballCount: 12,
    dimensions: { outerDiameter: 80, innerDiameter: 30, thickness: 18 },
  };

  const model = buildModel(analysis);
  assert.equal(resolveComponentType(analysis), "bearing");
  assert.equal(countFeatures(model.group, "ball_bearing"), 12);
});

test("double-row shielded bearing renders both rows and face shields", () => {
  const analysis = {
    ...bearingAnalysis,
    ballCount: 16,
    geometryRecipe: {
      style: "bearing",
      bearing: {
        ...bearingAnalysis.geometryRecipe.bearing,
        ballCount: 16,
        rows: 2,
        shieldType: "sealed",
      },
    },
  };

  const model = buildModel(analysis);
  assert.equal(countFeatures(model.group, "ball_bearing"), 16);
  assert.equal(countFeatures(model.group, "shield"), 2);
  assert.equal(countFeatures(model.group, "groove"), 4);
});
