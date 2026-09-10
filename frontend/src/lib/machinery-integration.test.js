import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialMachineryState,
  addAdditionalComponent,
  assignComponentRole,
  checkRoleConflict,
  addImagesToComponent,
  removeImageFromComponent,
  hasDirtyContext,
  createMachinerySnapshot,
  computeAssemblyRelations,
  getAllComponents,
  ROLE_TYPES,
} from './machinery-context.js';
import { buildEngineeringContext, getEngineeringSuggestions } from './engineering-context.js';
import { buildAssemblyScene, buildModel } from './reconstruct.js';

test('End-to-End Machinery Context Lifecycle', async (t) => {
  await t.test('1. Initialize Machinery State with 1 Primary Gear and empty Surroundings', () => {
    const state = createInitialMachineryState();
    assert.ok(state.primaryGear);
    assert.equal(state.primaryGear.role, ROLE_TYPES.PRIMARY);
    assert.equal(state.primaryGear.name, 'Gear 1');
    assert.equal(state.companionGear, null);
    assert.equal(state.additionalComponents.length, 0);
    assert.ok(state.machineryContext);

    const comps = getAllComponents(state);
    assert.equal(comps.length, 1);
  });

  await t.test('2. Add Additional Components (Gears, Shafts, Bearings, Housing)', () => {
    let state = createInitialMachineryState();
    state = addAdditionalComponent(state, {
      name: 'Pinion Gear B',
      type: 'spur_gear',
      role: ROLE_TYPES.ADDITIONAL_GEAR,
    });
    state = addAdditionalComponent(state, {
      name: 'Main Drive Shaft',
      type: 'shaft',
      role: ROLE_TYPES.SHAFT,
    });
    state = addAdditionalComponent(state, {
      name: 'Deep Groove Bearing',
      type: 'bearing',
      role: ROLE_TYPES.BEARING,
    });
    state = addAdditionalComponent(state, {
      name: 'Cast Iron Housing',
      type: 'housing',
      role: ROLE_TYPES.HOUSING,
    });

    const comps = getAllComponents(state);
    assert.equal(comps.length, 5); // Primary + 4 additions
    assert.equal(state.additionalComponents.length, 4);
  });

  await t.test('3. Designate Companion Gear and check Role Conflicts', () => {
    let state = createInitialMachineryState();
    state = addAdditionalComponent(state, {
      name: 'Gear B',
      type: 'spur_gear',
      role: ROLE_TYPES.ADDITIONAL_GEAR,
    });
    state = addAdditionalComponent(state, {
      name: 'Gear C',
      type: 'spur_gear',
      role: ROLE_TYPES.ADDITIONAL_GEAR,
    });

    const gearBId = state.additionalComponents[0].id;
    const gearCId = state.additionalComponents[1].id;

    // First assign Gear B as Companion - no conflict because companionGear is null
    const conflict1 = checkRoleConflict(state, gearBId, ROLE_TYPES.COMPANION);
    assert.equal(conflict1.hasConflict, false);

    state = assignComponentRole(state, gearBId, ROLE_TYPES.COMPANION, false);
    assert.ok(state.companionGear);
    assert.equal(state.companionGear.name, 'Gear B');
    assert.equal(state.additionalComponents.length, 1); // Gear C remains in additional

    // Second assign Gear C as Companion - CONFLICT with Gear B!
    const conflict2 = checkRoleConflict(state, gearCId, ROLE_TYPES.COMPANION);
    assert.equal(conflict2.hasConflict, true);
    assert.equal(conflict2.currentHolder.name, 'Gear B');

    // Perform swap with force = true
    state = assignComponentRole(state, gearCId, ROLE_TYPES.COMPANION, true);
    assert.equal(state.companionGear.name, 'Gear C');
    assert.equal(state.additionalComponents[0].name, 'Gear B'); // Gear B swapped back to additional
    assert.equal(state.additionalComponents[0].role, ROLE_TYPES.SECONDARY); // Gear B inherits Gear C's old role
  });

  await t.test('4. Image Management and Dirty State Tracking', () => {
    let state = createInitialMachineryState();
    const snap1 = createMachinerySnapshot(state);
    assert.equal(hasDirtyContext(state, snap1), false);

    // Mock file additions
    const mockFiles = [
      { name: 'gear_top.png', size: 1024, type: 'image/png' },
      { name: 'gear_side.png', size: 2048, type: 'image/png' },
    ];
    state = addImagesToComponent(state, state.primaryGear.id, mockFiles);
    assert.equal(state.primaryGear.images.length, 2);
    assert.equal(hasDirtyContext(state, snap1), true);

    // Create new snapshot after simulated regeneration
    const snap2 = createMachinerySnapshot(state);
    assert.equal(hasDirtyContext(state, snap2), false);

    // Remove one image
    const imgId = state.primaryGear.images[0].id;
    state = removeImageFromComponent(state, state.primaryGear.id, imgId);
    assert.equal(state.primaryGear.images.length, 1);
    assert.equal(hasDirtyContext(state, snap2), true);
  });

  await t.test('5. Kinematic Relations and 3D Assembly Scene Construction', () => {
    let state = createInitialMachineryState();
    state.primaryGear.analysis = {
      componentType: 'spur_gear',
      teeth: 20,
      module: 3.0,
      dimensions: { outerDiameter: 66, innerDiameter: 15, height: 25 },
    };

    state = addAdditionalComponent(state, {
      name: 'Driven Pinion',
      type: 'spur_gear',
      role: ROLE_TYPES.ADDITIONAL_GEAR,
    });
    const pinionId = state.additionalComponents[0].id;
    state = assignComponentRole(state, pinionId, ROLE_TYPES.COMPANION, true);
    state.companionGear.analysis = {
      componentType: 'spur_gear',
      teeth: 40,
      module: 3.0,
      dimensions: { outerDiameter: 126, innerDiameter: 25, height: 25 },
    };

    // Kinematic relations
    const relations = computeAssemblyRelations(state.primaryGear, state.companionGear, state.additionalComponents);
    assert.ok(relations);
    assert.ok(relations.companion);
    assert.equal(relations.companion.centerDistance, 90); // m*(z1+z2)/2 = 3*(20+40)/2 = 90mm
    assert.equal(relations.companion.gearRatio, 2); // 40 / 20 = 2.0

    // Build 3D Assembly Scene
    const { group } = buildAssemblyScene(state);
    assert.ok(group);
    assert.ok(group.children.length > 0);
  });

  await t.test('6. Dynamic Engineering Context and Active Scope Suggestions', () => {
    let state = createInitialMachineryState();
    state.primaryGear.analysis = {
      componentType: 'spur_gear',
      componentName: 'Input Pinion 24T',
      teeth: 24,
      module: 2.5,
      material: 'AISI 4140 Steel',
      dimensions: { outerDiameter: 65, innerDiameter: 18, height: 28 },
    };

    // Test 'pair' scope
    state = addAdditionalComponent(state, {
      name: 'Mating Gear 48T',
      type: 'spur_gear',
      role: ROLE_TYPES.ADDITIONAL_GEAR,
    });
    state = assignComponentRole(state, state.additionalComponents[0].id, ROLE_TYPES.COMPANION, true);
    state.companionGear.analysis = {
      componentType: 'spur_gear',
      teeth: 48,
      module: 2.5,
      dimensions: { outerDiameter: 125, innerDiameter: 25, height: 28 },
    };

    const engContextPair = buildEngineeringContext({
      analysis: state.primaryGear.analysis,
      machineryState: state,
      activeScope: 'pair',
    });

    assert.ok(engContextPair.machineryContext);
    assert.equal(engContextPair.machineryContext.activeScope, 'pair');
    assert.equal(engContextPair.machineryContext.assemblyRelations.companion.gearRatio, 2);

    const suggestionsPair = getEngineeringSuggestions(engContextPair);
    assert.ok(suggestionsPair.some((s) => s.includes('gear ratio') || s.includes('mating') || s.includes('center distance')));

    // Test 'assembly' scope
    const engContextAssembly = buildEngineeringContext({
      analysis: state.primaryGear.analysis,
      machineryState: state,
      activeScope: 'assembly',
    });
    assert.equal(engContextAssembly.machineryContext.activeScope, 'assembly');
    const suggestionsAssembly = getEngineeringSuggestions(engContextAssembly);
    assert.ok(suggestionsAssembly.some((s) => s.includes('assembly') || s.includes('shaft') || s.includes('misalignment')));
  });
});
