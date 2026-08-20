/**
 * engineering-context.test.js
 * Unit tests for buildEngineeringContext and getEngineeringSuggestions.
 * Run with: node frontend/src/lib/engineering-context.test.js
 */

import assert from "node:assert/strict";
import { buildEngineeringContext, getEngineeringSuggestions } from "./engineering-context.js";

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

console.log("\n─── engineering-context.test.js ───────────────────");

// ---------------------------------------------------------------------------
// 1. Full Context Builder
// ---------------------------------------------------------------------------
console.log("\n[ 1. Full Context Builder ]");

test("Full context: builds normalized structure with all required fields", () => {
  const analysis = {
    componentType: "shaft",
    confidence: 0.88,
    dimensions: { outerDiameter: 50, innerDiameter: 12, height: 120 },
    materialEstimate: "hardened steel",
    geometryRecipe: {
      style: "revolved",
      revolvedProfile: [
        { z: 0, radius: 25 },
        { z: 60, radius: 25 },
        { z: 60, radius: 15 },
        { z: 120, radius: 15 },
      ],
    },
    uncertainties: ["Bore depth estimated from visible face"],
  };

  const manufacturingIntelligence = {
    quantity: 10,
    massKg: 1.42,
    volumeCm3: 180.5,
    material: { key: "hardened_steel", label: "Hardened Steel", densityGCm3: 7.85, costPerKgINR: 95, materialSource: "ai-estimated" },
    process: { recommended: { key: "cnc_turning", label: "CNC Turning" }, reasoning: "Revolved geometry favors turning." },
    cost: { low: 450, high: 620, breakdown: { materialCostINR: 135, machiningCostINR: 300, overheadINR: 87 } },
    leadTime: { lowDays: 2, highDays: 4 },
  };

  const features = [
    { id: "feature-bore-1", type: "bore", label: "Central Bore", confidence: 0.95 },
    { id: "feature-shoulder-1", type: "shoulder", label: "Shoulder", confidence: 0.85 },
  ];

  const materialAlternatives = {
    alternatives: [
      { key: "aluminium", label: "Aluminium", massKg: 0.49, materialCostINR: 120, weightChangePercent: -65, materialCostChangePercent: -11 },
    ],
  };

  const ctx = buildEngineeringContext({
    analysis,
    manufacturingIntelligence,
    quantity: 10,
    features,
    materialAlternatives,
  });

  assert.strictEqual(ctx.component.type, "shaft");
  assert.strictEqual(ctx.dimensions.outerDiameter, 50);
  assert.strictEqual(ctx.dimensions.innerDiameter, 12);
  assert.strictEqual(ctx.material.label, "Hardened Steel");
  assert.strictEqual(ctx.geometry.style, "revolved");
  assert.strictEqual(ctx.features.length, 2);
  assert.strictEqual(ctx.manufacturing.recommendedProcess, "CNC Turning");
  assert.strictEqual(ctx.materialAlternatives.length, 1);
  assert.strictEqual(ctx.confidence.overall, 0.88);
});

// ---------------------------------------------------------------------------
// 2. Missing/Fallback Context
// ---------------------------------------------------------------------------
console.log("\n[ 2. Fallback & Missing Context ]");

test("Null analysis returns null without throwing", () => {
  const ctx = buildEngineeringContext({ analysis: null });
  assert.strictEqual(ctx, null);
});

test("Missing manufacturing intelligence still builds valid context", () => {
  const ctx = buildEngineeringContext({
    analysis: { componentType: "bracket", dimensions: { width: 60, height: 40 } },
  });
  assert.ok(ctx);
  assert.strictEqual(ctx.component.type, "bracket");
  assert.strictEqual(ctx.material.isAssumed, true);
  assert.strictEqual(ctx.manufacturing, null);
});

// ---------------------------------------------------------------------------
// 3. Suggestions Generation
// ---------------------------------------------------------------------------
console.log("\n[ 3. Suggested Questions Generation ]");

test("Shaft with bore generates bore hypothetical and CNC question", () => {
  const ctx = {
    component: { type: "shaft" },
    dimensions: { outerDiameter: 50, innerDiameter: 12, height: 120 },
    material: { label: "Mild Steel" },
    geometry: { style: "revolved" },
    manufacturing: { recommendedProcess: "CNC Turning", quantity: 10 },
  };

  const suggestions = getEngineeringSuggestions(ctx);
  assert.ok(suggestions.some((s) => s.includes("CNC Turning")));
  assert.ok(suggestions.some((s) => s.includes("bore")));
  assert.ok(suggestions.some((s) => s.includes("aluminium")));
});

test("Fallback suggestions for null context", () => {
  const suggestions = getEngineeringSuggestions(null);
  assert.ok(Array.isArray(suggestions));
  assert.ok(suggestions.length >= 3);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n─── Results: ${passed} passed, ${failed} failed ─────────────────`);
if (failed > 0) process.exit(1);
