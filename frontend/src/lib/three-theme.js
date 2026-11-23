import * as THREE from 'three';
import {
  DEFAULT_MODEL_ILLUMINATION_INTENSITY,
  MODEL_ILLUMINATION_MAX_INTENSITY,
  MODEL_ILLUMINATION_MIN_INTENSITY,
} from './model-illumination.js';
import { matAccent, matBody, matDark, matRim } from './geo.js';

const FALLBACK_PALETTES = {
  dark: {
    background: '#140d07',
    gridMajor: '#544337',
    gridMinor: '#3d332c',
  },
  light: {
    background: '#dfe3e8',
    gridMajor: '#98a2ad',
    gridMinor: '#c3cad2',
  },
};

export const WIREFRAME_COLORS = {
  dark: '#39ff14',
  light: '#0a7a32',
};

export function getWireframeAppearance(theme = 'dark') {
  const nextTheme = normalizeTheme(theme);
  if (nextTheme === 'light') {
    return {
      color: WIREFRAME_COLORS.light,
      opacity: 0.96,
      blending: THREE.NormalBlending,
      depthWrite: true,
    };
  }
  return {
    color: WIREFRAME_COLORS.dark,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function toHex(color) {
  return `#${color.getHexString()}`;
}

function shiftHsl(baseHex, { h = 0, s = 0, l = 0 } = {}) {
  const color = new THREE.Color(baseHex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  const hue = (hsl.h + h + 1) % 1;
  const sat = clamp01(hsl.s + s);
  const light = clamp01(hsl.l + l);
  color.setHSL(hue, sat, light);
  return toHex(color);
}



// Render-only appearance presets. Geometry, displayed dimensions, engineering
// material data, and damage/FEA heatmap colours are never touched here.
const APPEARANCE_PRESETS = {
  body: {
    dark: { color: '#3d332c', metalness: 0.75, roughness: 0.45 },
    light: { color: '#a55310', metalness: 0.6, roughness: 0.34 },
  },
  accent: {
    dark: { color: '#b76308', metalness: 0.6, roughness: 0.5 },
    light: { color: '#b86212', metalness: 0.62, roughness: 0.32 },
  },
  rim: {
    dark: { color: '#de822b', metalness: 0.8, roughness: 0.35 },
    light: { color: '#d68a24', metalness: 0.72, roughness: 0.26 },
  },
  dark: {
    dark: { color: '#271e18', metalness: 0.5, roughness: 0.6 },
    light: { color: '#63340d', metalness: 0.54, roughness: 0.44 },
  },
  shaft: {
    dark: { color: '#3d332c', metalness: 0.85, roughness: 0.35 },
    light: { color: '#9d4f0e', metalness: 0.66, roughness: 0.3 },
  },
  housing: {
    dark: { color: '#de822b', opacity: 0.22 },
    light: { color: '#c8731d', opacity: 0.24 },
  },
  plate: {
    dark: { color: '#271e18', metalness: 0.8, roughness: 0.5 },
    light: { color: '#73400e', metalness: 0.64, roughness: 0.38 },
  },
  edges: {
    dark: { color: '#181410' },
    light: { color: '#6b370b' },
  },
  'decorative-gear': {
    dark: { color: '#2A0E06', metalness: 0.8, roughness: 0.45 },
    light: { color: '#93420a', metalness: 0.64, roughness: 0.31 },
  },
};

function createRolePreset(baseHex, role, theme) {
  const isLight = normalizeTheme(theme) === 'light';
  const darkOffsets = {
    body: { h: 0, s: 0.02, l: 0 },
    accent: { h: 0.01, s: 0.06, l: 0.12 },
    rim: { h: 0.015, s: 0.08, l: 0.22 },
    dark: { h: -0.005, s: -0.04, l: -0.14 },
    shaft: { h: 0, s: 0, l: -0.03 },
    plate: { h: -0.005, s: -0.05, l: -0.16 },
    housing: { h: 0.01, s: 0.04, l: 0.18 },
    'decorative-gear': { h: -0.01, s: -0.02, l: -0.18 },
    edges: { h: -0.01, s: -0.1, l: -0.22 },
  };
  const lightOffsets = {
    body: { h: 0, s: -0.04, l: 0.16 },
    accent: { h: 0.01, s: -0.02, l: 0.24 },
    rim: { h: 0.015, s: 0, l: 0.32 },
    dark: { h: -0.005, s: -0.08, l: 0.04 },
    shaft: { h: 0, s: -0.03, l: 0.12 },
    plate: { h: -0.005, s: -0.08, l: 0.02 },
    housing: { h: 0.01, s: -0.03, l: 0.28 },
    'decorative-gear': { h: -0.01, s: -0.06, l: 0.0 },
    edges: { h: -0.01, s: -0.15, l: -0.08 },
  };
  const offsets = (isLight ? lightOffsets : darkOffsets)[role] || darkOffsets.body;
  const color = shiftHsl(baseHex, offsets);

  const basePreset = APPEARANCE_PRESETS[role]?.[isLight ? 'light' : 'dark'] || APPEARANCE_PRESETS.body[isLight ? 'light' : 'dark'];
  const preset = { ...basePreset, color };
  if (role === 'edges') {
    return { color };
  }
  if (role === 'housing') {
    return { color, opacity: basePreset.opacity ?? (isLight ? 0.24 : 0.22) };
  }
  return preset;
}

export function createAppearancePresets(baseColor) {
  if (!baseColor) return APPEARANCE_PRESETS;
  const color = new THREE.Color(baseColor);
  const baseHex = toHex(color);
  const roles = Object.keys(APPEARANCE_PRESETS);
  const presets = {};
  roles.forEach((role) => {
    presets[role] = {
      dark: createRolePreset(baseHex, role, 'dark'),
      light: createRolePreset(baseHex, role, 'light'),
    };
  });
  return presets;
}

const SHARED_APPEARANCE = [
  [matBody, 'body'],
  [matAccent, 'accent'],
  [matRim, 'rim'],
  [matDark, 'dark'],
];

// Light Mode base rig is deliberately restrained: the gear should read as
// moderately dark metallic orange before the bulb is enabled.
const LIGHT_LIGHTING = {
  ambient: { color: '#b9c4d0', intensity: 0.34 },
  key: { color: '#ffd9a8', intensity: 0.72 },
  fill: { color: '#8fb4d8', intensity: 0.24 },
  soft: { sky: '#e8edf3', ground: '#7a4318', intensity: 0.28 },
};

// Increasing the same slider in Light Mode moves the rig toward this deeper,
// warmer state instead of adding more brightness.
const LIGHT_SHADE_LIGHTING = {
  ambient: { color: '#7c6a5a', intensity: 0.14 },
  key: { color: '#d98b32', intensity: 0.38 },
  fill: { color: '#5a3a24', intensity: 0.14 },
  soft: { sky: '#b9a08a', ground: '#4a2608', intensity: 0.14 },
};

const LIGHT_REFLECTION_SCALE = 1;
const LIGHT_SHADE_REFLECTION_SCALE = 0.42;
const SHADE_EASING = 0.14;

const environmentCache = new WeakMap();

function normalizeTheme(theme = 'dark') {
  return theme === 'light' ? 'light' : 'dark';
}

function normalizeShade(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(
    1,
    Math.max(0, (numeric - MODEL_ILLUMINATION_MIN_INTENSITY) /
      (MODEL_ILLUMINATION_MAX_INTENSITY - MODEL_ILLUMINATION_MIN_INTENSITY))
  );
}

export function readThreeThemePalette(theme = 'dark') {
  const fallback = FALLBACK_PALETTES[theme] || FALLBACK_PALETTES.dark;
  if (typeof document === 'undefined') return fallback;

  const styles = getComputedStyle(document.documentElement);
  const read = (name, defaultValue) => styles.getPropertyValue(name).trim() || defaultValue;

  return {
    background: read('--viewport-bg', fallback.background),
    gridMajor: read('--viewport-grid-major', fallback.gridMajor),
    gridMinor: read('--viewport-grid-minor', fallback.gridMinor),
  };
}

function applyPreset(material, preset) {
  if (!material || !preset) return;
  let changed = false;

  if (preset.color && material.color && material.color.getHexString() !== preset.color.replace('#', '').toLowerCase()) {
    material.color.set(preset.color);
    changed = true;
  }
  if (preset.metalness !== undefined && material.metalness !== preset.metalness) {
    material.metalness = preset.metalness;
    changed = true;
  }
  if (preset.roughness !== undefined && material.roughness !== preset.roughness) {
    material.roughness = preset.roughness;
    changed = true;
  }
  if (preset.opacity !== undefined && material.opacity !== preset.opacity) {
    material.opacity = preset.opacity;
    changed = true;
  }

  if (changed) material.needsUpdate = true;
}

/**
 * Applies the theme-specific visual material presets. Shared geo.js materials
 * are updated in place so every cached/cloned generated component follows the
 * theme; scene-local materials opt in with userData.appearanceRole.
 */
export function applyModelAppearance(theme, scene, appearancePresets = APPEARANCE_PRESETS) {
  const nextTheme = normalizeTheme(theme);
  const presets = appearancePresets || APPEARANCE_PRESETS;
  const seen = new Set();

  SHARED_APPEARANCE.forEach(([material, role]) => {
    seen.add(material);
    applyPreset(material, presets[role]?.[nextTheme]);
  });

  if (!scene || typeof scene.traverse !== 'function') return;
  scene.traverse((node) => {
    const materials = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
    materials.forEach((material) => {
      const role = material?.userData?.appearanceRole;
      if (!role || seen.has(material)) return;
      seen.add(material);
      applyPreset(material, presets[role]?.[nextTheme]);
    });
  });
}

function createEnvironmentFace(index) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 64);

  if (index === 2) {
    gradient.addColorStop(0, '#dfe5ec');
    gradient.addColorStop(1, '#aeb8c4');
  } else if (index === 3) {
    gradient.addColorStop(0, '#7a5334');
    gradient.addColorStop(1, '#4a2f16');
  } else {
    gradient.addColorStop(0, '#c7cfd8');
    gradient.addColorStop(0.45, '#aab4c0');
    gradient.addColorStop(1, '#77828f');
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  if (index !== 2 && index !== 3) {
    const glow = ctx.createRadialGradient(20, 18, 2, 20, 18, 44);
    glow.addColorStop(0, 'rgba(255,255,255,0.22)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 64, 64);
  }
  return canvas;
}

function getLightEnvironment(renderer) {
  if (typeof document === 'undefined' || !renderer) return null;
  if (environmentCache.has(renderer)) return environmentCache.get(renderer).texture;

  const cube = new THREE.CubeTexture([0, 1, 2, 3, 4, 5].map(createEnvironmentFace));
  cube.encoding = THREE.sRGBEncoding;
  cube.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromCubemap(cube);
  pmrem.dispose();
  cube.dispose();

  const entry = { target, texture: target.texture };
  environmentCache.set(renderer, entry);
  return entry.texture;
}

function forEachSceneMaterial(scene, visit) {
  if (!scene || typeof scene.traverse !== 'function') return;
  scene.traverse((node) => {
    const materials = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
    materials.forEach(visit);
  });
}

function captureLights(lights) {
  const captured = {};
  Object.entries(lights || {}).forEach(([name, light]) => {
    if (light?.color && Number.isFinite(light.intensity)) {
      captured[name] = { light, color: light.color.clone(), intensity: light.intensity };
    }
  });
  return captured;
}

function mixColor(from, to, amount) {
  return new THREE.Color(from).lerp(new THREE.Color(to), amount);
}

function applyLighting(theme, capturedLights, softLight, shade) {
  if (theme !== 'light') {
    Object.values(capturedLights).forEach((base) => {
      base.light.color.copy(base.color);
      base.light.intensity = base.intensity;
    });
    if (softLight) softLight.visible = false;
    return;
  }

  const amount = Math.min(1, Math.max(0, shade));
  Object.entries(capturedLights).forEach(([name, base]) => {
    const from = LIGHT_LIGHTING[name];
    if (!from) {
      base.light.color.copy(base.color);
      base.light.intensity = base.intensity;
      return;
    }
    const to = LIGHT_SHADE_LIGHTING[name] || from;
    base.light.color.copy(mixColor(from.color, to.color, amount));
    base.light.intensity = THREE.MathUtils.lerp(from.intensity, to.intensity, amount);
  });

  if (!softLight) return;
  softLight.visible = true;
  softLight.color.copy(mixColor(LIGHT_LIGHTING.soft.sky, LIGHT_SHADE_LIGHTING.soft.sky, amount));
  softLight.groundColor.copy(mixColor(LIGHT_LIGHTING.soft.ground, LIGHT_SHADE_LIGHTING.soft.ground, amount));
  softLight.intensity = THREE.MathUtils.lerp(
    LIGHT_LIGHTING.soft.intensity,
    LIGHT_SHADE_LIGHTING.soft.intensity,
    amount
  );
}

function applyRendererAppearance(theme, renderer, original) {
  if (!renderer || !original) return;
  if (theme === 'light') {
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    return;
  }
  renderer.outputEncoding = original.outputEncoding;
  renderer.toneMapping = original.toneMapping;
  renderer.toneMappingExposure = original.toneMappingExposure;
}

/**
 * Keeps a Three.js scene background, material appearance, lighting, reflection
 * intensity, and renderer output in sync with the application theme without
 * rebuilding the scene. The illumination control is theme-aware: it brightens
 * the rig in Dark Mode and deepens it in Light Mode.
 */
export function createThreeThemeSync({
  scene,
  renderer,
  lights = {},
  background = true,
  appearancePresets = null,
  baseColor = null,
  backgroundColor = null,
} = {}) {
  let currentTheme = 'dark';
  let appliedTheme = null;
  let shade = 0;
  let targetShade = 0;
  let activePresets = appearancePresets || (baseColor ? createAppearancePresets(baseColor) : APPEARANCE_PRESETS);
  let backgroundOverride = backgroundColor || null;

  const capturedLights = captureLights(lights);
  const reflectionBase = new WeakMap();
  const originalEnvironment = scene?.environment ?? null;
  const originalRenderer = renderer ? {
    outputEncoding: renderer.outputEncoding,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
  } : null;

  let softLight = null;
  if (scene && Object.keys(capturedLights).length > 0) {
    softLight = new THREE.HemisphereLight(0xffffff, 0xc98736, 0);
    softLight.name = 'theme-soft-fill';
    softLight.visible = false;
    scene.add(softLight);
  }

  function rememberReflection(material) {
    if (!material || material.envMapIntensity === undefined) return false;
    if (!reflectionBase.has(material)) reflectionBase.set(material, material.envMapIntensity);
    return true;
  }

  function setReflectionIntensity(scale) {
    forEachSceneMaterial(scene, (material) => {
      if (!rememberReflection(material)) return;
      const value = reflectionBase.get(material) * scale;
      if (material.envMapIntensity !== value) material.envMapIntensity = value;
    });
  }

  function restoreReflectionIntensity() {
    forEachSceneMaterial(scene, (material) => {
      if (!rememberReflection(material)) return;
      const value = reflectionBase.get(material);
      if (material.envMapIntensity !== value) material.envMapIntensity = value;
    });
  }

  function applyCurrentLighting() {
    if (currentTheme === 'light') {
      applyLighting('light', capturedLights, softLight, shade);
      setReflectionIntensity(THREE.MathUtils.lerp(
        LIGHT_REFLECTION_SCALE,
        LIGHT_SHADE_REFLECTION_SCALE,
        shade
      ));
      return;
    }
    applyLighting('dark', capturedLights, softLight, 0);
    restoreReflectionIntensity();
  }

  function applyBackground(nextTheme) {
    if (!background) return;
    const palette = readThreeThemePalette(nextTheme);
    const bg = backgroundOverride || palette.background;
    const backgroundThreeColor = new THREE.Color(bg);
    scene.background = backgroundThreeColor;
    renderer.setClearColor(backgroundThreeColor, 1);
  }

  return {
    update(theme, force = false) {
      const nextTheme = normalizeTheme(theme);
      if (nextTheme === 'dark' && currentTheme === 'light') {
        shade = 0;
        targetShade = 0;
      }
      currentTheme = nextTheme;
      if (nextTheme === appliedTheme && !force) return;
      appliedTheme = nextTheme;

      applyBackground(nextTheme);
      applyModelAppearance(nextTheme, scene, activePresets);
      applyCurrentLighting();
      scene.environment = nextTheme === 'light' ? getLightEnvironment(renderer) : originalEnvironment;
      applyRendererAppearance(nextTheme, renderer, originalRenderer);
    },

    setAppearance({ baseColor: nextBaseColor, appearancePresets: nextPresets, backgroundColor: nextBackground } = {}) {
      if (nextBackground !== undefined) backgroundOverride = nextBackground || null;
      if (nextPresets) activePresets = nextPresets;
      else if (nextBaseColor !== undefined) activePresets = nextBaseColor ? createAppearancePresets(nextBaseColor) : APPEARANCE_PRESETS;
      if (appliedTheme) {
        applyBackground(appliedTheme);
        applyModelAppearance(appliedTheme, scene, activePresets);
      }
    },

    setIllumination({
      enabled = false,
      intensity = DEFAULT_MODEL_ILLUMINATION_INTENSITY,
      theme = currentTheme,
      immediate = false,
    } = {}) {
      const illuminationTheme = normalizeTheme(theme);
      if (illuminationTheme === 'dark') {
        shade = 0;
        targetShade = 0;
        applyCurrentLighting();
        return;
      }

      targetShade = enabled ? normalizeShade(intensity) : 0;
      shade = immediate
        ? targetShade
        : THREE.MathUtils.lerp(shade, targetShade, SHADE_EASING);
      if (Math.abs(targetShade - shade) < 0.001) shade = targetShade;
      applyCurrentLighting();
    },

    dispose() {
      restoreReflectionIntensity();
      if (softLight?.parent) softLight.parent.remove(softLight);
      softLight = null;
    },
  };
}
