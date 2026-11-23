import { resolveComponentType } from './reconstruct.js';

export const PARAM_DEFINITIONS = [
  { key: 'outerDiameter', label: 'Outer Ø', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'innerDiameter', label: 'Inner Ø (bore)', unit: 'mm', min: 0.5, step: 0.5, isDim: true },
  { key: 'height', label: 'Height / Length', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'width', label: 'Width', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'length', label: 'Length', unit: 'mm', min: 1, step: 0.5, isDim: true },
  { key: 'thickness', label: 'Thickness / Width', unit: 'mm', min: 0.5, step: 0.5, isDim: true },
  { key: 'teeth', label: 'Teeth', unit: 'count', min: 6, max: 120, step: 1, isDim: false, isInteger: true },
  { key: 'module', label: 'Module', unit: 'mm', min: 0.2, max: 20, step: 0.1, isDim: false },
  { key: 'helixAngle', label: 'Helix Angle', unit: 'deg', min: 1, max: 45, step: 1, isDim: false },
];

const EPSILON = 0.0001;
const DIMENSION_KEYS = new Set(['outerDiameter', 'innerDiameter', 'height', 'width', 'length', 'thickness']);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > EPSILON;
}

function firstNumber(...values) {
  return values.find(positive);
}

function cloneAnalysis(analysis) {
  return JSON.parse(JSON.stringify(analysis));
}

function firstAxialSegment(recipe) {
  return (Array.isArray(recipe?.axialSegments) ? recipe.axialSegments : [])
    .find((segment) => segment && typeof segment === 'object') || null;
}

function outlineSpan(recipe, axis) {
  const outline = Array.isArray(recipe?.outline) ? recipe.outline : [];
  if (outline.length < 2) return null;
  const values = outline.map((point) => finite(point?.[axis]) ? point[axis] : null).filter(finite);
  if (values.length < 2) return null;
  return Math.max(...values) - Math.min(...values);
}

/** Reads a parameter from analysis dimensions, top-level fields, or the geometry recipe. */
export function getParameterValue(analysis, key) {
  if (!analysis || typeof analysis !== 'object') return null;
  const dims = analysis.dimensions || {};
  const recipe = analysis.geometryRecipe || {};
  const gear = recipe.gear || {};
  const flange = recipe.flange || {};
  const shaft = recipe.shaft || {};
  const segment = firstAxialSegment(recipe);
  const centerHole = (Array.isArray(recipe.holes) ? recipe.holes : [])
    .find((hole) => Math.abs(hole?.cx || 0) < EPSILON && Math.abs(hole?.cy || 0) < EPSILON);

  switch (key) {
    case 'outerDiameter':
      return firstNumber(
        dims.outerDiameter,
        flange.outerDiameter,
        gear.outerDiameter,
        positive(gear.outerRadius) ? gear.outerRadius * 2 : null,
        segment?.radius ? segment.radius * 2 : null
      ) ?? null;
    case 'innerDiameter':
      return firstNumber(
        dims.innerDiameter,
        flange.innerDiameter,
        positive(gear.boreRadius) ? gear.boreRadius * 2 : null,
        positive(recipe.boreRadius) ? recipe.boreRadius * 2 : null,
        positive(segment?.innerRadius) ? segment.innerRadius * 2 : null,
        centerHole?.radius ? centerHole.radius * 2 : null
      ) ?? null;
    case 'height':
      return firstNumber(dims.height, dims.thickness, gear.faceWidth, flange.height, flange.thickness, recipe.depth, shaft.length) ?? null;
    case 'width':
      return firstNumber(dims.width, outlineSpan(recipe, 'y'), dims.outerDiameter) ?? null;
    case 'length':
      return firstNumber(dims.length, dims.height, shaft.length, outlineSpan(recipe, 'x'), recipe.depth) ?? null;
    case 'thickness':
      return firstNumber(dims.thickness, flange.thickness, recipe.depth, gear.faceWidth, flange.height) ?? null;
    case 'teeth':
      return firstNumber(analysis.teeth, dims.teeth, gear.teeth, segment?.teeth) ?? null;
    case 'module':
      return firstNumber(analysis.module, dims.module, gear.module, segment?.module) ?? null;
    case 'helixAngle':
      return firstNumber(analysis.helixAngle, dims.helixAngle, gear.helixAngle, segment?.helixAngle) ?? null;
    default:
      return null;
  }
}

