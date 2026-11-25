import * as THREE from 'three';

export const DEFAULT_MODEL_ILLUMINATION_INTENSITY = 2.4;
export const MODEL_ILLUMINATION_MIN_INTENSITY = 0.4;
export const MODEL_ILLUMINATION_MAX_INTENSITY = 4;
export const MODEL_ILLUMINATION_INTENSITY_STEP = 0.1;

const OVERHEAD_LIGHT_COLOR = 0xfff4e6;
const INTENSITY_EASING = 0.18;

function clampIntensity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MODEL_ILLUMINATION_INTENSITY;
  return Math.min(
    MODEL_ILLUMINATION_MAX_INTENSITY,
    Math.max(MODEL_ILLUMINATION_MIN_INTENSITY, numeric)
  );
}

function getBounds(bounds) {
  if (bounds && typeof bounds.getBoundingSphere === 'function' && !bounds.isEmpty()) {
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    return { center: sphere.center.clone(), radius: Math.max(sphere.radius, 1) };
  }
  return { center: new THREE.Vector3(), radius: 5 };
}

function normalizeTheme(theme = 'dark') {
  return theme === 'light' ? 'light' : 'dark';
}

/**
 * Adds a soft overhead directional light for Dark Mode and coordinates with
 * the theme sync in Light Mode, where the same control deepens the model's
 * lighting instead of adding brightness. The light has no shadows and is
 * positioned from the model's bounding sphere; no CSS filter is involved.
 */
export function createModelIllumination(scene, options = {}) {
  const { center, radius } = getBounds(options.bounds);
  const themeSync = options.themeSync || null;
  let currentTheme = normalizeTheme(options.theme);
  let enabled = Boolean(options.enabled);
  let currentIntensity = clampIntensity(options.intensity);
  let targetIntensity = currentTheme === 'dark' && enabled ? currentIntensity : 0;
  let appliedIntensity = currentIntensity;

  const light = new THREE.DirectionalLight(OVERHEAD_LIGHT_COLOR, appliedIntensity);
  light.name = 'model-illumination';
  light.castShadow = false;

  const towardCamera = new THREE.Vector3(0, 0, 1);
  if (options.camera && typeof options.camera.getWorldDirection === 'function') {
    options.camera.getWorldDirection(towardCamera).negate();
  }
  const offset = new THREE.Vector3(0, 1.8, 0)
    .addScaledVector(towardCamera, 0.8)
    .normalize()
    .multiplyScalar(radius * 2.4 + 6);
  light.position.copy(center).add(offset);
  light.target.position.copy(center);
  light.visible = currentTheme === 'dark' && enabled;

  scene.add(light);
  scene.add(light.target);

  function applyLight(immediate = false) {
    if (immediate) {
      appliedIntensity = targetIntensity;
    } else {
      appliedIntensity = THREE.MathUtils.lerp(appliedIntensity, targetIntensity, INTENSITY_EASING);
      if (Math.abs(targetIntensity - appliedIntensity) < 0.001) appliedIntensity = targetIntensity;
    }
    light.intensity = Math.max(appliedIntensity, 0);
    light.visible = currentTheme === 'dark' && (enabled || appliedIntensity > 0.01);
  }

  function syncTheme(immediate = false) {
    if (!themeSync || typeof themeSync.setIllumination !== 'function') return;
    themeSync.setIllumination({
      enabled: currentTheme === 'light' && enabled,
      intensity: currentIntensity,
      theme: currentTheme,
      immediate,
    });
  }

  syncTheme(true);

  return {
    light,
    update(next = {}, immediate = false) {
      if (next.theme !== undefined) {
        const nextTheme = normalizeTheme(next.theme);
        if (nextTheme !== currentTheme && nextTheme === 'light') appliedIntensity = 0;
        currentTheme = nextTheme;
      }
      if (next.enabled !== undefined) enabled = Boolean(next.enabled);
      if (next.intensity !== undefined) currentIntensity = clampIntensity(next.intensity);
      targetIntensity = currentTheme === 'dark' && enabled ? currentIntensity : 0;

      applyLight(immediate);
      syncTheme(immediate);
    },
    dispose() {
      scene.remove(light);
      scene.remove(light.target);
    },
  };
}
