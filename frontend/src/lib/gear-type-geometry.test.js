import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildModel, resolveComponentType } from "./reconstruct.js";

function makeAnalysis(gearType, gear, { componentType = `${gearType} gear`, dimensions } = {}) {
  return {
    componentType,
    gearType,
    teeth: gear.teeth,
    module: gear.module,
    helixAngle: gear.helixAngle,
    coneAngle: gear.coneAngle,
    pitch: gear.pitch,
    starts: gear.starts,
    dimensions: dimensions || {
      outerDiameter: gear.outerDiameter || 80,
      innerDiameter: (gear.boreRadius || 0) * 2,
      height: gear.faceWidth || 18,
      thickness: gear.faceWidth || 18,
      width: gear.rackLength || gear.outerDiameter || 80,
      length: gear.rackLength || gear.outerDiameter || 80,
    },
    geometryRecipe: { style: "gear", gear },
  };
}

function meshes(model) {
  const found = [];
  model.group.traverse((object) => {
    if (object.isMesh && object.userData?.featureType) found.push(object);
  });
  return found;
}

function featureTypes(model) {
  return meshes(model).map((mesh) => mesh.userData.featureType);
}

const GEAR_CASES = [
  ["spur", { teeth: 18, module: 4, faceWidth: 18, outerDiameter: 80, boreRadius: 8 }, "spur gear", "gear_teeth"],
  ["helical", { teeth: 19, module: 4, faceWidth: 19, outerDiameter: 84, boreRadius: 9, helixAngle: 25 }, "helical gear", "helical_gear_teeth"],
  ["bevel", { teeth: 20, module: 4, faceWidth: 20, outerDiameter: 88, boreRadius: 10, coneAngle: 45 }, "bevel gear", "gear_teeth"],
  ["worm", { module: 4, faceWidth: 30, outerDiameter: 52, pitch: 9, starts: 2, rootRadius: 17 }, "worm gear", "worm_flight"],
  ["rack", { teeth: 22, module: 4, faceWidth: 14, rackLength: 210 }, "rack gear", "rack_teeth"],
  ["internal", { teeth: 26, module: 4, faceWidth: 16, outerDiameter: 104, innerRing: true }, "internal gear", "internal_gear_teeth"],
  ["compound", { teeth: 20, module: 4, faceWidth: 24, outerDiameter: 80, boreRadius: 8, stages: [{ teeth: 20, module: 4, faceWidth: 12, outerDiameter: 88 }, { teeth: 12, module: 4, faceWidth: 12, outerDiameter: 56 }] }, "compound gear", "gear_teeth"],
  ["pinion", { teeth: 14, module: 4, faceWidth: 18, outerDiameter: 64, boreRadius: 7 }, "pinion shaft", "gear_teeth"],
  ["stepped", { teeth: 21, module: 4, faceWidth: 24, outerDiameter: 84, boreRadius: 8, stages: [{ teeth: 21, module: 4, faceWidth: 12, outerDiameter: 92 }, { teeth: 14, module: 4, faceWidth: 12, outerDiameter: 64 }] }, "stepped gear", "gear_teeth"],
  ["flanged", { teeth: 18, module: 4, faceWidth: 18, outerDiameter: 80, boreRadius: 8 }, "flanged gear", "gear_teeth"],
];

test("every confirmed gear type routes to geometry with its own signature", () => {
  for (const [gearType, gear, expectedType, expectedFeature] of GEAR_CASES) {
    const analysis = makeAnalysis(gearType, gear);
    assert.equal(resolveComponentType(analysis), expectedType, `${gearType} classification`);

    const model = buildModel(analysis);
    const types = featureTypes(model);
    assert.ok(types.includes(expectedFeature), `${gearType} missing ${expectedFeature}: ${types.join(",")}`);
    assert.ok(!types.includes("unconfirmed_gear_type"), `${gearType} rendered as unconfirmed`);
    if (gearType !== "worm" && gearType !== "rack" && gearType !== "internal") {
      assert.ok(types.some((type) => /gear_teeth|worm_flight/.test(type)), `${gearType} has no tooth geometry`);
    }
  }
});

