import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeManufacturingIntelligence } from './manufacturing.js';

describe('Manufacturing Intelligence Suite', () => {
  const sampleAnalysis = {
    shapeType: 'spur_gear',
    materialEstimate: 'Mild Steel',
    dimensions: {
      outerDiameter: 120,
      pitchDiameter: 100,
      boreDiameter: 25,
      faceWidth: 30,
      length: 30,
    },
    teeth: 25,
    geometryRecipe: {
      gear: {
        teeth: 25,
        module: 4,
        pitchDiameter: 100,
        tipDiameter: 108,
        rootDiameter: 90,
        boreDiameter: 25,
        faceWidth: 30,
      },
    },
  };

  it('computes complete manufacturing intelligence with cost, maintenance, and TCO', () => {
    const mfg = computeManufacturingIntelligence({ analysis: sampleAnalysis, quantity: 5 });

    assert.ok(mfg, 'Manufacturing result should exist');
    assert.strictEqual(mfg.quantity, 5);
    assert.ok(mfg.cost.low > 0);
    assert.ok(mfg.cost.high >= mfg.cost.low);
    assert.ok(mfg.cost.mid > 0);

    // Initial manufacturing cost estimate structure
    assert.ok(mfg.initialCostEstimate, 'initialCostEstimate should be populated');
    assert.ok(mfg.initialCostEstimate.perUnitMid > 0);
    assert.ok(mfg.initialCostEstimate.batchTotal > 0);
    assert.ok(mfg.initialCostEstimate.breakdown.materialCostINR > 0);

    // Maintenance implications
    assert.ok(mfg.maintenanceImplications, 'maintenanceImplications should be populated');
    assert.ok(mfg.maintenanceImplications.lubricationIntervalHours > 0);
    assert.ok(mfg.maintenanceImplications.lubricantType);
    assert.ok(mfg.maintenanceImplications.inspectionIntervalHours > 0);
    assert.ok(Array.isArray(mfg.maintenanceImplications.keyMonitoringPoints));
    assert.ok(mfg.maintenanceImplications.keyMonitoringPoints.length >= 3);

    // Replacement frequency assumptions
    assert.ok(mfg.replacementFrequencyAssumptions, 'replacementFrequencyAssumptions should be populated');
    assert.ok(mfg.replacementFrequencyAssumptions.contactFatigueL10LifeHours > 0);
    assert.ok(mfg.replacementFrequencyAssumptions.expectedServiceYears > 0);
    assert.ok(mfg.replacementFrequencyAssumptions.dutyCycleFactor);

    // Long-term estimated cost
    assert.ok(mfg.estimatedLongTermCost, 'estimatedLongTermCost should be populated');
    assert.ok(mfg.estimatedLongTermCost.fiveYearTCOINR > 0);
    assert.ok(mfg.estimatedLongTermCost.tenYearTCOINR >= mfg.estimatedLongTermCost.fiveYearTCOINR);
    assert.ok(mfg.estimatedLongTermCost.breakdown.initialProcurementINR > 0);

    // Cost drivers
    assert.ok(Array.isArray(mfg.costDrivers));
    assert.ok(mfg.costDrivers.length >= 4);
    assert.ok(mfg.costDrivers.some(d => d.factor.includes('Machining') || d.factor.includes('Hobbing') || d.factor.includes('Run Time')));

    // Basis of estimate
    assert.ok(mfg.basisOfEstimate);
    assert.ok(mfg.basisOfEstimate.includes('geometric volume') || mfg.basisOfEstimate.includes('machining rates'));
  });

  it('handles insufficient geometry gracefully without crashing', () => {
    const invalidAnalysis = { shapeType: 'unknown', dimensions: {} };
    const mfg = computeManufacturingIntelligence({ analysis: invalidAnalysis, quantity: 1 });
    assert.ok(mfg.error === 'insufficient-data');
  });
});
