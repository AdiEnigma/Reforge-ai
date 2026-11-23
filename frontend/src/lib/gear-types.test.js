import test from "node:test";
import assert from "node:assert/strict";
import {
  GEAR_TYPES,
  applyConfirmedGearType,
  gearTypeConfirmationMessage,
  normalizeGearType,
} from "./gear-types.js";

test("canonical gear types include unknown and all confirmed tooth forms", () => {
  assert.deepEqual(GEAR_TYPES, [
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
    "unknown",
  ]);
  assert.equal(normalizeGearType("helical pinion shaft"), "helical");
  assert.equal(normalizeGearType("miter"), "bevel");
  assert.equal(normalizeGearType("unspecified"), "unknown");
  assert.match(gearTypeConfirmationMessage("unknown"), /Confirm spur, helical, bevel/);
  assert.equal(gearTypeConfirmationMessage("spur"), null);
});

test("applyConfirmedGearType updates the single active analysis and invalidates health", () => {
  const original = {
    componentType: "gear (type unconfirmed)",
    gearType: "unknown",
    requiresGearTypeConfirmation: true,
    uncertainties: ["Gear type could not be identified from the available image evidence."],
    conditionAssessment: { status: "NORMAL", assessedGearType: "spur" },
    dimensions: { outerDiameter: 100, innerDiameter: 28, thickness: 24 },
    geometryRecipe: { style: "revolved", revolvedProfile: [] },
  };

  const confirmed = applyConfirmedGearType(original, "helical");

  assert.equal(confirmed.gearType, "helical");
  assert.equal(confirmed.componentType, "helical gear");
  assert.equal(confirmed.classificationSource, "user_confirmed");
  assert.equal(confirmed.requiresGearTypeConfirmation, false);
  assert.equal(confirmed.helixAngle, 20);
  assert.equal(confirmed.geometryRecipe.gear.gearType, "helical");
  assert.equal(confirmed.geometryRecipe.gear.helixAngle, 20);
  assert.equal(confirmed.conditionAssessment, undefined);
  assert.deepEqual(confirmed.uncertainties, []);
  assert.equal(original.conditionAssessment.status, "NORMAL", "original analysis is not mutated");
});

test("applyConfirmedGearType adds type-specific parameters for worm and rack", () => {
  const base = {
    dimensions: { outerDiameter: 100, thickness: 20 },
    geometryRecipe: { style: "gear", gear: { teeth: 20 } },
  };
  const worm = applyConfirmedGearType(base, "worm");
  assert.equal(worm.pitch, 12);
  assert.equal(worm.starts, 1);
  assert.equal(worm.lead, 12);
  assert.equal(worm.geometryRecipe.gear.pitch, 12);
  assert.ok(worm.geometryRecipe.gear.rootRadius > 0);

  const rack = applyConfirmedGearType(base, "rack");
  assert.equal(rack.geometryRecipe.gear.teeth, 20);
  assert.ok(rack.geometryRecipe.gear.rackLength > 0);
  assert.equal(rack.geometryRecipe.gear.gearType, "rack");
});

test("explicit unknown does not overwrite an analysis", () => {
  const analysis = { gearType: "unknown", requiresGearTypeConfirmation: true };
  assert.equal(applyConfirmedGearType(analysis, "unknown"), analysis);
});
