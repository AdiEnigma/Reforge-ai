import test from "node:test";
import assert from "node:assert/strict";
import {
  GEAR_TYPES,
  gearTypeFromText,
  inferGearType,
  normalizeGearType,
} from "./src/gear-types.js";

const TEXT_FIXTURES = [
  ["spur", "24 straight-cut teeth on a cylindrical disc"],
  ["helical", "angled teeth with a 25 degree helix"],
  ["bevel", "conical pitch cone with miter teeth"],
  ["worm", "continuous screw flight worm drive shaft"],
  ["rack", "linear toothed rail gear"],
  ["internal", "internal ring gear with teeth inside the annulus"],
  ["compound", "two-stage cluster gear"],
  ["pinion", "integral pinion on a gear shaft"],
  ["stepped", "stepped gear with two diameters"],
  ["flanged", "flanged gear with mounting bolt holes"],
];

test("gear type aliases normalise to the canonical contract", () => {
  assert.equal(normalizeGearType("Helical Pinion Shaft"), "helical");
  assert.equal(normalizeGearType("miter gear"), "bevel");
  assert.equal(normalizeGearType("internal ring gear"), "internal");
  assert.equal(normalizeGearType("cluster gear"), "compound");
  assert.equal(normalizeGearType("unspecified"), "unknown");
  assert.equal(normalizeGearType(undefined), "unknown");
  for (const gearType of GEAR_TYPES) {
    assert.equal(normalizeGearType(gearType), gearType);
  }
});

test("text classification distinguishes every confirmed tooth form", () => {
  for (const [expected, text] of TEXT_FIXTURES) {
    assert.equal(gearTypeFromText(text), expected, text);
  }
});

test("a tooth count alone never implies spur", () => {
  const inferred = inferGearType({
    reference: { teeth: 24 },
    observations: { symmetryHints: ["teeth: 24"] },
  });
  assert.equal(inferred.gearType, "unknown");
  assert.equal(inferred.source, "insufficient_evidence");
});

test("explicit unknown is authoritative and cannot be upgraded by other evidence", () => {
  const inferred = inferGearType({
    reference: { gearType: "unknown", teeth: 24, helixAngle: 25 },
    observations: { symmetryHints: ["helical teeth"], aspectRatios: [4.2] },
    text: "bevel gear with conical teeth",
  });
  assert.equal(inferred.gearType, "unknown");
  assert.equal(inferred.source, "explicit_unknown");
});

test("aspect ratio evidence classifies a pinion without claiming a spur tooth form", () => {
  const inferred = inferGearType({ observations: { aspectRatios: [3.5] } });
  assert.equal(inferred.gearType, "pinion");
  assert.equal(inferred.source, "aspect_ratio");
});
