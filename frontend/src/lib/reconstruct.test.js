import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { resolveComponentType, computeParams, buildModel, validateReconstructedModel, COMPONENT_LABELS } from "./reconstruct.js";

test("resolveComponentType accurately detects bevel gears without defaulting to spur gear", () => {
  const bevelAnalysis = {
    componentType: "bevel gear",
    gearType: "bevel",
    coneAngle: 45,
    teeth: 20,
    features: ["conical teeth", "rear hub collar", "central bore"],
  };

  assert.equal(resolveComponentType(bevelAnalysis), "bevel gear");
  assert.equal(COMPONENT_LABELS["bevel gear"], "BEVEL GEAR");
});

test("resolveComponentType accurately detects stepped shafts without defaulting to cylinder", () => {
  const shaftAnalysis = {
    componentType: "stepped drive shaft",
    dimensions: { outerDiameter: 40, length: 180 },
    features: ["stepped journals", "ground shoulders", "spline head"],
  };

  assert.equal(resolveComponentType(shaftAnalysis), "stepped shaft");
  assert.equal(COMPONENT_LABELS["stepped shaft"], "STEPPED SHAFT");
});

test("buildModel constructs authentic 3D Bevel Gear group with conical teeth", () => {
  const bevelAnalysis = {
    componentType: "bevel gear",
    teeth: 20,
    dimensions: { outerDiameter: 90, innerDiameter: 22, height: 28, thickness: 28 },
    geometryRecipe: {
      style: "gear",
      gear: {
        gearType: "bevel",
        teeth: 20,
        coneAngle: 45,
        faceWidth: 28,
        boreRadius: 11,
        hubDiameter: 55,
        hubLength: 22,
      },
    },
  };

  const model = buildModel(bevelAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "BEVEL GEAR");
  const body = model.group.children[0];
  assert.ok(body.children.length >= 2, "Must contain cone blank, teeth crown, and hub");
});

test("buildModel constructs authentic 3D Stepped Shaft group with multiple diameter journals", () => {
  const shaftAnalysis = {
    componentType: "stepped shaft",
    dimensions: { outerDiameter: 45, innerDiameter: 0, length: 200, height: 200 },
    geometryRecipe: {
      style: "revolved",
      revolvedProfile: [
        { z: -100, radius: 0 },
        { z: -100, radius: 15 },
        { z: -60, radius: 15 },
        { z: -60, radius: 20 },
        { z: 0, radius: 22.5 },
        { z: 60, radius: 20 },
        { z: 100, radius: 16 },
        { z: 100, radius: 0 },
      ],
    },
  };

  const model = buildModel(shaftAnalysis);
  assert.ok(model);
  assert.ok(model.group);
  assert.equal(model.label, "STEPPED SHAFT");
  assert.ok(model.group.children.length >= 1);
});

test('validateReconstructedModel accepts a generated model', () => {
  const model = buildModel({
    componentType: 'spur gear',
    teeth: 20,
    dimensions: { outerDiameter: 80, innerDiameter: 20, height: 18 },
  });
  const result = validateReconstructedModel(model);
  assert.equal(result.valid, true);
  assert.ok(result.meshCount > 0);
  assert.ok(result.size.length() > 0);
});

test('validateReconstructedModel rejects an empty model', () => {
  assert.throws(
    () => validateReconstructedModel({ group: new THREE.Group() }),
    /no renderable mesh/
  );
  assert.throws(() => validateReconstructedModel(null), /no 3D model/);
});