export function isParamActive(def, analysis) {
  const value = getParameterValue(analysis, def.key);
  if (!finite(value)) return false;
  if (def.key === 'helixAngle' || def.key === 'innerDiameter') return value > 0;
  if (def.key === 'teeth') return value >= 6;
  return value > 0;
}

function roundValue(value, def) {
  if (!finite(value)) return null;
  let result = value;
  if (def.isInteger) result = Math.round(result);
  else if (positive(def.step)) result = Math.round(result / def.step) * def.step;

  if (finite(def.min)) result = Math.max(def.min, result);
  if (finite(def.max)) result = Math.min(def.max, result);
  return Number(result.toFixed(4));
}

function hasChange(changes, key) {
  return Object.prototype.hasOwnProperty.call(changes, key) && finite(changes[key]);
}

function changedKeys(changes) {
  return Object.keys(changes || {}).filter((key) => hasChange(changes, key));
}

function makeRecommendationCollector(analysis, changes, output) {
  const used = new Set(changedKeys(changes));

  return function recommend(key, value, reason) {
    const def = PARAM_DEFINITIONS.find((item) => item.key === key);
    if (!def || used.has(key) || !isParamActive(def, analysis)) return;
    const rounded = roundValue(value, def);
    const baseline = getParameterValue(analysis, key);
    if (rounded == null || !finite(baseline) || Math.abs(rounded - baseline) < EPSILON) return;
    if (output.some((item) => item.key === key)) return;
    used.add(key);
    output.push({
      key,
      value: rounded,
      baseline,
      reason,
      sourceKeys: changedKeys(changes),
    });
  };
}

function scaledValue(analysis, changes, key, ratio, reason) {
  const baseline = getParameterValue(analysis, key);
  if (!positive(baseline) || !finite(ratio)) return null;
  return { value: baseline * ratio, reason };
}

/**
 * Derives opt-in recommendations from the parameters the user actually edited.
 * Recommendations are never written back into the analysis or the 3D model here.
 */
