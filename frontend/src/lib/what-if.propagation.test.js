import assert from 'node:assert/strict';
import test from 'node:test';
import { applyScenarioToAnalysis, getGeometryDecisionOverrides } from './what-if.js';
import { buildDrawingModel, extractBaseDimensions } from './drawing/projections.js';
import { renderDrawingToSvg } from './drawing/renderer.js';
import { exportBDF, exportDrawingSVG, exportINP } from './exporters.js';
import { requestCadExport } from './cad-export.js';
import { buildEngineeringContext } from './engineering-context.js';
import { computeSynchronizedManufacturingCost, CATEGORY_IDS } from './manufacturing-config.js';

function gearAnalysis() {
  return {
    componentType: 'spur gear',
    teeth: 24,
    module: 4,
    dimensions: { outerDiameter: 100, innerDiameter: 20, height: 20, thickness: 20 },
    geometryRecipe: {
      style: 'gear',
      gear: { teeth: 24, module: 4, boreRadius: 10, faceWidth: 20 },
    },
  };
}

function confirmedGear() {
  return applyScenarioToAnalysis(gearAnalysis(), {
    outerDiameter: 120,
    module: 5,
    innerDiameter: 24,
    height: 24,
    thickness: 24,
    teeth: 28,
  });
}

test('confirmed gear values drive engineering drawings instead of a teeth/module recompute', () => {
  const confirmed = confirmedGear();
  const dims = extractBaseDimensions(confirmed);
  assert.equal(dims.outerDia, 120);
  assert.equal(dims.innerDia, 24);
  assert.equal(dims.teeth, 28);
  assert.equal(dims.module, 5);

  const model = buildDrawingModel({
    analysis: confirmed,
    manufacturingIntelligence: {
      material: { label: 'AISI 4140', materialSource: 'ai-estimated' },
      process: { recommended: { label: 'Gear hobbing' } },
    },
  });
  assert.equal(model.dimensions.outerDia, 120);
  assert.equal(model.material.name, 'AISI 4140');
  assert.equal(model.manufacturingProcess, 'Gear hobbing');

  const svg = renderDrawingToSvg(model);
  assert.match(svg, /120/);
  const drawingExport = exportDrawingSVG(confirmed);
  assert.equal(drawingExport.filename, 'spur-gear-technical-drawing.svg');
  assert.match(drawingExport.content, /120/);
});

test('confirmed gear values drive FEA decks and the server-backed CAD export payload', async () => {
  const confirmed = confirmedGear();
  const inp = exportINP(confirmed).content;
  const bdf = exportBDF(confirmed).content;
  assert.match(inp, /60\.00/);
  assert.match(inp, /24\.00/);
  assert.match(bdf, /60\.00/);

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'attachment; filename="spur-gear.step"' },
      blob: async () => 'STEP_BLOB',
    };
  };

  try {
    const result = await requestCadExport(confirmed, 'step');
    assert.equal(result.filename, 'spur-gear.step');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.url, '/api/cad/export');
  const payload = JSON.parse(captured.options.body);
  assert.equal(payload.analysis.dimensions.outerDiameter, 120);
  assert.equal(payload.analysis.geometryRecipe.gear.outerDiameter, 120);
  assert.equal(payload.analysis.geometryRecipe.gear.module, 5);
  assert.equal(payload.analysis.geometryRecipe.gear.teeth, 28);
  assert.equal(payload.format, 'step');
});

test('confirmed gear values drive cost inputs and copilot context', () => {
  const confirmed = confirmedGear();
  const overrides = getGeometryDecisionOverrides(confirmed);
  assert.deepEqual(overrides, {
    outerDiameter: 120,
    innerDiameter: 24,
    height: 24,
    teeth: 28,
  });

  const cost = computeSynchronizedManufacturingCost({
    decisions: overrides,
    confirmedCategories: { [CATEGORY_IDS.GEOMETRY]: true },
    quantity: 1,
  });
  const geometryRow = cost.itemizedBreakdown.find((row) => row.catId === CATEGORY_IDS.GEOMETRY);
  assert.match(geometryRow.driver, /OD: 120mm · ID: 24mm · L: 24mm \(28T/);

  const context = buildEngineeringContext({ analysis: confirmed, features: [] });
  assert.equal(context.dimensions.outerDiameter, 120);
  assert.equal(context.dimensions.teeth, 28);
  assert.equal(context.dimensions.module, 5);
  assert.equal(context.geometry.recipe.outerDiameter, 120);
});

test('confirmed bracket, flange and shaft values reach drawing dimensions', () => {
  const bracket = applyScenarioToAnalysis(
    {
      componentType: 'simple bracket',
      dimensions: { length: 10, width: 10, thickness: 4 },
      geometryRecipe: { style: 'extruded', outline: [{ x: -5, y: -5 }, { x: 5, y: 5 }], depth: 4 },
    },
    { length: 20, width: 20, thickness: 8 }
  );
  const bracketDims = extractBaseDimensions(bracket);
  assert.equal(bracketDims.height, 20);
  assert.equal(bracketDims.width, 20);
  assert.equal(bracketDims.depth, 8);

  const flange = applyScenarioToAnalysis(
    {
      componentType: 'flange',
      dimensions: { outerDiameter: 120, innerDiameter: 40, thickness: 12, height: 18 },
      geometryRecipe: {
        style: 'flange',
        flange: { outerDiameter: 120, innerDiameter: 40, thickness: 12, height: 18 },
      },
    },
    { outerDiameter: 240, innerDiameter: 80 }
  );
  const flangeDims = extractBaseDimensions(flange);
  assert.equal(flangeDims.outerDia, 240);
  assert.equal(flangeDims.innerDia, 80);

  const shaft = applyScenarioToAnalysis(
    {
      componentType: 'stepped shaft',
      dimensions: { outerDiameter: 40, innerDiameter: 10, length: 100, height: 100, thickness: 20 },
      geometryRecipe: { style: 'revolved', revolvedProfile: [{ z: 0, radius: 20 }, { z: 100, radius: 20 }] },
    },
    { length: 200, height: 200 }
  );
  const shaftDims = extractBaseDimensions(shaft);
  assert.equal(shaftDims.height, 200);
  assert.equal(shaftDims.outerDia, 40);
});
