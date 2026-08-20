/**
 * engineering-analysis.js
 * Deterministic engineering simulation and sensitivity analysis engine.
 */

import { computeManufacturingIntelligence, resolveMaterial } from "./manufacturing.js";
import { estimateVolumeCm3 } from "./geometry-volume.js";

/**
 * Calculates percentage relative change: ((newVal - baseVal) / baseVal) * 100
 */
function calcRelativeChange(newVal, baseVal) {
  if (typeof baseVal !== "number" || typeof newVal !== "number" || !isFinite(baseVal) || !isFinite(newVal)) return 0;
  if (Math.abs(baseVal) < 1e-6) return 0;
  return Math.round(((newVal - baseVal) / baseVal) * 1000) / 10;
}

/**
 * Deep clones an object safely.
 */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

/**
 * Deterministically simulates hypothetical geometry, material, or quantity modifications.
 */
export function simulateEngineeringChange({ analysis, modifications = [], quantity = 10 }) {
  if (!analysis || typeof analysis !== "object") {
    throw new Error("analysis must be a valid object.");
  }

  const baseQty = Math.max(1, Math.min(100000, Number(quantity) || 10));
  const baseAnalysis = clone(analysis);

  const modifiedAnalysis = clone(analysis);
  let targetQty = baseQty;
  const appliedMods = [];

  for (const mod of Array.isArray(modifications) ? modifications : []) {
    if (!mod || typeof mod !== "object") continue;

    if (mod.type === "change_dimension" && mod.target && typeof mod.value === "number" && mod.value > 0) {
      const target = mod.target;
      const val = mod.value;
      if (!modifiedAnalysis.dimensions) modifiedAnalysis.dimensions = {};
      modifiedAnalysis.dimensions[target] = val;

      // Also update corresponding geometryRecipe if applicable
      const recipe = modifiedAnalysis.geometryRecipe;
      if (recipe) {
        if (target === "innerDiameter") {
          const boreRad = val / 2;
          if (recipe.gear) recipe.gear.boreRadius = boreRad;
          if (Array.isArray(recipe.holes) && recipe.holes.length > 0) {
            // update central hole
            const centralHole = recipe.holes.find((h) => Math.abs(h.cx || 0) < 0.1 && Math.abs(h.cy || 0) < 0.1);
            if (centralHole) centralHole.radius = boreRad;
          }
        } else if (target === "outerDiameter" && recipe.style === "revolved" && Array.isArray(recipe.revolvedProfile)) {
          const baseMaxR = Math.max(...recipe.revolvedProfile.map((p) => p.radius || 0));
          if (baseMaxR > 0) {
            const scale = (val / 2) / baseMaxR;
            recipe.revolvedProfile.forEach((p) => { p.radius = Math.round(p.radius * scale * 10) / 10; });
          }
        } else if (target === "height" || target === "length") {
          if (recipe.depth) recipe.depth = val;
          if (recipe.gear?.faceWidth) recipe.gear.faceWidth = val;
        }
      }
      appliedMods.push({ type: "dimension", target, value: val });
    } else if (mod.type === "change_quantity" && typeof mod.value === "number" && mod.value >= 1) {
      targetQty = Math.max(1, Math.min(100000, Math.round(mod.value)));
      appliedMods.push({ type: "quantity", value: targetQty });
    } else if (mod.type === "change_material" && typeof mod.value === "string") {
      modifiedAnalysis.materialEstimate = mod.value;
      appliedMods.push({ type: "material", value: mod.value });
    }
  }

  // Calculate baseline & modified manufacturing intelligence
  const original = computeManufacturingIntelligence({ analysis: baseAnalysis, quantity: baseQty });
  const modified = computeManufacturingIntelligence({ analysis: modifiedAnalysis, quantity: targetQty });

  if (original.error || modified.error) {
    return {
      error: "Simulation could not compute manufacturing values for the provided geometry.",
      original,
      modified,
      changes: null,
    };
  }

  const origCostMid = (original.cost.low + original.cost.high) / 2;
  const modCostMid = (modified.cost.low + modified.cost.high) / 2;

  const massDeltaKg = Math.round((modified.massKg - original.massKg) * 1000) / 1000;
  const volDeltaCm3 = Math.round((modified.volumeCm3 - original.volumeCm3) * 100) / 100;
  const massPercent = calcRelativeChange(modified.massKg, original.massKg);
  const costPercent = calcRelativeChange(modCostMid, origCostMid);

  return {
    modifications: appliedMods,
    original: {
      quantity: baseQty,
      volumeCm3: original.volumeCm3,
      massKg: original.massKg,
      cost: original.cost,
      material: original.material,
      process: original.process.recommended.label,
    },
    modified: {
      quantity: targetQty,
      volumeCm3: modified.volumeCm3,
      massKg: modified.massKg,
      cost: modified.cost,
      material: modified.material,
      process: modified.process.recommended.label,
    },
    changes: {
      volumeDeltaCm3: volDeltaCm3,
      massDeltaKg,
      massPercent,
      costPercent,
    },
    assumptions: [
      "Simulation recalculates volume using simplified parametric profile geometry.",
      "Machining rates and material scrap margins follow standard ReForge baseline tables.",
    ],
  };
}

/**
 * Calculates sensitivity of key dimensions to volume and cost.
 */
export function analyzeDimensionSensitivity({ analysis }) {
  if (!analysis || typeof analysis !== "object" || !analysis.dimensions) {
    return [];
  }

  const baseVolRes = estimateVolumeCm3(analysis);
  const baseVol = baseVolRes.volumeCm3;
  if (!baseVol || baseVol <= 0) return [];

  const dims = analysis.dimensions;
  const results = [];
  const testKeys = [
    { key: "outerDiameter", label: "Outer Diameter" },
    { key: "innerDiameter", label: "Inner Diameter / Bore" },
    { key: "height", label: "Length / Height" },
    { key: "length", label: "Length" },
    { key: "thickness", label: "Thickness" },
    { key: "width", label: "Width" },
  ];

  for (const { key, label } of testKeys) {
    const val = dims[key];
    if (typeof val !== "number" || val <= 0) continue;

    // Simulate a 10% increase
    const testAnalysis = {
      ...analysis,
      dimensions: { ...dims, [key]: val * 1.1 },
    };
    const newVolRes = estimateVolumeCm3(testAnalysis);
    const newVol = newVolRes.volumeCm3;
    if (newVol == null) continue;

    const volChangePct = Math.abs(calcRelativeChange(newVol, baseVol));

    let impact = "low";
    const reasons = [];

    if (volChangePct >= 18) {
      impact = "high";
      reasons.push("Volume scales quadratically with diameter.");
      reasons.push("Significant impact on material mass and billet sizing.");
    } else if (volChangePct >= 7) {
      impact = "medium";
      reasons.push("Linear proportion to overall material volume.");
      reasons.push("Directly affects raw bar stock length or depth.");
    } else {
      impact = "low";
      reasons.push("Minor overall influence on material mass.");
    }

    results.push({
      dimension: key,
      label,
      currentValue: val,
      volumeSensitivityPercent: volChangePct,
      impact,
      reasons,
    });
  }

  // Sort by highest volume sensitivity first
  results.sort((a, b) => b.volumeSensitivityPercent - a.volumeSensitivityPercent);
  return results;
}
