/**
 * engineering-analysis.test.js
 * Tests for deterministic engineering simulation and sensitivity analysis.
 * Run with: node backend/engineering-analysis.test.js
 */

import assert from "node:assert/strict";
import { simulateEngineeringChange, analyzeDimensionSensitivity } from "./engineering-analysis.js";

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

console.log("\n─── engineering-analysis.test.js ──────────────────");

// ---------------------------------------------------------------------------
// 1. Dimension Change Simulation
// ---------------------------------------------------------------------------
console.log("\n[ 1. Dimension Change Simulation ]");

test("Simulate increasing bore: reduces volume and mass", () => {
  const analysis = {
    componentType: "shaft",
    dimensions: { outerDiameter: 50, innerDiameter: 12, height: 120 },
    materialEstimate: "mild steel",
  };

  const result = simulateEngineeringChange({
    analysis,
    modifications: [{ type: "change_dimension", target: "innerDiameter", value: 20 }],
    quantity: 10,
  });

  assert.ok(!result.error, "Should not return error");
  assert.ok(result.original.volumeCm3 > result.modified.volumeCm3, "Larger bore must reduce volume");
  assert.ok(result.original.massKg > result.modified.massKg, "Larger bore must reduce mass");
  assert.ok(result.changes.massPercent < 0, "Mass delta percentage should be negative");
  assert.strictEqual(result.modifications[0].target, "innerDiameter");
});

// ---------------------------------------------------------------------------
// 2. Quantity Change Simulation
// ---------------------------------------------------------------------------
console.log("\n[ 2. Quantity Change Simulation ]");

test("Simulate batch quantity increase: reduces per-unit cost", () => {
  const analysis = {
    componentType: "flange",
    dimensions: { outerDiameter: 80, innerDiameter: 25, thickness: 15 },
    materialEstimate: "mild steel",
  };

  const result = simulateEngineeringChange({
    analysis,
    modifications: [{ type: "change_quantity", value: 100 }],
    quantity: 5,
  });

  assert.ok(!result.error);
  assert.strictEqual(result.original.quantity, 5);
  assert.strictEqual(result.modified.quantity, 100);
  const origMid = (result.original.cost.low + result.original.cost.high) / 2;
  const modMid = (result.modified.cost.low + result.modified.cost.high) / 2;
  assert.ok(modMid < origMid, "Higher quantity must decrease per-unit cost");
});

// ---------------------------------------------------------------------------
// 3. Dimension Sensitivity Analysis
// ---------------------------------------------------------------------------
console.log("\n[ 3. Dimension Sensitivity Analysis ]");

test("Outer diameter has higher sensitivity than length for cylinder", () => {
  const analysis = {
    componentType: "cylinder",
    dimensions: { outerDiameter: 60, height: 80 },
  };

  const sensitivity = analyzeDimensionSensitivity({ analysis });
  assert.ok(Array.isArray(sensitivity));
  assert.ok(sensitivity.length >= 2);

  const odSens = sensitivity.find((s) => s.dimension === "outerDiameter");
  const hSens = sensitivity.find((s) => s.dimension === "height");
  assert.ok(odSens, "Outer diameter sensitivity must exist");
  assert.ok(hSens, "Height sensitivity must exist");
  assert.ok(odSens.volumeSensitivityPercent > hSens.volumeSensitivityPercent, "OD sensitivity should exceed height sensitivity");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n─── Results: ${passed} passed, ${failed} failed ─────────────────`);
if (failed > 0) process.exit(1);
