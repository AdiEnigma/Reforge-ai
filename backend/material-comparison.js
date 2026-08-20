// material-comparison.js
// Deterministic material alternatives & comparison engine.
// Consumes an already-computed volumeCm3 from manufacturing intelligence —
// does NOT re-derive geometry independently.
// Does NOT call Gemini.
//
// PROPERTIES NOTE: qualitative labels (low/medium/high) from manufacturing-data.js
// are application-level comparison guidance only — not engineering-certified specs.

import { MATERIALS } from "./manufacturing-data.js";
import { resolveMaterial } from "./manufacturing.js";

// ---------------------------------------------------------------------------
// Alternatives map — deterministic, same-category-preferred, max 3 entries.
// Only includes material keys that exist in MATERIALS.
// ---------------------------------------------------------------------------
const ALTERNATIVES_MAP = {
  mild_steel:      ["aluminium", "stainless_steel", "cast_iron"],
  hardened_steel:  ["stainless_steel", "cast_iron", "mild_steel"],
  stainless_steel: ["mild_steel", "aluminium", "cast_iron"],
  cast_iron:       ["mild_steel", "stainless_steel", "aluminium"],
  aluminium:       ["mild_steel", "stainless_steel", "brass"],
  brass:           ["aluminium", "stainless_steel", "bronze"],
  bronze:          ["brass", "stainless_steel", "aluminium"],
  plastic_generic: [], // no cross-category alternatives in current DB
};

// Fast key-based lookup for MATERIALS
const MATERIAL_BY_KEY = Object.fromEntries(MATERIALS.map((m) => [m.key, m]));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Convert qualitative label to numeric score for comparison arithmetic. */
function qualToNum(level) {
  if (level === "high") return 1;
  if (level === "medium") return 0.5;
  return 0; // "low" or missing
}

/** mass in kg from cm³ volume and g/cm³ density. */
export function calculateMaterialMass(volumeCm3, densityGCm3) {
  return (volumeCm3 * densityGCm3) / 1000;
}

/** Raw material cost in INR — no waste factor (comparison-only, not manufacturing cost). */
export function calculateMaterialCost(massKg, costPerKgINR) {
  return massKg * costPerKgINR;
}

/**
 * Relative change from current to alternative value, as a percentage.
 * Returns 0 when currentValue is 0 (avoids divide-by-zero).
 */
export function calculateRelativeChange(altValue, currentValue) {
  if (currentValue === 0) return 0;
  return ((altValue - currentValue) / currentValue) * 100;
}

// ---------------------------------------------------------------------------
// Tradeoff score — 0..100; higher = more interesting alternative.
// Weights: weight ↓30%, cost ↓30%, corrosion ↑15%, wear ↑10%, machinability ↑15%.
// NOT a scientific optimum — labelled "trade-off score" in the UI.
// ---------------------------------------------------------------------------
export function computeTradeoffScore(alt, current, weightChangePct, costChangePct) {
  const altProps = alt.properties || {};
  const curProps = current.properties || {};

  // Benefit factors: [0,1], positive = this alternative is better on that axis.
  // Weight: up to 100% lighter → full benefit.
  const weightBenefit = Math.max(0, Math.min(1, -weightChangePct / 100));
  // Cost: up to 200% cheaper → full benefit (wider range because INR/kg varies a lot).
  const costBenefit = Math.max(0, Math.min(1, -costChangePct / 200));
  // Property improvements relative to current.
  const corrosionBenefit = Math.max(
    0,
    qualToNum(altProps.corrosionResistance) - qualToNum(curProps.corrosionResistance)
  );
  const wearBenefit = Math.max(
    0,
    qualToNum(altProps.wearResistance) - qualToNum(curProps.wearResistance)
  );
  const machinabilityBenefit = Math.max(
    0,
    qualToNum(altProps.machinability) - qualToNum(curProps.machinability)
  );

  const score =
    weightBenefit      * 0.30 +
    costBenefit        * 0.30 +
    corrosionBenefit   * 0.15 +
    wearBenefit        * 0.10 +
    machinabilityBenefit * 0.15;

  return Math.round(score * 100);
}