test("helical geometry has twisted tooth slices with the confirmed helix angle", () => {
  const analysis = makeAnalysis("helical", { teeth: 19, module: 4, faceWidth: 19, outerDiameter: 84, boreRadius: 9, helixAngle: 25 });
  const helicalMeshes = meshes(buildModel(analysis)).filter(
    (mesh) => mesh.userData.featureType === "helical_gear_teeth"
  );
  assert.equal(helicalMeshes.length, 10);
  assert.ok(helicalMeshes.every((mesh) => mesh.userData.helixAngle === 25));
});

test("worm geometry uses the confirmed pitch and start count", () => {
  const analysis = makeAnalysis("worm", { module: 4, faceWidth: 30, outerDiameter: 52, pitch: 9, starts: 2, rootRadius: 17 });
  const flight = meshes(buildModel(analysis)).find(
    (mesh) => mesh.userData.featureType === "worm_flight"
  );
  assert.ok(flight);
  assert.equal(flight.userData.pitch, 9);
  assert.equal(flight.userData.starts, 2);
  assert.equal(flight.userData.hand, "right");
});

test("rack geometry is linear and internal geometry is annular", () => {
  const rack = makeAnalysis("rack", { teeth: 22, module: 4, faceWidth: 14, rackLength: 210 });
  const rackBox = new THREE.Box3().setFromObject(buildModel(rack).group);
  const rackSize = rackBox.getSize(new THREE.Vector3());
  assert.ok(rackSize.x > rackSize.y * 2, `rack should be linear, got ${rackSize.toArray()}`);

  const internal = makeAnalysis("internal", { teeth: 26, module: 4, faceWidth: 16, outerDiameter: 104, innerRing: true });
  const types = featureTypes(buildModel(internal));
  assert.ok(types.includes("internal_gear_teeth"));
  assert.ok(!types.includes("rack_teeth"));
});

test("compound and stepped gear geometry preserves both explicit stages", () => {
  for (const gearType of ["compound", "stepped"]) {
    const analysis = makeAnalysis(gearType, {
      teeth: 20,
      module: 4,
      faceWidth: 24,
      outerDiameter: 80,
      boreRadius: 8,
      stages: [
        { teeth: 20, module: 4, faceWidth: 12, outerDiameter: 88 },
        { teeth: 12, module: 4, faceWidth: 12, outerDiameter: 56 },
      ],
    });
    const ids = meshes(buildModel(analysis)).map((mesh) => mesh.userData.featureId);
    assert.ok(ids.includes("feature-gear-stage-1"), `${gearType} first stage`);
    assert.ok(ids.includes("feature-gear-stage-2"), `${gearType} second stage`);
  }
});

test("flanged gear geometry includes both teeth and the flange face", () => {
  const analysis = makeAnalysis("flanged", { teeth: 18, module: 4, faceWidth: 18, outerDiameter: 80, boreRadius: 8 });
  const types = featureTypes(buildModel(analysis));
  assert.ok(types.includes("gear_teeth"));
  assert.ok(types.includes("flange"));
});

test("explicit unknown renders a neutral placeholder, never spur teeth", () => {
  const analysis = makeAnalysis(
    "unknown",
    { gearType: "unknown", teeth: 18, module: 4, faceWidth: 18, outerDiameter: 80, boreRadius: 8 },
    { componentType: "gear (type unconfirmed)" }
  );
  assert.equal(resolveComponentType(analysis), "gear (type unconfirmed)");
  const types = featureTypes(buildModel(analysis));
  assert.equal(types.length, 1);
  assert.equal(types[0], "unconfirmed_gear_type");
  assert.ok(!types.includes("gear_teeth"));
});
