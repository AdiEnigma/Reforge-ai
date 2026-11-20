import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createModelIllumination,
  DEFAULT_MODEL_ILLUMINATION_INTENSITY,
  MODEL_ILLUMINATION_MAX_INTENSITY,
  MODEL_ILLUMINATION_MIN_INTENSITY,
} from './model-illumination.js';

test('overhead illumination is positioned from model bounds and can be adjusted without rebuilding the scene', () => {
  const scene = new THREE.Scene();
  const bounds = new THREE.Box3(
    new THREE.Vector3(-8, -2, -8),
    new THREE.Vector3(8, 2, 8)
  );
  const center = bounds.getCenter(new THREE.Vector3());

  const illumination = createModelIllumination(scene, {
    enabled: false,
    intensity: DEFAULT_MODEL_ILLUMINATION_INTENSITY,
    bounds,
  });

  assert.equal(illumination.light.visible, false);
  assert.equal(illumination.light.intensity, DEFAULT_MODEL_ILLUMINATION_INTENSITY);
  assert.equal(illumination.light.castShadow, false);
  assert.ok(illumination.light.position.y > center.y + 5);
  assert.ok(illumination.light.target.position.distanceTo(center) < 0.001);

  illumination.update({ enabled: true, intensity: 3.2 });
  assert.equal(illumination.light.visible, true);
  assert.equal(illumination.light.intensity, 3.2);

  illumination.update({ intensity: 99 });
  assert.equal(illumination.light.visible, true);
  assert.equal(illumination.light.intensity, MODEL_ILLUMINATION_MAX_INTENSITY);

  illumination.update({ intensity: -5 });
  assert.equal(illumination.light.intensity, MODEL_ILLUMINATION_MIN_INTENSITY);

  illumination.update({ enabled: false });
  assert.equal(illumination.light.visible, false);

  illumination.dispose();
  assert.equal(scene.children.includes(illumination.light), false);
  assert.equal(scene.children.includes(illumination.light.target), false);
});
