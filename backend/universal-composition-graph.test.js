import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  AST_NODE_TYPES,
  createCarrierNode,
  attachModifier,
  attachJunction,
  compileCompositionGraphToRecipe,
} from './src/universal-composition-graph.js';

describe('Universal Composition Graph (B-Rep AST)', () => {
  it('constructs a multi-stage stepped shaft carrier with worm flight and keyway modifiers', () => {
    const carrier = createCarrierNode({
      id: 'carrier_spindle',
      type: AST_NODE_TYPES.CARRIER_REVOLVED,
      geometry: {
        stages: [
          { zStart: -90, zEnd: -70, radius: 12, label: 'Threaded Nose' },
          { zStart: -70, zEnd: -27, radius: 16.8, label: 'Drive Journal' },
          { zStart: -27, zEnd: 27, radius: 30, pitch: 8, starts: 1, rootRadius: 21, label: 'Worm Flight' },
          { zStart: 27, zEnd: 70, radius: 15, label: 'Support Journal' },
          { zStart: 70, zEnd: 90, radius: 12.3, label: 'Output Journal' },
        ],
      },
    });

    attachModifier(carrier, {
      id: 'mod_drive_keyway',
      type: AST_NODE_TYPES.MODIFIER_KEYWAY,
      parameters: { width: 6, depth: 3.5, length: 22, journalRadius: 16.8 },
      location: { position: [18, 0, -50], orientation: [0, 0, 1] },
      provenance: { status: 'MEASURED', confidence: 0.95 },
    });

    const graph = {
      carriers: [carrier],
    };

    const recipe = compileCompositionGraphToRecipe(graph);
    assert.strictEqual(recipe.style, 'axial_segments');
    assert.strictEqual(recipe.axialSegments.length, 5);
    assert.strictEqual(recipe.modifiers.length, 1);
    assert.strictEqual(recipe.modifiers[0].type, 'keyway');
    assert.strictEqual(recipe.modifiers[0].width, 6);
  });

  it('constructs an extruded bracket carrier with bores and bolt pattern modifiers', () => {
    const carrier = createCarrierNode({
      id: 'carrier_bracket',
      type: AST_NODE_TYPES.CARRIER_EXTRUDED,
      geometry: {
        outline: [
          { x: -50, y: -25 },
          { x: 50, y: -25 },
          { x: 50, y: 25 },
          { x: -50, y: 25 },
        ],
        depth: 16,
      },
    });

    attachModifier(carrier, {
      type: AST_NODE_TYPES.MODIFIER_BORE,
      parameters: { diameter: 24 },
      location: { position: [0, 0, 0] },
    });

    attachModifier(carrier, {
      type: AST_NODE_TYPES.MODIFIER_BOLT_PATTERN,
      parameters: { count: 4, boltCircleDiameter: 60, holeDiameter: 6 },
    });

    const graph = {
      carriers: [carrier],
    };

    const recipe = compileCompositionGraphToRecipe(graph);
    assert.strictEqual(recipe.style, 'extruded');
    assert.strictEqual(recipe.outline.length, 4);
    assert.strictEqual(recipe.holes.length, 5); // 1 central bore + 4 bolt holes
    assert.strictEqual(recipe.depth, 16);
  });
});