// ---------------------------------------------------------------------------
// Human-readable tradeoff sentence.
// Language avoids engineering claims — uses "estimated" and relative terms.
// ---------------------------------------------------------------------------
export function buildTradeoff(alt, current, weightChangePct, costChangePct) {
  const altProps = alt.properties || {};
  const curProps = current.properties || {};
  const parts = [];

  const absW = Math.abs(Math.round(weightChangePct));
  if (weightChangePct <= -15) {
    parts.push(`About ${absW}% lighter`);
  } else if (weightChangePct >= 15) {
    parts.push(`About ${absW}% heavier`);
  } else {
    parts.push("Similar weight");
  }

  if (costChangePct > 25) {
    parts.push("higher estimated material cost");
  } else if (costChangePct < -15) {
    parts.push("lower estimated material cost");
  } else {
    parts.push("similar material cost");
  }

  if (qualToNum(altProps.corrosionResistance) > qualToNum(curProps.corrosionResistance)) {
    parts.push("better corrosion resistance");
  }
  if (qualToNum(altProps.wearResistance) > qualToNum(curProps.wearResistance)) {
    parts.push("higher wear resistance");
  }
  if (qualToNum(altProps.machinability) < qualToNum(curProps.machinability)) {
    parts.push("harder to machine");
  }

  // Capitalise first word, end with period.
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

// ---------------------------------------------------------------------------
// "Why consider it?" — one short sentence built from properties.
// ---------------------------------------------------------------------------
export function buildWhyConsider(alt, current, weightChangePct, costChangePct) {
  const altProps = alt.properties || {};
  const curProps = current.properties || {};
  const reasons = [];

  if (weightChangePct <= -20) reasons.push("lower part weight");
  if (costChangePct <= -15) reasons.push("lower estimated material cost");
  if (qualToNum(altProps.corrosionResistance) > qualToNum(curProps.corrosionResistance)) {
    reasons.push("better corrosion resistance for harsher environments");
  }
  if (qualToNum(altProps.wearResistance) > qualToNum(curProps.wearResistance)) {
    reasons.push("higher wear resistance for demanding applications");
  }
  if (qualToNum(altProps.machinability) > qualToNum(curProps.machinability)) {
    reasons.push("easier to machine");
  }
  if (weightChangePct >= 20) {
    reasons.push("denser structure with different mechanical characteristics");
  }

  if (reasons.length === 0) {
    reasons.push("different material properties suited to specific application requirements");
  }

  const str = reasons.join(", ");
  return str.charAt(0).toUpperCase() + str.slice(1) + ".";
}

// ---------------------------------------------------------------------------
// Badge assignment — only when calculation actually supports it.
// ---------------------------------------------------------------------------
function assignBadges(alternatives) {
  if (!alternatives.length) return;

  const maxScore = Math.max(...alternatives.map((a) => a.tradeoffScore));
  const minMass  = Math.min(...alternatives.map((a) => a.massKg));
  const minCost  = Math.min(...alternatives.map((a) => a.materialCostINR));

  for (const alt of alternatives) {
    if (alt.tradeoffScore === maxScore && maxScore >= 40) {
      alt.badge = "BEST TRADE-OFF";
    } else if (alt.massKg === minMass && alt.weightChangePercent <= -20) {
      alt.badge = "LIGHTEST OPTION";
    } else if (alt.materialCostINR === minCost && alt.materialCostChangePercent <= -15) {
      alt.badge = "LOWEST MATERIAL COST";
    } else if (alt.properties?.corrosionResistance === "high") {
      alt.badge = "HIGH CORROSION RESISTANCE";
    } else {
      alt.badge = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute material alternatives and comparison data.
 *
 * @param {{ analysis: object, manufacturingIntelligence: object }} params
 * @returns {object} — { current, alternatives, volumeCm3, quantity }
 *                     or { error: "insufficient-data", message: string }
 */
export function computeMaterialAlternatives({ analysis, manufacturingIntelligence }) {
  // 1. Extract already-computed volume — do NOT re-derive geometry.
  const volumeCm3 = manufacturingIntelligence?.volumeCm3;
  if (volumeCm3 == null || !isFinite(volumeCm3) || volumeCm3 <= 0) {
    return {
      error: "insufficient-data",
      message:
        "A reliable part volume could not be estimated from the current analysis. " +
        "Provide clearer images or fill in reference dimensions.",
    };
  }

  const quantity =
    typeof manufacturingIntelligence?.quantity === "number" &&
    isFinite(manufacturingIntelligence.quantity)
      ? Math.max(1, Math.round(manufacturingIntelligence.quantity))
      : 1;

  // 2. Resolve current material — reuse identical logic from manufacturing.js.
  const { material: currentMaterial, assumption } = resolveMaterial(
    analysis?.materialEstimate
  );
  const materialSource = assumption ? "fallback-default" : "ai-estimated";

  // 3. Current mass & material cost.
  const currentMassKg = calculateMaterialMass(volumeCm3, currentMaterial.densityGCm3);
  const currentMaterialCostINR = calculateMaterialCost(
    currentMassKg,
    currentMaterial.costPerKgINR
  );

  // 4. Select up to 3 alternatives — lookup from deterministic map.
  const altKeys = (ALTERNATIVES_MAP[currentMaterial.key] || []).slice(0, 3);
  const altMaterials = altKeys
    .map((key) => MATERIAL_BY_KEY[key])
    .filter(Boolean); // guard against missing keys

  // 5. Compute comparison for each alternative.
  const alternatives = altMaterials.map((alt) => {
    const altMassKg = calculateMaterialMass(volumeCm3, alt.densityGCm3);
    const altMaterialCostINR = calculateMaterialCost(altMassKg, alt.costPerKgINR);

    const weightChangePct = calculateRelativeChange(altMassKg, currentMassKg);
    const costChangePct   = calculateRelativeChange(altMaterialCostINR, currentMaterialCostINR);

    return {
      key:   alt.key,
      label: alt.label,
      massKg:           Math.round(altMassKg * 1000) / 1000,
      materialCostINR:  Math.round(altMaterialCostINR),
      weightChangePercent:      Math.round(weightChangePct),
      materialCostChangePercent: Math.round(costChangePct),
      properties:    alt.properties   || {},
      comparisonTags: alt.comparisonTags || [],
      tradeoff:     buildTradeoff(alt, currentMaterial, weightChangePct, costChangePct),
      whyConsider:  buildWhyConsider(alt, currentMaterial, weightChangePct, costChangePct),
      tradeoffScore: computeTradeoffScore(alt, currentMaterial, weightChangePct, costChangePct),
      badge: null, // assigned below
    };
  });

  // Assign badges once all scores are known.
  assignBadges(alternatives);

  return {
    current: {
      key:   currentMaterial.key,
      label: currentMaterial.label,
      massKg:           Math.round(currentMassKg * 1000) / 1000,
      materialCostINR:  Math.round(currentMaterialCostINR),
      materialSource,
      assumption: assumption || null,
      properties:    currentMaterial.properties   || {},
      comparisonTags: currentMaterial.comparisonTags || [],
    },
    alternatives,
    volumeCm3: Math.round(volumeCm3 * 1000) / 1000,
    quantity,
  };
}
