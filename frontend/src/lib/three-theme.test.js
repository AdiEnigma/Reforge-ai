import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  MODEL_ILLUMINATION_MAX_INTENSITY,
  MODEL_ILLUMINATION_MIN_INTENSITY,
} from './model-illumination.js';
import { matAccent, matBody, matDark, matRim } from './geo.js';
import { applyModelAppearance, createThreeThemeSync } from './three-theme.js';

function createFakeScene() {
  const scene = {
    background: null,
    environment: null,
    children: [],
    traverse(callback) {
      callback(this);
      this.children.forEach((child) => {
        if (child && typeof child.traverse === 'function') child.traverse(callback);
        else callback(child);
      });
    },
    add(object) {
      object.parent = this;
      this.children.push(object);
    },
    remove(object) {
      this.children = this.children.filter((child) => child !== object);
      if (object.parent === this) object.parent = null;
    },
  };
  return scene;
}

function createFakeRenderer() {
  return {
    clearColor: null,
    setClearColor(color) {
      this.clearColor = color;
    },
  };
}

test('light appearance changes restore exact dark material values', () => {
  const shared = [matBody, matAccent, matRim, matDark];
  const darkValues = shared.map((material) => ({
    color: material.color.getHexString(),
    metalness: material.metalness,
    roughness: material.roughness,
  }));

  applyModelAppearance('light');
  shared.forEach((material, index) => {
    assert.notEqual(material.color.getHexString(), darkValues[index].color);
  });

  applyModelAppearance('dark');
  shared.forEach((material, index) => {
    assert.equal(material.color.getHexString(), darkValues[index].color);
    assert.equal(material.metalness, darkValues[index].metalness);
    assert.equal(material.roughness, darkValues[index].roughness);
  });
});

test('theme sync restores base lights and renderer output in dark mode', () => {
  const scene = createFakeScene();
  const renderer = createFakeRenderer();
  const ambient = { color: new THREE.Color('#7a4a38'), intensity: 0.6 };
  const key = { color: new THREE.Color('#ffb77f'), intensity: 0.8 };
  const original = {
    ambientColor: ambient.color.getHexString(),
    ambientIntensity: ambient.intensity,
    keyColor: key.color.getHexString(),
    keyIntensity: key.intensity,
  };

  const themeSync = createThreeThemeSync({
    scene,
    renderer,
    lights: { ambient, key },
  });

  themeSync.update('dark');
  assert.equal(ambient.color.getHexString(), original.ambientColor);
  assert.equal(ambient.intensity, original.ambientIntensity);
  assert.equal(scene.environment, null);

  themeSync.update('light');
  assert.notEqual(ambient.color.getHexString(), original.ambientColor);
  assert.notEqual(ambient.intensity, original.ambientIntensity);
  assert.equal(renderer.outputEncoding, THREE.sRGBEncoding);
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);

  themeSync.update('dark');
  assert.equal(ambient.color.getHexString(), original.ambientColor);
  assert.equal(ambient.intensity, original.ambientIntensity);
  assert.equal(key.color.getHexString(), original.keyColor);
  assert.equal(key.intensity, original.keyIntensity);
  assert.equal(scene.environment, null);
  assert.equal(renderer.outputEncoding, undefined);
  assert.equal(renderer.toneMapping, undefined);

  themeSync.dispose();
  assert.equal(scene.children.length, 0);
});

test('the light-mode control deepens scene lighting and reflections instead of brightening them', () => {
  const scene = createFakeScene();
  const renderer = createFakeRenderer();
  const ambient = { color: new THREE.Color('#7a4a38'), intensity: 0.6 };
  const key = { color: new THREE.Color('#ffb77f'), intensity: 0.8 };
  const fill = { color: new THREE.Color('#b76308'), intensity: 1.0 };
  const darkValues = {
    ambientColor: ambient.color.getHexString(),
    ambientIntensity: ambient.intensity,
    keyColor: key.color.getHexString(),
    keyIntensity: key.intensity,
    fillColor: fill.color.getHexString(),
    fillIntensity: fill.intensity,
  };
  const mesh = { material: { color: new THREE.Color('#ffffff'), envMapIntensity: 1 } };
  scene.add(mesh);

  const themeSync = createThreeThemeSync({
    scene,
    renderer,
    lights: { ambient, key, fill },
  });
  themeSync.update('dark');
  themeSync.update('light');

  const baseLightIntensity = key.intensity;
  const baseReflection = mesh.material.envMapIntensity;

  themeSync.setIllumination({
    enabled: true,
    intensity: MODEL_ILLUMINATION_MIN_INTENSITY,
    theme: 'light',
    immediate: true,
  });
  const shallowReflection = mesh.material.envMapIntensity;

  themeSync.setIllumination({
    enabled: true,
    intensity: MODEL_ILLUMINATION_MAX_INTENSITY,
    theme: 'light',
    immediate: true,
  });
  assert.ok(key.intensity < baseLightIntensity);
  assert.ok(ambient.intensity < 0.34);
  assert.notEqual(key.color.getHexString(), 'ffd9a8');
  assert.ok(mesh.material.envMapIntensity < shallowReflection);
  assert.ok(mesh.material.envMapIntensity < baseReflection);

  themeSync.setIllumination({ enabled: false, theme: 'light', immediate: true });
  assert.equal(key.intensity, baseLightIntensity);
  assert.equal(mesh.material.envMapIntensity, baseReflection);

  themeSync.update('dark');
  assert.equal(ambient.color.getHexString(), darkValues.ambientColor);
  assert.equal(ambient.intensity, darkValues.ambientIntensity);
  assert.equal(key.color.getHexString(), darkValues.keyColor);
  assert.equal(key.intensity, darkValues.keyIntensity);
  assert.equal(fill.color.getHexString(), darkValues.fillColor);
  assert.equal(fill.intensity, darkValues.fillIntensity);
  assert.equal(mesh.material.envMapIntensity, baseReflection);

  themeSync.dispose();
});
