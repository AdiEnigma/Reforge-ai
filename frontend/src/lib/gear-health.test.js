import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGearHealth, DAMAGE_MODES, POSSIBLE_CAUSES } from './gear-health.js';

test('evaluateGearHealth handles null/empty input gracefully', () => {
  const result = evaluateGearHealth(null, null);
  assert.equal(typeof result, 'object');
  assert.equal(result.healthScore, 100);
  assert.equal(Array.isArray(result.findings), true);
  assert.equal(Array.isArray(result.comparison), true);
});

test('evaluateGearHealth detects crack damage and selects REPLACE or REDESIGN with high risk awareness', () => {
  const component = {
    id: 'gear-test-1',
    name: 'Main Drive Pinion',
    notes: 'Severe root crack and broken tooth chipping observed during inspection.',
    images: [{ notes: 'visible fracture at tooth root' }],
  };
  const analysis = {
    dimensions: { outerDiameter: 120, innerDiameter: 30, height: 35 },
    teeth: 20,
    features: ['Root crack', 'Tooth damage'],
  };

  const result = evaluateGearHealth(component, analysis);

  assert.equal(result.healthStatus, 'CRITICAL');
  assert.ok(result.healthScore < 50);
  assert.ok(result.findings.some((f) => f.issue === DAMAGE_MODES.CRACKING));
  assert.ok(result.findings.some((f) => f.severity === 'CRITICAL'));
  assert.ok(result.preferredStrategy === 'REPLACE' || result.preferredStrategy === 'REDESIGN');
  assert.notEqual(result.preferredStrategy, 'REPAIR'); // Should NEVER recommend repair for dangerous root crack

  // Check evidence-supported causes
  assert.ok(result.evidenceSupportedCauses.length > 0);
  // Check comparison matrix has all 3 options with 8 metrics
  assert.equal(result.comparison.length, 3);
  for (const opt of result.comparison) {
    assert.ok(opt.strategy);
    assert.ok(opt.initialCost > 0);
    assert.ok(opt.leadTime);
    assert.ok(opt.expectedLongevity);
    assert.ok(opt.failureRisk);
    assert.ok(opt.maintenance);
    assert.ok(opt.availability);
    assert.ok(opt.manufacturingComplexity);
    assert.ok(opt.longTermCost5Yr > 0);
  }
});

test('evaluateGearHealth detects minor operational wear and allows REPAIR recommendation', () => {
  const component = {
    id: 'gear-test-2',
    name: 'Secondary Reduction Gear',
    notes: 'Slight flank wear and surface polishing, no cracks or deep pitting.',
  };
  const analysis = {
    dimensions: { outerDiameter: 90, innerDiameter: 25, height: 20 },
    teeth: 28,
  };

  const result = evaluateGearHealth(component, analysis);

  assert.ok(result.healthScore >= 50);
  assert.ok(result.preferredStrategy === 'REPAIR' || result.preferredStrategy === 'REPLACE');
  assert.ok(result.recommendationReason.length > 20);
});

test('evaluateGearHealth correctly separates evidence-supported vs inspection-required causes', () => {
  const component = {
    id: 'gear-test-3',
    name: 'Planetary Sun Gear',
    notes: 'Flank pitting and misalignment contact pattern visible.',
  };
  const analysis = {
    dimensions: { outerDiameter: 150, innerDiameter: 40, height: 40 },
    teeth: 32,
    uncertainties: ['Material hardness not verified'],
  };

  const result = evaluateGearHealth(component, analysis);

  assert.ok(result.evidenceSupportedCauses.length > 0);
  assert.ok(result.inspectionRequiredCauses.length > 0);

  // Verify all identified causes belong to the standard list
  for (const item of result.evidenceSupportedCauses) {
    assert.ok(POSSIBLE_CAUSES.includes(item.cause), `Unexpected cause: ${item.cause}`);
  }
  for (const item of result.inspectionRequiredCauses) {
    assert.ok(POSSIBLE_CAUSES.includes(item.cause), `Unexpected cause: ${item.cause}`);
  }
});

test('evaluateGearHealth selects REDESIGN when severe misalignment and high uncertainties exist', () => {
  const component = {
    id: 'gear-test-4',
    name: 'Heavy Industrial Bull Gear',
    notes: 'Severe crack and chronic misalignment bias wear.',
  };
  const analysis = {
    dimensions: { outerDiameter: 300, innerDiameter: 80, height: 90 },
    teeth: 48,
    uncertainties: ['Operating torque exceeds original design limits', 'Flank profile un-crowned'],
  };

  const result = evaluateGearHealth(component, analysis);

  assert.equal(result.preferredStrategy, 'REDESIGN');
  const preferredOpt = result.comparison.find((c) => c.isPreferred);
  assert.equal(preferredOpt.strategy, 'REDESIGN');
  assert.ok(preferredOpt.longTermCost5Yr > 0);
  assert.ok(result.recommendationReason.includes('REDESIGN'));
});

