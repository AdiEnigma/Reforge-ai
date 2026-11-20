import * as THREE from 'three';

export const DEFAULT_MODEL_ILLUMINATION_INTENSITY = 2.4;
export const MODEL_ILLUMINATION_MIN_INTENSITY = 0.4;
export const MODEL_ILLUMINATION_MAX_INTENSITY = 4;
export const MODEL_ILLUMINATION_INTENSITY_STEP = 0.1;

const OVERHEAD_LIGHT_COLOR = 0xfff4e6;

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

/**
 * Adds a soft overhead directional light positioned from the model's bounding
 * box. The light has no shadows and enough intensity to reveal metallic
 * MeshStandardMaterial / MeshPhysicalMaterial surfaces without a CSS filter.
 */
export function createModelIllumination(scene, options = {}) {
  const { center, radius } = getBounds(options.bounds);
  const light = new THREE.DirectionalLight(OVERHEAD_LIGHT_COLOR, clampIntensity(options.intensity));
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
  light.visible = Boolean(options.enabled);

  scene.add(light);
  scene.add(light.target);

  return {
    light,
    update(next = {}) {
      const enabled = next.enabled === undefined ? light.visible : next.enabled;
      const intensity = next.intensity === undefined ? light.intensity : next.intensity;
      light.visible = Boolean(enabled);
      light.intensity = clampIntensity(intensity);
    },
    dispose() {
      scene.remove(light);
      scene.remove(light.target);
    },
  };
}
