import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildModel } from "./reconstruct.js";
import { visibleBounds } from "./geo.js";
import { executeRecipe } from "./recipe.js";

function build(analysis) {
  const model = buildModel(analysis);
  assert.ok(model && model.group, "buildModel must return a group");
  model.group.updateMatrixWorld(true);
  const box = visibleBounds(model.group);
  return { model, box };
}

function axisOfSmallestExtent(box) {
  const size = box.getSize(new THREE.Vector3());
  if (size.x <= size.y && size.x <= size.z) return "x";
  if (size.y <= size.z) return "y";
  return "z";
}

function hitsAlongAxis(group, axis, offset) {
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const direction = axis === "x"
    ? new THREE.Vector3(1, 0, 0)
    : axis === "y"
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);

  const origin = center.clone();
  if (axis === "x") origin.y += offset;
  else if (axis === "y") origin.x += offset;
  else origin.x += offset;
  origin.addScaledVector(direction, -(Math.max(size.x, size.y, size.z) + 2));

  const raycaster = new THREE.Raycaster(origin, direction, 0, Infinity);
  return raycaster
    .intersectObject(group, true)
    .filter((hit) => hit.object.visible !== false && !hit.object.userData?.isHighlightOnly).length;
}

const spurGearAnalysis = {
  componentType: "spur gear",
  teeth: 24,
  dimensions: { outerDiameter: 100, innerDiameter: 30, height: 20, thickness: 20 },
  geometryRecipe: {
    style: "gear",
    gear: {
      gearType: "spur",
      teeth: 24,
      module: 4,
      pressureAngle: 20,
      faceWidth: 20,
      boreRadius: 15,
    },
  },
};

test("spur gear bore is actually hollow through both hub faces", () => {
  const { model, box } = build(spurGearAnalysis);
  const axis = axisOfSmallestExtent(box);
  const radius = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2;

  assert.equal(hitsAlongAxis(model.group, axis, radius * 0.08), 0, "rays on the axis must pass through the bore");
  assert.ok(hitsAlongAxis(model.group, axis, radius * 0.45) > 0, "the gear web must be solid outside the bore");
});

test("bevel gear bore is actually hollow", () => {
  const { model, box } = build({
    componentType: "bevel gear",
    gearType: "bevel",
    coneAngle: 45,
    teeth: 20,
    dimensions: { outerDiameter: 90, innerDiameter: 22, height: 25, thickness: 25 },
    geometryRecipe: {
      style: "gear",
      gear: {
        gearType: "bevel",
        teeth: 20,
        module: 4,
        coneAngle: 45,
        faceWidth: 25,
        boreRadius: 11,
        hubDiameter: 54,
        hubLength: 21,
      },
    },
  });
  const axis = axisOfSmallestExtent(box);
  const radius = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2;

  assert.equal(hitsAlongAxis(model.group, axis, radius * 0.08), 0, "bevel bore must not be plugged");
  assert.ok(hitsAlongAxis(model.group, axis, radius * 0.45) > 0, "the cone body must be solid");
});

test("stepped shaft uses the revolved profile instead of the parametric template", () => {
  const { model, box } = build({
    componentType: "stepped shaft",
    dimensions: { outerDiameter: 60, innerDiameter: 0, length: 120 },
    geometryRecipe: {
      style: "revolved",
      revolvedProfile: [
        { z: -60, radius: 0 },
        { z: -60, radius: 15 },
        { z: 60, radius: 15 },
        { z: 60, radius: 0 },
      ],
    },
  });
  const size = box.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 1.5) < 0.12, `profile diameter must be 30mm-scaled, got ${size.x}`);
  assert.ok(Math.abs(size.z - 1.5) < 0.12, `profile diameter must be 30mm-scaled, got ${size.z}`);
  assert.ok(size.y > 5.5, "shaft length must come from the profile");
  assert.equal(model.group.children[0].userData.recipeStyle, "revolved");
});

test("a bracket recipe stays extruded even when its features mention mounting holes", () => {
  const { model } = build({
    componentType: "mounting bracket",
    features: ["4 mounting holes", "counterbored"],
    dimensions: { outerDiameter: 120, innerDiameter: 0, height: 10, width: 80, length: 120, thickness: 10 },
    geometryRecipe: {
      style: "extruded",
      depth: 10,
      outline: [
        { x: -40, y: -20 },
        { x: 40, y: -20 },
        { x: 40, y: 20 },
        { x: -40, y: 20 },
      ],
      holes: [
        { cx: 0, cy: 0, radius: 8 },
        { cx: -30, cy: 0, radius: 4 },
        { cx: 30, cy: 0, radius: 4 },
      ],
    },
  });
  assert.equal(model.group.children[0].userData.recipeStyle, "extruded");
});

test("unusable recipes do not produce empty groups or NaN transforms", () => {
  assert.equal(executeRecipe({ style: "gear" }), null);
  assert.equal(executeRecipe({ style: "combination", primitives: [] }), null);

  const model = buildModel({ componentType: "other" });
  assert.ok(model && model.group);
  assert.ok(Number.isFinite(model.group.position.x));
  assert.ok(Number.isFinite(model.group.position.y));
  assert.ok(Number.isFinite(model.group.position.z));
});

test("flange keeps its ring plate, central bore and bolt holes", () => {
  const { model, box } = build({
    componentType: "flange",
    boltCount: 8,
    dimensions: { outerDiameter: 160, innerDiameter: 50, height: 30, thickness: 18, width: 160, length: 160 },
    geometryRecipe: {
      style: "flange",
      flange: {
        outerDiameter: 160,
        innerDiameter: 50,
        thickness: 18,
        height: 30,
        boltCount: 8,
        boltCircleDiameter: 121.6,
        boltHoleDiameter: 17.6,
        bossDiameter: 96,
        bossHeight: 12,
      },
      holes: [{ cx: 0, cy: 0, radius: 25 }],
      depth: 18,
    },
  });

  assert.equal(model.group.children[0].userData.recipeStyle, "flange");
  const axis = axisOfSmallestExtent(box);
  const radius = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2;

  assert.equal(hitsAlongAxis(model.group, axis, radius * 0.08), 0, "central bore must stay open");
  assert.ok(hitsAlongAxis(model.group, axis, radius * 0.45) > 0, "flange plate must be solid");
  // Bolt circle Ø121.6 on a Ø160 flange, normalised to the 6-unit viewport: radius 2.28.
  assert.equal(hitsAlongAxis(model.group, axis, 2.28), 0, "bolt holes must stay open");
});
