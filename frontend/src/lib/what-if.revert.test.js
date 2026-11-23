import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyScenarioToAnalysis,
  captureWhatIfBaseline,
  hasConfirmedWhatIfChanges,
  restoreWhatIfDecisions,
  restoreWhatIfMachineryState,
} from './what-if.js';
import { buildModel } from './reconstruct.js';
import { buildDrawingModel } from './drawing/projections.js';
import { renderDrawingToSvg } from './drawing/renderer.js';
import { exportBDF, exportINP } from './exporters.js';
import { requestCadExport } from './cad-export.js';
import { buildEngineeringContext } from './engineering-context.js';
import { computeSynchronizedManufacturingCost, CATEGORY_IDS } from './manufacturing-config.js';

function originalGearAnalysis() {
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

function machineryWith(analysis) {
  return {
    primaryGear: { id: 'gear-1', name: 'Primary gear', analysis },
    companionGear: null,
    additionalComponents: [],
  };
}


test('revert restores the original specification and only the geometry decisions', () => {
  const original = originalGearAnalysis();
  const baseline = captureWhatIfBaseline({
    analysis: original,
    componentId: 'gear-1',
    machineryState: machineryWith(original),
    decisions: { outerDiameter: 100, innerDiameter: 20, height: 20, teeth: 24, material: 'steel' },
  });
  const confirmed = applyScenarioToAnalysis(original, {
    outerDiameter: 120,
    innerDiameter: 24,
    height: 24,
    thickness: 24,
    teeth: 28,
  });

  assert.equal(hasConfirmedWhatIfChanges(baseline, confirmed), true);
  const decisions = restoreWhatIfDecisions(baseline, {
    ...baseline.decisions,
    outerDiameter: 120,
    innerDiameter: 24,
    height: 24,
    teeth: 28,
    material: 'titanium',
  });
  assert.equal(decisions.outerDiameter, 100);
  assert.equal(decisions.innerDiameter, 20);
  assert.equal(decisions.height, 20);
  assert.equal(decisions.teeth, 24);
  assert.equal(decisions.material, 'titanium', 'unrelated manufacturing choices survive the revert');

  const revertedState = restoreWhatIfMachineryState(baseline, machineryWith(confirmed));
  const reverted = revertedState.primaryGear.analysis;
  assert.equal(hasConfirmedWhatIfChanges(baseline, reverted), false);
  assert.equal(reverted.geometryRecipe.gear.outerDiameter, undefined);
  assert.equal(reverted.geometryRecipe.gear.teeth, 24);
  assert.equal(reverted.dimensions.innerDiameter, 20);
});

test('reverted analysis drives 3D, drawings, FEA, CAD, cost and copilot outputs', async () => {
  const original = originalGearAnalysis();
  const baseline = captureWhatIfBaseline({
    analysis: original,
    componentId: 'gear-1',
    machineryState: machineryWith(original),
    decisions: {},
  });
  const confirmed = applyScenarioToAnalysis(original, {
    outerDiameter: 120,
    innerDiameter: 24,
    height: 24,
    teeth: 28,
  });
  const reverted = restoreWhatIfMachineryState(baseline, machineryWith(confirmed)).primaryGear.analysis;

  const originalModel = buildModel(original);
  const confirmedModel = buildModel(confirmed);
  const revertedModel = buildModel(reverted);
  assert.equal(revertedModel.params.teeth, originalModel.params.teeth);
  assert.equal(confirmedModel.params.teeth, 28, 'confirmation should change the model parameters');
  assert.notEqual(revertedModel.params.teeth, confirmedModel.params.teeth);

  const originalDrawing = buildDrawingModel({ analysis: original });
  const revertedDrawing = buildDrawingModel({ analysis: reverted });
  assert.equal(revertedDrawing.dimensions.outerDia, originalDrawing.dimensions.outerDia);
  assert.equal(revertedDrawing.dimensions.innerDia, 20);
  assert.equal(revertedDrawing.geometryFacts.teethCount, 24);
  assert.equal(renderDrawingToSvg(revertedDrawing).includes('Ø120'), false);

  assert.match(exportINP(reverted).content, /50\.00/);
  assert.match(exportBDF(reverted).content, /50\.00/);

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
    await requestCadExport(reverted, 'step');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const payload = JSON.parse(captured.options.body);
  assert.equal(payload.analysis.dimensions.outerDiameter, 100);
  assert.equal(payload.analysis.geometryRecipe.gear.teeth, 24);

  const cost = computeSynchronizedManufacturingCost({
    decisions: restoreWhatIfDecisions(baseline, { outerDiameter: 120, innerDiameter: 24, height: 24, teeth: 28 }),
    confirmedCategories: { [CATEGORY_IDS.GEOMETRY]: true },
    quantity: 1,
  });
  assert.match(cost.itemizedBreakdown.find((row) => row.catId === CATEGORY_IDS.GEOMETRY).driver, /OD: 100mm · ID: 20mm · L: 20mm \(24T/);

  const context = buildEngineeringContext({ analysis: reverted, features: [] });
  assert.equal(context.dimensions.outerDiameter, 100);
  assert.equal(context.dimensions.teeth, 24);
});