export function getParameterRecommendations(analysis, changes = {}) {
  if (!analysis || !changes) return [];
  const keys = changedKeys(changes);
  if (keys.length === 0) return [];

  const recommendations = [];
  const recommend = makeRecommendationCollector(analysis, changes, recommendations);
  const type = resolveComponentType(analysis);
  const isGear = [
    'compound gear', 'pinion shaft', 'bevel gear', 'helical gear', 'spur gear', 'worm gear',
  ].includes(type);
  const isShaft = ['stepped shaft', 'cylinder/shaft', 'flanged shaft', 'pinion shaft'].includes(type);
  const isPlate = ['simple bracket', 'other'].includes(type);
  const get = (key) => getParameterValue(analysis, key);
  const ratioFor = (key) => {
    const baseline = get(key);
    return hasChange(changes, key) && positive(baseline) ? changes[key] / baseline : null;
  };
  const firstChangedRatio = (...keys) => {
    for (const key of keys) {
      const ratio = ratioFor(key);
      if (finite(ratio) && ratio > EPSILON) return { key, ratio };
    }
    return null;
  };

  const odChange = ratioFor('outerDiameter');
  const idChange = ratioFor('innerDiameter');
  const lengthChange = ratioFor('length');
  const widthChange = ratioFor('width');
  const axialChange = firstChangedRatio('height', 'thickness');
  const planarChange = firstChangedRatio('length', 'width');

  if (isGear) {
    const teeth = get('teeth');
    const module = get('module');
    const outerDiameter = get('outerDiameter');
    const teethChanged = hasChange(changes, 'teeth');
    const moduleChanged = hasChange(changes, 'module');
    const odChanged = hasChange(changes, 'outerDiameter');

    if (teethChanged && positive(module) && !odChanged) {
      recommend('outerDiameter', module * (changes.teeth + 2),
        `Gear outside diameter follows module × (teeth + 2); teeth changed to ${changes.teeth}.`);
    }
    if (moduleChanged && positive(teeth) && !odChanged) {
      recommend('outerDiameter', changes.module * (teeth + 2),
        'Gear outside diameter follows module × (teeth + 2) so the tooth form stays matched.');
    }
    if (odChanged && positive(teeth) && !moduleChanged) {
      recommend('module', changes.outerDiameter / (teeth + 2),
        'Module must follow the new outside diameter for the same tooth count.');
    }

    const diameterRatio = odChanged && positive(outerDiameter)
      ? changes.outerDiameter / outerDiameter
      : moduleChanged && positive(module)
        ? changes.module / module
        : teethChanged && positive(module) && positive(outerDiameter)
          ? (module * (changes.teeth + 2)) / outerDiameter
          : null;

    if (diameterRatio && positive(diameterRatio)) {
      const face = scaledValue(analysis, changes, 'thickness', diameterRatio,
        'Face width is commonly scaled with gear diameter to keep the tooth proportion.');
      if (face) recommend('thickness', face.value, face.reason);
      const height = scaledValue(analysis, changes, 'height', diameterRatio,
        'Axial face width is commonly scaled with gear diameter.');
      if (height) recommend('height', height.value, height.reason);
      const bore = scaledValue(analysis, changes, 'innerDiameter', diameterRatio,
        'Hub/bore proportion is based on gear diameter — check mating shaft fit before applying.');
      if (bore) recommend('innerDiameter', bore.value, bore.reason);
    }

    if (hasChange(changes, 'height') && !hasChange(changes, 'thickness')) {
      const thickness = get('thickness');
      if (positive(thickness)) {
        recommend('thickness', thickness * (changes.height / get('height')),
          'Height and thickness both describe the gear face width in this model.');
      }
    }
    if (hasChange(changes, 'thickness') && !hasChange(changes, 'height')) {
      const height = get('height');
      if (positive(height)) {
        recommend('height', height * (changes.thickness / get('thickness')),
          'Height and thickness both describe the gear face width in this model.');
      }
    }
  } else if (type === 'flange' || type === 'bearing' || type === 'cap/bushing') {
    if (odChange && positive(odChange)) {
      const bore = scaledValue(analysis, changes, 'innerDiameter', odChange,
        'Bore-to-OD proportion is maintained — verify shaft and housing fit.');
      if (bore) recommend('innerDiameter', bore.value, bore.reason);
      const thickness = scaledValue(analysis, changes, 'thickness', odChange,
        'Flange/ring section thickness is proportional to its outside diameter.');
      if (thickness) recommend('thickness', thickness.value, thickness.reason);
      const height = scaledValue(analysis, changes, 'height', odChange,
        'Axial height is scaled with the outside diameter to preserve the envelope.');
      if (height) recommend('height', height.value, height.reason);
    }
    if (hasChange(changes, 'height') && !hasChange(changes, 'thickness')) {
      const thickness = get('thickness');
      if (positive(thickness)) recommend('thickness', thickness * (changes.height / get('height')),
        'Height and thickness both drive the axial section of this ring-like part.');
    }
    if (hasChange(changes, 'thickness') && !hasChange(changes, 'height')) {
      const height = get('height');
      if (positive(height)) recommend('height', height * (changes.thickness / get('thickness')),
        'Height and thickness both drive the axial section of this ring-like part.');
    }
  } else if (isShaft) {
    if (odChange && positive(odChange)) {
      const bore = scaledValue(analysis, changes, 'innerDiameter', odChange,
        'Hollow-shaft bore is proportional to the outside diameter.');
      if (bore) recommend('innerDiameter', bore.value, bore.reason);
      const thickness = scaledValue(analysis, changes, 'thickness', odChange,
        'Shoulder/collar section follows the shaft diameter.');
      if (thickness) recommend('thickness', thickness.value, thickness.reason);
    }
    if (hasChange(changes, 'length') && !hasChange(changes, 'height')) {
      const height = get('height');
      if (positive(height)) recommend('height', changes.length * (height / get('length')),
        'Height and length both describe the axial span of this shaft.');
    }
    if (hasChange(changes, 'height') && !hasChange(changes, 'length')) {
      const length = get('length');
      if (positive(length)) recommend('length', changes.height * (length / get('height')),
        'Height and length both describe the axial span of this shaft.');
    }
  } else if (isPlate) {
    if (hasChange(changes, 'length') && !hasChange(changes, 'width')) {
      const width = get('width');
      if (positive(width)) {
        recommend('width', width * (changes.length / get('length')),
          `Length changed by ${(changes.length / get('length')).toFixed(2)}×; breadth should scale by the same ratio to preserve the plate proportions.`);
      }
    }
    if (hasChange(changes, 'width') && !hasChange(changes, 'length')) {
      const length = get('length');
      if (positive(length)) {
        recommend('length', length * (changes.width / get('width')),
          `Width changed by ${(changes.width / get('width')).toFixed(2)}×; length should scale by the same ratio to preserve the plate proportions.`);
      }
    }
    if (planarChange && positive(planarChange.ratio)) {
      const thickness = scaledValue(analysis, changes, 'thickness', planarChange.ratio,
        'Plate thickness follows the in-plane scale to keep the section proportion.');
      if (thickness) recommend('thickness', thickness.value, thickness.reason);
      const height = scaledValue(analysis, changes, 'height', planarChange.ratio,
        'Plate height follows the in-plane scale to keep the envelope proportion.');
      if (height) recommend('height', height.value, height.reason);
    }
    if (odChange && positive(odChange)) {
      const width = scaledValue(analysis, changes, 'width', odChange,
        'Overall size changed; width should follow the same scale factor.');
      if (width) recommend('width', width.value, width.reason);
      const length = scaledValue(analysis, changes, 'length', odChange,
        'Overall size changed; length should follow the same scale factor.');
      if (length) recommend('length', length.value, length.reason);
    }
  } else {
    if (odChange && positive(odChange)) {
      const bore = scaledValue(analysis, changes, 'innerDiameter', odChange,
        'Bore-to-OD proportion is maintained — verify the mating interface.');
      if (bore) recommend('innerDiameter', bore.value, bore.reason);
    }
    if (lengthChange && positive(lengthChange)) {
      const width = scaledValue(analysis, changes, 'width', lengthChange,
        'Length and width define the same planar envelope.');
      if (width) recommend('width', width.value, width.reason);
    }
    if (widthChange && positive(widthChange)) {
      const length = scaledValue(analysis, changes, 'length', widthChange,
        'Width and length define the same planar envelope.');
      if (length) recommend('length', length.value, length.reason);
    }
    if (axialChange && positive(axialChange.ratio)) {
      const otherKey = axialChange.key === 'height' ? 'thickness' : 'height';
      const other = scaledValue(analysis, changes, otherKey, axialChange.ratio,
        'Height and thickness both describe the axial section in this model.');
      if (other) recommend(otherKey, other.value, other.reason);
    }
  }

  return recommendations;
}

