import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildModel } from './reconstruct.js';
import { sanitizeRecipe } from './recipe.js';
import {
  PARAM_DEFINITIONS,
  getParameterValue,
  isParamActive,
  getParameterRecommendations,
  applyScenarioToAnalysis,
} from './what-if.js';

function def(key) {
  return PARAM_DEFINITIONS.find((item) => item.key === key);
}

function boundingSize(analysis) {
  const model = buildModel(analysis);
  const box = new THREE.Box3().setFromObject(model.group);
  const size = new THREE.Vector3();
  box.getSize(size);
  return size;
}

function bracketAnalysis() {
  return {
    componentType: 'simple bracket',
    dimensions: { length: 10, width: 10, thickness: 4 },
    geometryRecipe: {
      style: 'extruded',
      outline: [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 5, y: 5 },
        { x: -5, y: 5 },
      ],
      holes: [{ cx: 0, cy: 0, radius: 1 }],
      depth: 4,
    },
  };
}

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

function flangeAnalysis() {
  return {
    componentType: 'flange',
    dimensions: { outerDiameter: 120, innerDiameter: 40, thickness: 12, height: 18 },
    geometryRecipe: {
      style: 'flange',
      flange: {
        outerDiameter: 120,
        innerDiameter: 40,
        thickness: 12,
        height: 18,
        boltCount: 4,
        boltCircleDiameter: 90,
        boltHoleDiameter: 10,
        bossDiameter: 70,
        bossHeight: 6,
      },
      holes: [
        { cx: 0, cy: 0, radius: 20 },
        { cx: 45, cy: 0, radius: 5 },
      ],
    },
  };
}

function shaftAnalysis() {
  return {
    componentType: 'stepped shaft',
    dimensions: { outerDiameter: 40, innerDiameter: 10, length: 100, height: 100, thickness: 20 },
    geometryRecipe: {
      style: 'revolved',
      revolvedProfile: [
        { z: 0, radius: 20 },
        { z: 100, radius: 20 },
      ],
    },
  };
}

test('recipe-only gear parameters are visible to the What-If simulator', () => {
  const analysis = {
    componentType: 'spur gear',
    geometryRecipe: { style: 'gear', gear: { teeth: 28, module: 2.5, faceWidth: 18, boreRadius: 7 } },
  };
  assert.equal(isParamActive(def('teeth'), analysis), true);
  assert.equal(isParamActive(def('module'), analysis), true);
  assert.equal(getParameterValue(analysis, 'teeth'), 28);
  assert.equal(getParameterValue(analysis, 'module'), 2.5);
  assert.equal(getParameterValue(analysis, 'innerDiameter'), 14);
});

test('square bracket length edit recommends proportional breadth without modifying the analysis', () => {
  const analysis = bracketAnalysis();
  const before = JSON.stringify(analysis);
  const recommendations = getParameterRecommendations(analysis, { length: 20 });

  const width = recommendations.find((item) => item.key === 'width');
  assert.ok(width);
  assert.equal(width.value, 20);
  assert.match(width.reason, /same ratio/i);
  assert.equal(JSON.stringify(analysis), before);

  const applied = applyScenarioToAnalysis(analysis, { length: 20 });
  assert.equal(applied.dimensions.length, 20);
  assert.equal(applied.geometryRecipe.outline[1].x, 10);
  assert.equal(applied.geometryRecipe.outline[2].y, 5);

  const withRecommendations = applyScenarioToAnalysis(analysis, {
    length: 20,
    width: width.value,
    thickness: 8,
  });
  const base = boundingSize(analysis);
  const changed = boundingSize(withRecommendations);
  assert.ok(Math.abs((changed.x / changed.y) - (base.x / base.y)) < 0.05);
});

test('gear recommendations follow teeth, module, bore and face-width dependencies', () => {
  const analysis = gearAnalysis();
  const odChange = getParameterRecommendations(analysis, { outerDiameter: 120 });
  assert.equal(odChange.find((item) => item.key === 'module')?.value, 4.6);
  assert.equal(odChange.find((item) => item.key === 'innerDiameter')?.value, 24);
  assert.equal(odChange.find((item) => item.key === 'thickness')?.value, 24);

  const teethChange = getParameterRecommendations(analysis, { teeth: 30 });
  assert.equal(teethChange.find((item) => item.key === 'outerDiameter')?.value, 128);
  assert.match(teethChange.find((item) => item.key === 'outerDiameter').reason, /module × \(teets|module × \(teeth/i);

  const moduleChange = getParameterRecommendations(analysis, { module: 5 });
  assert.equal(moduleChange.find((item) => item.key === 'outerDiameter')?.value, 130);
});

test('confirmed gear values reach the recipe used by the 3D and CAD engines', () => {
  const analysis = gearAnalysis();
  const applied = applyScenarioToAnalysis(analysis, {
    outerDiameter: 120,
    module: 5,
    innerDiameter: 24,
    height: 24,
    teeth: 28,
  });

  assert.equal(applied.dimensions.outerDiameter, 120);
  assert.equal(applied.geometryRecipe.gear.outerDiameter, 120);
  assert.equal(applied.geometryRecipe.gear.outerRadius, 60);
  assert.equal(applied.geometryRecipe.gear.module, 5);
  assert.equal(applied.geometryRecipe.gear.boreRadius, 12);
  assert.equal(applied.geometryRecipe.gear.faceWidth, 24);
  assert.equal(applied.geometryRecipe.gear.teeth, 28);

  const sanitized = sanitizeRecipe(applied);
  assert.equal(sanitized.gear.outerDiameter, 120);
  assert.ok(boundingSize(applied).x > 0);
});

test('flange and shaft recipe dimensions update only for confirmed values', () => {
  const flange = flangeAnalysis();
  const flangeApplied = applyScenarioToAnalysis(flange, { outerDiameter: 240, innerDiameter: 80 });
  assert.equal(flangeApplied.geometryRecipe.flange.outerDiameter, 240);
  assert.equal(flangeApplied.geometryRecipe.flange.innerDiameter, 80);
  assert.equal(flangeApplied.geometryRecipe.flange.boltCircleDiameter, 180);
  assert.equal(flangeApplied.geometryRecipe.flange.boltHoleDiameter, 20);
  assert.equal(flangeApplied.geometryRecipe.holes[0].radius, 40);
  assert.equal(flangeApplied.geometryRecipe.holes[1].cx, 90);

  const flangeRecs = getParameterRecommendations(flange, { outerDiameter: 240 });
  assert.equal(flangeRecs.find((item) => item.key === 'thickness')?.value, 24);
  assert.equal(flangeRecs.find((item) => item.key === 'height')?.value, 36);

  const shaft = shaftAnalysis();
  const shaftRecs = getParameterRecommendations(shaft, { length: 200 });
  assert.equal(shaftRecs.find((item) => item.key === 'height')?.value, 200);
  const shaftApplied = applyScenarioToAnalysis(shaft, { length: 200, height: 200 });
  assert.equal(shaftApplied.geometryRecipe.revolvedProfile[1].z, 200);
  assert.equal(shaftApplied.dimensions.height, 200);
});
