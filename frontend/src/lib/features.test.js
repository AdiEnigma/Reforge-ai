/**
 * features.test.js
 * Test suite for ReForge AI Feature Identification & Normalization.
 * Run with: node frontend/src/lib/features.test.js
 */
import assert from "node:assert/strict";
import {
  normalizeFeatures,
  matchFeatureType,
  extractCountFromString,
  detectShoulders,
} from "./features.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log("\n─── features.test.js ──────────────────────────────");

// ---------------------------------------------------------------------------
// 1. Synonym matching
// ---------------------------------------------------------------------------
console.log("\n[ 1. Synonym Matching ]");

test('Test 1: "central bore" -> bore', () => {
  assert.strictEqual(matchFeatureType("central bore"), "bore");
});

test('Test 2: "6 mounting holes" -> mounting_hole', () => {
  assert.strictEqual(matchFeatureType("6 mounting holes"), "mounting_hole");
});

test('Test 3: "centre hole" -> bore', () => {
  assert.strictEqual(matchFeatureType("centre hole"), "bore");
});

test('Test 4: "keyway" -> keyway', () => {
  assert.strictEqual(matchFeatureType("keyway"), "keyway");
});

test('Test 5: "stepped diameter" -> shoulder', () => {
  assert.strictEqual(matchFeatureType("stepped diameter"), "shoulder");
});

test('Test 6: "spur teeth" -> gear_teeth', () => {
  assert.strictEqual(matchFeatureType("spur teeth"), "gear_teeth");
});

test('Test 7: "chamfered edge" -> chamfer', () => {
  assert.strictEqual(matchFeatureType("chamfered edge"), "chamfer");
});

test('Test 8: "fillet transition" -> fillet', () => {
  assert.strictEqual(matchFeatureType("fillet transition"), "fillet");
});

test('Test 9: Unknown phrase "weird indentation" -> other', () => {
  assert.strictEqual(matchFeatureType("weird indentation"), "other");
});

// ---------------------------------------------------------------------------
// 2. Count extraction
// ---------------------------------------------------------------------------
console.log("\n[ 2. Count Extraction ]");

test('Count "6 mounting holes" -> 6', () => {
  assert.strictEqual(extractCountFromString("6 mounting holes"), 6);
});

test('Count "8 bolt holes" -> 8', () => {
  assert.strictEqual(extractCountFromString("8 bolt holes"), 8);
});

test('Count "central bore" -> null', () => {
  assert.strictEqual(extractCountFromString("central bore"), null);
});

// ---------------------------------------------------------------------------
// 3. Shoulder detection on revolved profile
// ---------------------------------------------------------------------------
console.log("\n[ 3. Shoulder Detection ]");

test("Detects steps in stepped shaft profile", () => {
  const profile = [
    { z: 0, radius: 10 },
    { z: 20, radius: 10 },
    { z: 20, radius: 25 }, // step of 15mm
    { z: 50, radius: 25 },
  ];
  const shoulders = detectShoulders(profile);
  assert.strictEqual(shoulders.length, 1);
  assert.strictEqual(shoulders[0].stepHeight, 15);
});

// ---------------------------------------------------------------------------
// 4. Feature Normalization & Deduplication
// ---------------------------------------------------------------------------
console.log("\n[ 4. Feature Normalization & Deduplication ]");

test("Test 4a: Deduplication: analysis 'central hole' + recipe central bore -> single 'Central Bore'", () => {
  const analysis = {
    componentType: "cylinder/shaft",
    dimensions: { innerDiameter: 12, outerDiameter: 50, height: 100 },
    features: ["central hole", "chamfered edges"],
    geometryRecipe: {
      style: "revolved",
      revolvedProfile: [
        { z: 0, radius: 25 },
        { z: 100, radius: 25 },
      ],
    },
  };

  const features = normalizeFeatures(analysis);
  const bores = features.filter((f) => f.type === "bore");
  assert.strictEqual(bores.length, 1, "Should only have 1 bore feature");
  assert.strictEqual(bores[0].source, "recipe");
  assert.strictEqual(bores[0].metadata.diameter, 12);
});

test("Test 4b: Gear component normalization", () => {
  const analysis = {
    componentType: "spur gear",
    teeth: 24,
    module: 2.5,
    dimensions: { innerDiameter: 15, outerDiameter: 65, height: 20 },
    features: ["gear teeth", "central bore", "keyway"],
    geometryRecipe: {
      style: "gear",
      gear: { teeth: 24, module: 2.5, boreRadius: 7.5 },
    },
  };

  const features = normalizeFeatures(analysis);
  const gearFeature = features.find((f) => f.type === "gear_teeth");
  const boreFeature = features.find((f) => f.type === "bore");
  const keywayFeature = features.find((f) => f.type === "keyway");

  assert.ok(gearFeature, "Should detect gear teeth");
  assert.strictEqual(gearFeature.metadata.teeth, 24);
  assert.strictEqual(gearFeature.metadata.module, 2.5);

  assert.ok(boreFeature, "Should detect central bore");
  assert.strictEqual(boreFeature.metadata.diameter, 15);

  assert.ok(keywayFeature, "Should detect keyway from analysis");
  assert.strictEqual(keywayFeature.source, "analysis");
});

test("Test 4c: Flange mounting holes grouping", () => {
  const analysis = {
    componentType: "flange",
    dimensions: { innerDiameter: 20, outerDiameter: 100, thickness: 15 },
    features: ["6 mounting holes", "central bore"],
    geometryRecipe: {
      style: "extruded",
      holes: [
        { cx: 0, cy: 0, radius: 10 },
        { cx: 35, cy: 0, radius: 4 },
        { cx: 17.5, cy: 30.3, radius: 4 },
        { cx: -17.5, cy: 30.3, radius: 4 },
        { cx: -35, cy: 0, radius: 4 },
        { cx: -17.5, cy: -30.3, radius: 4 },
        { cx: 17.5, cy: -30.3, radius: 4 },
      ],
      depth: 15,
    },
  };

  const features = normalizeFeatures(analysis);
  const mHoles = features.find((f) => f.type === "mounting_hole");
  assert.ok(mHoles, "Should detect mounting holes");
  assert.strictEqual(mHoles.metadata.count, 6, "Should count 6 perimeter holes");
  assert.strictEqual(mHoles.metadata.diameter, 8);
});

test("Test 4d: Priority sorting: Bore -> Mounting Holes -> Keyway -> Gear Teeth -> Shoulder", () => {
  const analysis = {
    features: ["keyway", "shoulder", "central bore", "6 mounting holes", "gear teeth"],
  };
  const features = normalizeFeatures(analysis);
  const types = features.map((f) => f.type);
  assert.deepStrictEqual(types, ["bore", "mounting_hole", "keyway", "gear_teeth", "shoulder"]);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n─── Results: ${passed} passed, ${failed} failed ─────────────────`);
if (failed > 0) process.exit(1);
