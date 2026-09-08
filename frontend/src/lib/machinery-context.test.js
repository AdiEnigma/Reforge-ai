import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialMachineryState,
  createComponentEntity,
  getAllComponents,
  findComponentById,
  checkRoleConflict,
  assignComponentRole,
  addAdditionalComponent,
  removeComponent,
  addImagesToComponent,
  removeImageFromComponent,
  createMachinerySnapshot,
  hasDirtyContext,
  computeAssemblyRelations,
  addGearFromImages,
  addCompanionFromImages,
  getNextGearName,
  updateImageMetadata,
  replaceComponentImage,
  reorderComponentImages,
  renameGearComponent,
  updateComponentNotes,
  ROLE_TYPES,
} from './machinery-context.js';

test('createInitialMachineryState initializes with 1 Primary Gear, no Companion Gear, and empty contexts', () => {
  const state = createInitialMachineryState();
  assert.ok(state.primaryGear);
  assert.equal(state.primaryGear.role, ROLE_TYPES.PRIMARY);
  assert.equal(state.companionGear, null);
  assert.equal(state.additionalComponents.length, 0);
  assert.ok(state.assemblyContext);
  assert.ok(state.environmentContext);
});

test('Image-only gear creation: addCompanionFromImages & addGearFromImages with auto-naming', () => {
  let state = createInitialMachineryState();
  const file1 = { name: 'companion1.png', type: 'image/png' };
  const file2 = { name: 'gear3_a.png', type: 'image/png' };
  const file3 = { name: 'gear4_a.png', type: 'image/png' };

  // Add Companion from images
  state = addCompanionFromImages(state, [file1]);
  assert.ok(state.companionGear);
  assert.equal(state.companionGear.name, 'Companion Gear');
  assert.equal(state.companionGear.images.length, 1);

  // Add Additional Gears from images -> auto-named Gear 3, Gear 4
  state = addGearFromImages(state, [file2]);
  assert.equal(state.additionalComponents.length, 1);
  assert.equal(state.additionalComponents[0].name, 'Gear 3');
  assert.equal(state.additionalComponents[0].images.length, 1);

  state = addGearFromImages(state, [file3]);
  assert.equal(state.additionalComponents.length, 2);
  assert.equal(state.additionalComponents[1].name, 'Gear 4');
  assert.equal(state.additionalComponents[1].images.length, 1);
});

test('Image metadata management: purpose, priority, notes, replace, and reorder', () => {
  let state = createInitialMachineryState();
  const files = [
    { name: 'photo1.jpg', type: 'image/jpeg' },
    { name: 'photo2.jpg', type: 'image/jpeg' },
  ];
  state = addImagesToComponent(state, state.primaryGear.id, files);
  const img1Id = state.primaryGear.images[0].id;
  const img2Id = state.primaryGear.images[1].id;

  // 1. Update image metadata
  state = updateImageMetadata(state, state.primaryGear.id, img1Id, {
    purpose: 'tooth_profile',
    priority: 'high',
    note: 'Close up of tooth flank wear',
  });
  assert.equal(state.primaryGear.images[0].purpose, 'tooth_profile');
  assert.equal(state.primaryGear.images[0].priority, 'high');
  assert.equal(state.primaryGear.images[0].note, 'Close up of tooth flank wear');

  // 2. Reorder images
  state = reorderComponentImages(state, state.primaryGear.id, 0, 1);
  assert.equal(state.primaryGear.images[0].id, img2Id);
  assert.equal(state.primaryGear.images[1].id, img1Id);

  // 3. Replace image
  const replacementFile = { name: 'photo2_retake.jpg', type: 'image/jpeg' };
  state = replaceComponentImage(state, state.primaryGear.id, img2Id, replacementFile);
  assert.equal(state.primaryGear.images[0].name, 'photo2_retake.jpg');

  // 4. Rename gear & update component notes
  state = renameGearComponent(state, state.primaryGear.id, 'Input Pinion 20T');
  assert.equal(state.primaryGear.name, 'Input Pinion 20T');

  state = updateComponentNotes(state, state.primaryGear.id, 'Mounted on 25mm shaft');
  assert.equal(state.primaryGear.notes, 'Mounted on 25mm shaft');
});

test('Snapshot dirty detection responds to image metadata and notes changes', () => {
  let state = createInitialMachineryState();
  state = addImagesToComponent(state, state.primaryGear.id, [{ name: 'img1.png', type: 'image/png' }]);
  const snapshot = createMachinerySnapshot(state);
  assert.equal(hasDirtyContext(state, snapshot), false);

  // Update note -> should become dirty
  state = updateImageMetadata(state, state.primaryGear.id, state.primaryGear.images[0].id, {
    purpose: 'pitch_circle',
  });
  assert.equal(hasDirtyContext(state, snapshot), true);
});

