import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync(new URL('../main.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('theme switch adds and removes the animation class', () => {
  assert.match(mainSource, /classList\.add\(['"]theme-animating['"]\)/);
  assert.match(mainSource, /classList\.remove\(['"]theme-animating['"]\)/);
  assert.match(mainSource, /setTimeout\(\(\) =>[\s\S]*?classList\.remove\(['"]theme-animating['"]\)/);
});

test('theme animation transitions every visible surface property', () => {
  assert.match(stylesSource, /html\.theme-animating\s*\*/);
  assert.match(stylesSource, /html\.theme-animating\s*\*::before/);
  assert.match(stylesSource, /html\.theme-animating\s*\*::after/);
  assert.match(
    stylesSource,
    /transition-property:\s*background-color,\s*border-color,\s*color,\s*fill,\s*stroke,\s*box-shadow,\s*opacity/
  );
  assert.match(stylesSource, /transition-duration:\s*\.32s/);
});

test('theme animation respects reduced motion', () => {
  assert.match(stylesSource, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});
