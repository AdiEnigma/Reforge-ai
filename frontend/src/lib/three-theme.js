import * as THREE from 'three';

const FALLBACK_PALETTES = {
  dark: {
    background: '#140d07',
    gridMajor: '#544337',
    gridMinor: '#3d332c',
  },
  light: {
    background: '#f7f5f0',
    gridMajor: '#b8aa98',
    gridMinor: '#d8d0c3',
  },
};

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

/**
 * Keeps a Three.js scene background and renderer clear colour in sync with the
 * application theme without rebuilding the scene.
 */
export function createThreeThemeSync({ scene, renderer }) {
  let appliedTheme = null;

  return {
    update(theme) {
      const nextTheme = theme === 'light' ? 'light' : 'dark';
      if (nextTheme === appliedTheme) return;
      appliedTheme = nextTheme;

      const palette = readThreeThemePalette(nextTheme);
      const background = new THREE.Color(palette.background);
      scene.background = background;
      renderer.setClearColor(background, 1);
    },
  };
}