test('checkRoleConflict and assignComponentRole handle Companion replacement with conflict detection', () => {
  let state = createInitialMachineryState();
  state = addAdditionalComponent(state, { id: 'gear-b', name: 'Gear B', role: ROLE_TYPES.ADDITIONAL_GEAR });
  state = addAdditionalComponent(state, { id: 'gear-c', name: 'Gear C', role: ROLE_TYPES.ADDITIONAL_GEAR });

  // Assign Gear B as Companion Gear
  state = assignComponentRole(state, 'gear-b', ROLE_TYPES.COMPANION);
  assert.equal(state.companionGear.id, 'gear-b');

  // Attempting to assign Gear C without forceReplace detects conflict
  const conflict = checkRoleConflict(state, 'gear-c', ROLE_TYPES.COMPANION);
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.type, 'REPLACE_COMPANION');
  assert.equal(conflict.currentCompanion.id, 'gear-b');

  assert.throws(() => {
    assignComponentRole(state, 'gear-c', ROLE_TYPES.COMPANION, false);
  }, /ROLE_CONFLICT:REPLACE_COMPANION/);

  // Force replacement demotes old companion (Gear B) to ADDITIONAL_GEAR and sets Gear C as COMPANION
  state = assignComponentRole(state, 'gear-c', ROLE_TYPES.COMPANION, true);
  assert.equal(state.companionGear.id, 'gear-c');
  assert.equal(state.additionalComponents.length, 1);
  assert.equal(state.additionalComponents[0].id, 'gear-b');
  assert.equal(state.additionalComponents[0].role, ROLE_TYPES.ADDITIONAL_GEAR);
});

test('computeAssemblyRelations calculates center distance, gear ratio, and multi-gear relations', () => {
  const primaryComp = {
    analysis: {
      teeth: 20,
      module: 2.5,
      dimensions: { outerDiameter: 55, innerDiameter: 15, height: 20 },
    },
  };
  const companionComp = {
    analysis: {
      teeth: 40,
      module: 2.5,
      dimensions: { outerDiameter: 105, innerDiameter: 25, height: 20 },
    },
  };
  const additional = [
    { id: 'g3', name: 'Gear 3', role: ROLE_TYPES.ADDITIONAL_GEAR, analysis: { teeth: 60, module: 2.5 } },
    { type: 'shaft', name: 'Main Drive Shaft' },
  ];

  const relations = computeAssemblyRelations(primaryComp, companionComp, additional);
  assert.equal(relations.primary.pitchDiameter, 50); // 20 * 2.5
  assert.equal(relations.companion.centerDistance, 75); // (20 + 40) * 2.5 / 2
  assert.equal(relations.companion.gearRatio, 2); // 40 / 20
  assert.equal(relations.additionalGears.length, 1);
  assert.equal(relations.additionalGears[0].teeth, 60);
  assert.equal(relations.additionalGears[0].ratioToPrimary, 3); // 60 / 20
  assert.equal(relations.totalComponents, 4);
});

test('addImagesToComponent adds images across all sectors and aliases', () => {
  let state = createInitialMachineryState();

  // 1. Primary Gear
  state = addImagesToComponent(state, 'primary', [{ name: 'primary1.jpg' }]);
  assert.equal(state.primaryGear.images.length, 1);
  state = addImagesToComponent(state, state.primaryGear.id, [{ name: 'primary2.jpg' }]);
  assert.equal(state.primaryGear.images.length, 2);

  // 2. Companion Gear
  state = addCompanionFromImages(state, [{ name: 'comp1.jpg' }]);
  assert.equal(state.companionGear.images.length, 1);
  state = addImagesToComponent(state, 'companion', [{ name: 'comp2.jpg' }]);
  assert.equal(state.companionGear.images.length, 2);
  state = addImagesToComponent(state, state.companionGear.id, [{ name: 'comp3.jpg' }]);
  assert.equal(state.companionGear.images.length, 3);

  // 3. Additional Gears
  state = addGearFromImages(state, [{ name: 'gear3_1.jpg' }]);
  const gear3Id = state.additionalComponents[0].id;
  assert.equal(state.additionalComponents[0].images.length, 1);
  state = addImagesToComponent(state, gear3Id, [{ name: 'gear3_2.jpg' }]);
  assert.equal(state.additionalComponents[0].images.length, 2);

  // 4. Assembly Context
  state = addImagesToComponent(state, 'assembly-context', [{ name: 'asm1.jpg' }]);
  assert.equal(state.assemblyContext.images.length, 1);
  state = addImagesToComponent(state, 'assembly', [{ name: 'asm2.jpg' }]);
  assert.equal(state.assemblyContext.images.length, 2);

  // 5. Environment Context / Machinery Surroundings
  state = addImagesToComponent(state, 'environment-context', [{ name: 'env1.jpg' }]);
  assert.equal(state.environmentContext.images.length, 1);
  state = addImagesToComponent(state, 'surroundings', [{ name: 'env2.jpg' }]);
  assert.equal(state.environmentContext.images.length, 2);
});
