import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildParameterConfidence,
  extractVisionObservations,
  reconcileGeminiWithVision,
  resolveGeometryFromVision,
  selectConfirmedToothCount,
  summarizeToothCountVision,
} from './src/vision-geometry-resolver.js';

function visionWithToothCount(result) {
  return {
    images: [
      {
        image_index: 0,
        width: 640,
        height: 480,
        opencv: {
          tooth_count: {
            image_index: 0,
            status: result.status,
            count: result.count ?? null,
            confidence: result.confidence ?? 0,
            methods: [
              { method: 'radial_peak', count: result.count ?? null, confidence: 0.4 },
              { method: 'polar_fft', count: result.count ?? null, confidence: 0.92 },
            ],
            teeth: result.count
              ? Array.from({ length: result.count }, (_, i) => ({
                  angle_deg: (360 / result.count) * i,
                  x_px: 100 + i,
                  y_px: 200 + i,
                  radius_px: 150,
                  confidence: result.confidence ?? 0,
                }))
              : [],
            warnings: result.warnings || [],
          },
        },
      },
    ],
  };
}

test('vision observations collect cross-checked tooth-count evidence', () => {
  const obs = extractVisionObservations(visionWithToothCount({ status: 'ok', count: 37, confidence: 0.9 }));

  assert.equal(obs.toothCounts.length, 1);
  const selected = selectConfirmedToothCount(obs);
  assert.equal(selected.count, 37);
  assert.equal(selected.confidence, 0.9);
});

test('reconciliation uses measured tooth count instead of a Gemini guess', () => {
  const gemini = {
    componentType: 'spur gear',
    teeth: 20,
    dimensions: { outerDiameter: 120, innerDiameter: 30, height: 18 },
  };
  const reconciled = reconcileGeminiWithVision(
    gemini,
    visionWithToothCount({ status: 'ok', count: 37, confidence: 0.91 }),
    {}
  );

  assert.equal(reconciled.teeth, 37);
  assert.equal(reconciled.geometryRecipe.gear.teeth, 37);
  assert.equal(reconciled.parameterConfidence.teeth.source, 'cv_tooth_tip_count');
  assert.equal(reconciled.parameterConfidence.teeth.status, 'MEASURED');
});

test('uncertain tooth count is flagged and does not become a confirmed measurement', () => {
  const gemini = {
    componentType: 'spur gear',
    teeth: 20,
    dimensions: { outerDiameter: 120, innerDiameter: 30, height: 18 },
  };
  const reconciled = reconcileGeminiWithVision(
    gemini,
    visionWithToothCount({ status: 'uncertain', count: null, confidence: 0.4 }),
    {}
  );

  assert.equal(reconciled.teeth, 20);
  assert.ok(reconciled.uncertainties.some((u) => /tooth count/i.test(u)));
  assert.notEqual(reconciled.parameterConfidence.teeth.source, 'cv_tooth_tip_count');
});

test('deterministic vision solver accepts a cross-checked tooth count outside legacy range', () => {
  const result = resolveGeometryFromVision(
    visionWithToothCount({ status: 'ok', count: 83, confidence: 0.86 }),
    { componentType: 'gear', gearType: 'spur' }
  );

  assert.equal(result.canResolveWithoutGemini, true);
  assert.equal(result.analysis.teeth, 83);
  assert.equal(result.analysis.geometryRecipe.gear.teeth, 83);
});

test('UI summary keeps image-space tooth markers for the uploaded photograph', () => {
  const summary = summarizeToothCountVision(
    visionWithToothCount({ status: 'ok', count: 12, confidence: 0.88 })
  );

  assert.equal(summary.status, 'ok');
  assert.equal(summary.count, 12);
  assert.equal(summary.imageWidth, 640);
  assert.equal(summary.imageHeight, 480);
  assert.equal(summary.teeth.length, 12);
  assert.equal(summary.methods.length, 2);
});

test('user reference still outranks automatic counting', () => {
  const confidence = buildParameterConfidence({
    teeth: 24,
    reference: { teeth: 24 },
    obs: extractVisionObservations(visionWithToothCount({ status: 'ok', count: 37, confidence: 0.9 })),
  });

  assert.equal(confidence.parameterConfidence.teeth.source, 'user_reference');
  assert.equal(confidence.parameterConfidence.teeth.status, 'MEASURED');
});
