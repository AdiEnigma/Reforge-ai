import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAMAGE_LEVELS,
  getDamageHeatmapData,
  levelForSeverity,
  normalizeDamageMasks,
} from './damage-heatmap.js';

const IMAGE = { url: 'blob:gear-front', name: 'gear.jpg' };
const IMAGE_2 = { url: 'blob:gear-side', name: 'gear-side.jpg' };
const MASK = 'data:image/png;base64,iVBORw0KGgo=';

function mask(imageIndex, maskedPixels, severity = 'severe') {
  return {
    imageIndex,
    width: 640,
    height: 480,
    dataUrl: MASK,
    stats: {
      maskedPixels,
      severity,
      extent: maskedPixels > 1000 ? 'widespread' : 'localized',
      damageRatioOfComponent: maskedPixels / 10000,
      connectedRegions: 4,
      confidence: 0.9,
      types: ['rust'],
      levelCounts: { low: 0, moderate: 0, high: 10, severe: 4 },
    },
  };
}

test('severity scale has four distinct green/yellow/orange/red levels', () => {
  assert.deepEqual(DAMAGE_LEVELS.map((level) => level.key), [
    'low',
    'moderate',
    'high',
    'severe',
  ]);
  assert.equal(levelForSeverity('minor', 'localized'), 'low');
  assert.equal(levelForSeverity('moderate', 'localized'), 'moderate');
  assert.equal(levelForSeverity('severe', 'localized'), 'high');
  assert.equal(levelForSeverity('severe', 'widespread'), 'severe');
});

test('pixel masks are sanitised and invalid masks are dropped', () => {
  const clean = normalizeDamageMasks(
    [
      mask(9, 500),
      { imageIndex: 0, width: 10, height: 10, dataUrl: 'javascript:alert(1)', stats: {} },
      { imageIndex: 0, width: 0, height: 10, dataUrl: MASK, stats: {} },
    ],
    2
  );

  assert.equal(clean.length, 1);
  assert.equal(clean[0].imageIndex, 1);
  assert.equal(clean[0].stats.maskedPixels, 500);
  assert.equal(clean[0].stats.severity, 'severe');
});

test('heatmap selects the image that contains segmented damage', () => {
  const data = getDamageHeatmapData(
    {
      imageQuality: 'adequate',
      damageMasks: [mask(1, 2200), mask(0, 0)],
    },
    [IMAGE, IMAGE_2]
  );

  assert.equal(data.available, true);
  assert.equal(data.preferredIndex, 1);
  assert.equal(data.image.url, 'blob:gear-side');
  assert.equal(data.mask.dataUrl, MASK);
  assert.equal(data.mask.stats.maskedPixels, 2200);
  assert.equal(data.message, '');
});

test('a fully transparent mask never produces a painted overlay', () => {
  const data = getDamageHeatmapData(
    { imageQuality: 'adequate', damageMasks: [mask(0, 0)] },
    [IMAGE]
  );

  assert.equal(data.available, false);
  assert.equal(data.mask.stats.maskedPixels, 0);
  assert.match(data.message, /No visible rust, corrosion or pitting/);
});

test('reported defects without a pixel mask are not painted', () => {
  const data = getDamageHeatmapData(
    {
      imageQuality: 'adequate',
      observedDefects: ['Severe Corrosion'],
      wearEvidenceCount: 1,
      damageMasks: [],
    },
    [IMAGE]
  );

  assert.equal(data.available, false);
  assert.match(data.message, /no pixel mask was returned/);
});

test('missing assessment and insufficient images never produce a heatmap', () => {
  const missing = getDamageHeatmapData(null, [IMAGE]);
  assert.equal(missing.available, false);
  assert.match(missing.message, /No damage assessment/);

  const insufficient = getDamageHeatmapData(
    { imageQuality: 'insufficient', damageMasks: [mask(0, 9999)] },
    [IMAGE]
  );
  assert.equal(insufficient.available, false);
  assert.deepEqual(insufficient.masks, []);
  assert.match(insufficient.message, /insufficient/);
});