function scaleNumber(target, key, ratio) {
  if (!finite(target[key]) || !finite(ratio)) return;
  target[key] = Number((target[key] * ratio).toFixed(4));
}

function firstChanged(changes, keys) {
  for (const key of keys) {
    if (hasChange(changes, key)) return key;
  }
  return null;
}

/**
 * Writes confirmed scenario values back into the analysis and every geometry
 * representation that can drive the 3D model or CAD export. Unselected values
 * are never touched.
 */
export function applyScenarioToAnalysis(analysis, changes = {}) {
  if (!analysis) return null;
  const keys = changedKeys(changes);
  if (keys.length === 0) return analysis;

  const next = cloneAnalysis(analysis);
  const recipe = next.geometryRecipe;
  const get = (key) => getParameterValue(analysis, key);
  const ratioFor = (key) => (hasChange(changes, key) && positive(get(key)) ? changes[key] / get(key) : 1);

  for (const def of PARAM_DEFINITIONS) {
    if (!hasChange(changes, def.key)) continue;
    if (def.isDim) next.dimensions = { ...(next.dimensions || {}), [def.key]: changes[def.key] };
    else next[def.key] = changes[def.key];
  }

  if (!recipe || typeof recipe !== 'object') return next;

  const odRatio = ratioFor('outerDiameter');
  const idRatio = ratioFor('innerDiameter');
  const axialKey = firstChanged(changes, ['length', 'height', 'thickness']);
  const axialRatio = axialKey ? ratioFor(axialKey) : 1;
  const lengthChanged = hasChange(changes, 'length');
  const widthChanged = hasChange(changes, 'width');
  const xRatio = lengthChanged ? ratioFor('length') : (widthChanged ? ratioFor('width') : odRatio);
  const yRatio = widthChanged ? ratioFor('width') : (lengthChanged ? 1 : odRatio);
  const faceValue = hasChange(changes, 'height') ? changes.height : changes.thickness;

  if (recipe.gear && typeof recipe.gear === 'object') {
    const gear = recipe.gear;
    if (hasChange(changes, 'teeth')) gear.teeth = Math.round(changes.teeth);
    if (hasChange(changes, 'module')) gear.module = changes.module;
    if (hasChange(changes, 'helixAngle')) gear.helixAngle = changes.helixAngle;
    if (hasChange(changes, 'innerDiameter')) gear.boreRadius = changes.innerDiameter / 2;
    if (hasChange(changes, 'outerDiameter')) {
      gear.outerDiameter = changes.outerDiameter;
      gear.outerRadius = changes.outerDiameter / 2;
    }
    if (finite(faceValue)) gear.faceWidth = faceValue;
    if (Array.isArray(gear.stages)) {
      gear.stages.forEach((stage, index) => {
        if (!stage || typeof stage !== 'object') return;
        scaleNumber(stage, 'outerDiameter', odRatio);
        scaleNumber(stage, 'faceWidth', axialRatio);
        if (hasChange(changes, 'module')) stage.module = changes.module;
        if (index === 0 && hasChange(changes, 'teeth')) stage.teeth = Math.round(changes.teeth);
      });
    }
  }

  if (recipe.flange && typeof recipe.flange === 'object') {
    const flange = recipe.flange;
    for (const key of ['outerDiameter', 'innerDiameter', 'thickness', 'height']) {
      if (hasChange(changes, key)) flange[key] = changes[key];
    }
    for (const key of ['boltCircleDiameter', 'boltHoleDiameter', 'bossDiameter']) {
      scaleNumber(flange, key, odRatio);
    }
    scaleNumber(flange, 'bossHeight', axialRatio);
  }

  if (recipe.shaft && typeof recipe.shaft === 'object') {
    const shaft = recipe.shaft;
    if (hasChange(changes, 'outerDiameter')) shaft.diameter = changes.outerDiameter;
    if (hasChange(changes, 'length')) shaft.length = changes.length;
    else if (hasChange(changes, 'height')) shaft.length = changes.height;
    scaleNumber(shaft, 'driveJournalDiameter', odRatio);
    scaleNumber(shaft, 'supportJournalDiameter', odRatio);
  }

  if (hasChange(changes, 'innerDiameter') && finite(recipe.boreRadius)) {
    recipe.boreRadius = changes.innerDiameter / 2;
  }
  const depthKey = firstChanged(changes, ['thickness', 'height', 'length']);
  if (depthKey) recipe.depth = changes[depthKey];

  if (Array.isArray(recipe.axialSegments)) {
    recipe.axialSegments.forEach((segment) => {
      if (!segment || typeof segment !== 'object') return;
      scaleNumber(segment, 'radius', odRatio);
      scaleNumber(segment, 'innerRadius', idRatio);
      scaleNumber(segment, 'zStart', axialRatio);
      scaleNumber(segment, 'zEnd', axialRatio);
      if (hasChange(changes, 'teeth')) segment.teeth = Math.round(changes.teeth);
      if (hasChange(changes, 'module')) segment.module = changes.module;
      if (hasChange(changes, 'helixAngle')) segment.helixAngle = changes.helixAngle;
    });
  }

  if (Array.isArray(recipe.revolvedProfile)) {
    recipe.revolvedProfile.forEach((point) => {
      if (!point || typeof point !== 'object') return;
      scaleNumber(point, 'radius', odRatio);
      scaleNumber(point, 'z', axialRatio);
    });
  }

  const outlineXRatio = lengthChanged || widthChanged ? xRatio : odRatio;
  const outlineYRatio = widthChanged ? yRatio : (lengthChanged ? 1 : odRatio);
  if (Array.isArray(recipe.outline)) {
    recipe.outline.forEach((point) => {
      if (!point || typeof point !== 'object') return;
      scaleNumber(point, 'x', outlineXRatio);
      scaleNumber(point, 'y', outlineYRatio);
    });
  }

  if (Array.isArray(recipe.holes)) {
    recipe.holes.forEach((hole) => {
      if (!hole || typeof hole !== 'object') return;
      const isCenter = Math.abs(hole.cx || 0) < EPSILON && Math.abs(hole.cy || 0) < EPSILON;
      if (isCenter) scaleNumber(hole, 'radius', idRatio);
      else {
        scaleNumber(hole, 'cx', outlineXRatio);
        scaleNumber(hole, 'cy', outlineYRatio);
        scaleNumber(hole, 'radius', (outlineXRatio + outlineYRatio) / 2);
      }
    });
  }

  if (Array.isArray(recipe.primitives)) {
    recipe.primitives.forEach((primitive) => {
      if (!primitive || typeof primitive !== 'object') return;
      switch (primitive.kind) {
        case 'box':
          scaleNumber(primitive, 'width', outlineXRatio);
          scaleNumber(primitive, 'height', outlineYRatio);
          scaleNumber(primitive, 'depth', axialRatio);
          break;
        case 'cylinder':
        case 'cone':
          scaleNumber(primitive, 'radius', odRatio);
          scaleNumber(primitive, 'height', axialRatio);
          break;
        case 'sphere':
          scaleNumber(primitive, 'radius', odRatio);
          break;
        case 'torus':
          scaleNumber(primitive, 'radius', odRatio);
          scaleNumber(primitive, 'tube', odRatio);
          break;
        default:
          break;
      }
    });
  }

  if (Array.isArray(recipe.meshData?.vertices)) {
    recipe.meshData.vertices = recipe.meshData.vertices.map((value, index) => (
      finite(value) ? Number((value * (index % 3 === 0 ? outlineXRatio : index % 3 === 1 ? outlineYRatio : axialRatio)).toFixed(4)) : value
    ));
  }

  return next;
}

export function hasScenarioChanges(changes = {}) {
  return changedKeys(changes).length > 0;
}

/** Geometry fields consumed by the manufacturing decision and cost panels. */
export function getGeometryDecisionOverrides(analysis) {
  const overrides = {};
  for (const key of ['outerDiameter', 'innerDiameter', 'height', 'teeth']) {
    const value = getParameterValue(analysis, key);
    if (finite(value)) overrides[key] = value;
  }
  return overrides;
}
