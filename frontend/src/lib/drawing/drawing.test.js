/**
 * drawing.test.js
 * Test suite for ReForge AI Automatic Engineering Drawing Generator.
 * Run with: node frontend/src/lib/drawing/drawing.test.js
 */

import assert from "node:assert/strict";
import { buildDrawingModel, extractBaseDimensions } from "./projections.js";
import { generateDimensions } from "./dimensions.js";
import { renderDrawingToSvg } from "./renderer.js";

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

console.log("\n─── drawing.test.js ───────────────────────────────");

// ---------------------------------------------------------------------------
// 1. Shaft Projections
// ---------------------------------------------------------------------------
console.log("\n[ 1. Shaft Drawing Projections ]");

test("Shaft: Front, Top, and Side views are generated with dimensions", () => {
  const analysis = {
    componentType: "cylinder/shaft",
    dimensions: { outerDiameter: 50, innerDiameter: 20, height: 120 },
    geometryRecipe: {
      style: "revolved",
      revolvedProfile: [
        { z: 0, radius: 25 },
        { z: 60, radius: 25 },
        { z: 60, radius: 20 },
        { z: 120, radius: 20 },
      ],
    },
  };

  const model = buildDrawingModel({ analysis });
  assert.ok(model.views.front, "Front view should exist");
  assert.ok(model.views.top, "Top view should exist");
  assert.ok(model.views.side, "Side view should exist");
  assert.strictEqual(model.units, "mm");
  assert.strictEqual(model.partName, "CYLINDER/SHAFT");

  const svg = renderDrawingToSvg(model);
  assert.ok(svg.includes("<svg"), "SVG output should contain <svg>");
  assert.ok(svg.includes("FRONT VIEW"), "SVG should have FRONT VIEW label");
  assert.ok(svg.includes("TOP VIEW"), "SVG should have TOP VIEW label");
  assert.ok(svg.includes("RIGHT SIDE VIEW"), "SVG should have RIGHT SIDE VIEW label");
});

// ---------------------------------------------------------------------------
// 2. Flange Projections
// ---------------------------------------------------------------------------
console.log("\n[ 2. Flange Drawing Projections ]");

test("Flange: generates bolt holes, bore, and outer circle in Top view", () => {
  const analysis = {
    componentType: "flange",
    dimensions: { outerDiameter: 100, innerDiameter: 30, thickness: 15 },
    geometryRecipe: {
      style: "extruded",
      holes: [
        { cx: 0, cy: 0, radius: 15 },
        { cx: 35, cy: 0, radius: 4 },
        { cx: -35, cy: 0, radius: 4 },
      ],
      depth: 15,
    },
  };

  const model = buildDrawingModel({
    analysis,
    manufacturingIntelligence: {
      material: { label: "Mild Steel", materialSource: "ai-estimated" },
      process: { recommended: { label: "CNC Turning" } },
    },
  });

  assert.strictEqual(model.material.name, "Mild Steel");
  assert.strictEqual(model.manufacturingProcess, "CNC Turning");

  const svg = renderDrawingToSvg(model);
  assert.ok(svg.includes("NOTES:"), "SVG should include NOTES block");
  assert.ok(svg.includes("RF-001"), "SVG should include default drawing ID");
});

// ---------------------------------------------------------------------------
// 3. Gear Projections
// ---------------------------------------------------------------------------
console.log("\n[ 3. Gear Drawing Projections ]");

test("Gear: generates pitch circle, outer circle, and tooth annotations", () => {
  const analysis = {
    componentType: "spur gear",
    teeth: 24,
    module: 2.5,
    dimensions: { innerDiameter: 18, height: 25 },
    geometryRecipe: {
      style: "gear",
      gear: { teeth: 24, module: 2.5, boreRadius: 9, faceWidth: 25 },
    },
  };

  const model = buildDrawingModel({ analysis, revision: "B", drawingId: "RF-042" });
  assert.strictEqual(model.revision, "B");
  assert.strictEqual(model.drawingId, "RF-042");

  const svg = renderDrawingToSvg(model);
  assert.ok(svg.includes("RF-042"), "SVG should reflect custom drawing ID");
  assert.ok(svg.includes("REV"), "SVG should reflect revision block");
});

// ---------------------------------------------------------------------------
// 4. Missing Data & Graceful Fallbacks
// ---------------------------------------------------------------------------
console.log("\n[ 4. Missing Data Fallbacks ]");

test("Missing recipe: falls back to estimated bounding projection without throwing", () => {
  const analysis = {
    componentType: "custom bracket",
    dimensions: { width: 75, height: 45, thickness: 12 },
  };

  const model = buildDrawingModel({ analysis });
  assert.ok(model.isEstimated, "Should flag as estimated when recipe is missing");
  assert.ok(model.views.front);
  assert.ok(model.views.top);
  assert.ok(model.views.side);

  const svg = renderDrawingToSvg(model);
  assert.ok(svg.includes("AI-ESTIMATED"), "Notes should mention AI-estimated dimensions");
});

test("Missing material & process: displays sensible defaults", () => {
  const model = buildDrawingModel({ analysis: {} });
  assert.strictEqual(model.units, "mm");
  assert.strictEqual(model.scale, "FIT");
  assert.ok(model.material.name);
  assert.ok(model.manufacturingProcess);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n─── Results: ${passed} passed, ${failed} failed ─────────────────`);
if (failed > 0) process.exit(1);
