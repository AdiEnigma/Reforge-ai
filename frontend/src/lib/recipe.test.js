import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRecipe } from './recipe.js';

describe('sanitizeRecipe coordinate handling', () => {
  it('preserves centered outline coordinates', () => {
    const recipe = sanitizeRecipe({
      geometryRecipe: {
        style: 'extruded',
        outline: [
          { x: -50, y: -30 },
          { x: 50, y: -30 },
          { x: 50, y: 30 },
          { x: -50, y: 30 },
        ],
        depth: 10,
      },
    });

    assert.ok(recipe);
    assert.deepEqual(recipe.outline, [
      { x: -50, y: -30 },
      { x: 50, y: -30 },
      { x: 50, y: 30 },
      { x: -50, y: 30 },
    ]);
  });

  it('preserves negative revolved profile z values', () => {
    const recipe = sanitizeRecipe({
      geometryRecipe: {
        style: 'revolved',
        revolvedProfile: [
          { z: -20, radius: 10 },
          { z: 20, radius: 10 },
        ],
      },
    });

    assert.ok(recipe);
    assert.deepEqual(recipe.revolvedProfile, [
      { z: -20, radius: 10 },
      { z: 20, radius: 10 },
    ]);
  });

  it('caps magnitude but keeps sign', () => {
    const recipe = sanitizeRecipe({
      geometryRecipe: {
        style: 'revolved',
        revolvedProfile: [
          { z: -1e9, radius: 10 },
          { z: 0, radius: 10 },
        ],
      },
    });

    assert.ok(recipe);
    const zValues = recipe.revolvedProfile.map((point) => point.z);
    assert.equal(zValues[0], -10000);
    assert.equal(zValues[1], 0);
  });
});
