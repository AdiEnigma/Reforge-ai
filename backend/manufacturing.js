// manufacturing.js
// Deterministic cost / process / lead-time calculation engine.
// Does NOT call Gemini — all numbers are arithmetic over the knowledge base
// and the geometry estimate from geometry-volume.js.
// If a future iteration wants an LLM-narrated cost explanation, keep this
// module as the source of truth and let the LLM only phrase the output.

import { MATERIALS, DEFAULT_MATERIAL, PROCESS_RATES, OVERHEAD_MARGIN } from "./manufacturing-data.js";
import { estimateVolumeCm3, resolveComponentTypeServer } from "./geometry-volume.js";

// ---------------------------------------------------------------------------
// 1. Material resolution
// ---------------------------------------------------------------------------

/**
 * Match analysis.materialEstimate to a MATERIALS row.
 * Returns { material, assumption } where assumption is non-null if we fell back.
 */
export function resolveMaterial(materialEstimate) {
  const raw = typeof materialEstimate === "string" ? materialEstimate.toLowerCase().trim() : "";
  if (raw && raw !== "unknown") {
    for (const mat of MATERIALS) {
      for (const keyword of mat.match) {
        if (raw.includes(keyword)) {
          return { material: mat, assumption: null };
        }
      }
    }
  }

  // No match — use default
  return {
    material: DEFAULT_MATERIAL,
    assumption:
      raw && raw !== "unknown"
        ? `Material cost assumed for mild steel — AI returned "${raw}" which did not match any known material keyword.`
        : "Material cost assumed for mild steel — AI could not determine material from images.",
  };
}

// ---------------------------------------------------------------------------
// 2. Process recommendation
// ---------------------------------------------------------------------------

/**
 * Deterministic rule tree: returns { primaryKey, alternatives, reasoning }
 * Each branch names its actual decision driver in the reasoning string.
 */
function recommendProcess(material, geometryStyle, quantity) {
  const q = quantity;

  if (material.category === "plastic") {
    if (q <= 20) {
      return {
        primaryKey: "3d_printing",
        alternatives: [
          {
            key: "injection_molding",
            label: PROCESS_RATES["injection_molding"].label,
            tradeoff: "Requires expensive tooling (₹45,000+); only cost-effective above ~200 units.",
          },
        ],
        reasoning: `Plastic material, quantity ${q} — 3D printing recommended. Tooling cost for injection moulding (₹45,000+) cannot be amortised at this volume. Switch to injection moulding above ~20 units for production runs.`,
      };
    } else {
      return {
        primaryKey: "injection_molding",
        alternatives: [
          {
            key: "3d_printing",
            label: PROCESS_RATES["3d_printing"].label,
            tradeoff: "No tooling cost; suitable for prototyping or low-volume runs ≤ 20 units.",
          },
        ],
        reasoning: `Plastic material, quantity ${q} — injection moulding recommended. At this volume the one-time tooling cost (₹45,000) is amortised below the per-unit 3D-printing cost.`,
      };
    }
  }

  // Metal paths
  if (geometryStyle === "revolved") {
    if (q > 50) {
      return {
        primaryKey: "casting",
        alternatives: [
          {
            key: "cnc_turning",
            label: PROCESS_RATES["cnc_turning"].label,
            tradeoff: "No tooling cost; preferred for small batches (≤ 50 units) or tight tolerances.",
          },
        ],
        reasoning: `Metal, revolved geometry, quantity ${q} — casting recommended. Above 50 units, casting tooling (₹15,000) is amortised and per-unit cost beats CNC turning. CNC turning remains preferable for tight tolerances regardless of quantity.`,
      };
    } else {
      return {
        primaryKey: "cnc_turning",
        alternatives: [
          {
            key: "casting",
            label: PROCESS_RATES["casting"].label,
            tradeoff: "Lower per-unit cost at scale (> 50 units) once tooling is amortised.",
          },
        ],
        reasoning: `Metal, revolved geometry, quantity ${q} — CNC turning recommended. Tooling cost for casting (₹15,000) is not justified at this volume; turning offers better dimensional accuracy and no minimum order.`,
      };
    }
  } else {
    // Non-revolved metal
    if (q > 100) {
      return {
        primaryKey: "casting",
        alternatives: [
          {
            key: "cnc_machining",
            label: PROCESS_RATES["cnc_machining"].label,
            tradeoff: "No tooling cost; preferred for low volumes or complex geometries requiring tight tolerances.",
          },
        ],
        reasoning: `Metal, non-revolved geometry, quantity ${q} — casting recommended. Casting becomes cost-competitive above ~100 units once the tooling cost (₹15,000) is amortised. CNC machining is preferred for tight-tolerance features regardless of volume.`,
      };
    } else {
      return {
        primaryKey: "cnc_machining",
        alternatives: [
          {
            key: "casting",
            label: PROCESS_RATES["casting"].label,
            tradeoff: "Lower per-unit cost at scale (> 100 units) once tooling is amortised.",
          },
          {
            key: "3d_printing",
            label: PROCESS_RATES["3d_printing"].label,
            tradeoff: "Prototype only — not load-bearing; use for fit/form checks before committing to metal.",
          },
        ],
        reasoning: `Metal, non-revolved geometry, quantity ${q} — CNC machining recommended. Casting only becomes cost-competitive above ~100 units once tooling (₹15,000) is amortised. For prototypes, consider 3D printing for fit checks before committing to machining.`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Machining time
// ---------------------------------------------------------------------------

/**
 * Compute per-unit machining hours.
 * setupHours is a ONE-TIME batch cost, so it is amortised over quantity.
 * The run-time portion (volume / removal-rate) is per-unit and does not change.
 */
function computeMachiningHours(rate, volumeCm3, featureCount, quantity) {
  const q = Math.max(1, quantity);
  const complexityMultiplier = 1 + 0.05 * Math.max(0, featureCount - 3);
  // Setup is one-time for the whole batch — divide by quantity to get per-unit share
  const setupHoursPerUnit = rate.setupHours / q;
  const runHoursPerUnit =
    ((volumeCm3 * rate.wasteFactor) / rate.removalRateCm3PerMin / 60) * complexityMultiplier;
  const machiningHours = setupHoursPerUnit + runHoursPerUnit;
  return { machiningHours, complexityMultiplier };
}

// ---------------------------------------------------------------------------
// 4. Lead time
// ---------------------------------------------------------------------------

function computeLeadTime(machiningHours, rate, quantity) {
  const q = Math.max(1, quantity);
  // Lead time is for the whole batch, not per-unit.
  // Estimate total batch hours = run-time hours * qty + one-time setup.
  // We already have per-unit machiningHours; reconstruct batch hours for lead time.
  const batchHours = machiningHours * q;
  const baseDays = Math.ceil(batchHours / 8);
  // First-time tooling adds flat 5 working days if toolingCostINR > 0.
  const toolingDays = rate.toolingCostINR > 0 ? 5 : 0;
  const lowDays = Math.max(1, baseDays + toolingDays);
  const highDays = Math.ceil(lowDays * 1.4);
  return { lowDays, highDays };
}

// ---------------------------------------------------------------------------
// 5. Cost
// ---------------------------------------------------------------------------

function computeCost(volumeCm3, material, rate, quantity, machiningHours) {
  const q = Math.max(1, quantity);
  const materialCostINR = volumeCm3 * material.densityGCm3 / 1000 * material.costPerKgINR * rate.wasteFactor;
  const machiningCostINR = machiningHours * rate.hourlyRateINR;
  const toolingPerUnitINR = rate.toolingCostINR / q;
  const subtotal = materialCostINR + machiningCostINR + toolingPerUnitINR;
  const overheadINR = subtotal * OVERHEAD_MARGIN;
  const totalPerUnitINR = subtotal + overheadINR;

  return {
    costLowINR: Math.round(totalPerUnitINR * 0.85),
    costHighINR: Math.round(totalPerUnitINR * 1.25),
    breakdown: {
      materialCostINR: Math.round(materialCostINR),
      machiningCostINR: Math.round(machiningCostINR),
      toolingPerUnitINR: Math.round(toolingPerUnitINR),
      overheadINR: Math.round(overheadINR),
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute a full manufacturing intelligence estimate.
 *
 * @param {{ analysis: object, quantity: number }} params
 * @returns {object}  — see T22 output shape in the implementation plan, or
 *                      { error: "insufficient-data", message: string } on failure
 */
export function computeManufacturingIntelligence({ analysis, quantity }) {
  const assumptions = [];

  // 1. Material
  const { material, assumption: materialAssumption } = resolveMaterial(analysis?.materialEstimate);
  if (materialAssumption) assumptions.push(materialAssumption);

  // 2. Volume & mass
  const { volumeCm3, source: volumeSource } = estimateVolumeCm3(analysis);

  if (volumeCm3 == null) {
    return {
      error: "insufficient-data",
      message:
        "Could not estimate part volume — the geometry recipe is missing or invalid and the dimension fields are insufficient. Provide clearer images or fill in reference dimensions.",
    };
  }

  if (volumeSource === "fallback-dims") {
    assumptions.push(
      "Volume estimated from bounding-box dimensions and fill-factor approximation — geometry recipe was not available. Accuracy: ±30–50%."
    );
  }

  const massKg = (volumeCm3 * material.densityGCm3) / 1000;

  // 3. Process recommendation
  // Determine geometry style: from recipe if available, else from component type
  const recipe = analysis?.geometryRecipe;
  const geometryStyle =
    recipe && typeof recipe.style === "string" ? recipe.style : resolveComponentTypeServer(analysis);

  const { primaryKey, alternatives, reasoning } = recommendProcess(material, geometryStyle, quantity);
  const primaryProcess = PROCESS_RATES[primaryKey];

  // 4. Feature count for complexity multiplier
  const recipeHoles = Array.isArray(recipe?.holes) ? recipe.holes.length : 0;
  const recipeGear = recipe?.gear ? 1 : 0;
  const featureCount = (Array.isArray(analysis?.features) ? analysis.features.length : 0) + recipeHoles + recipeGear;

  // 5. Machining time & lead time
  const { machiningHours } = computeMachiningHours(primaryProcess, volumeCm3, featureCount, quantity);
  const { lowDays, highDays } = computeLeadTime(machiningHours, primaryProcess, quantity);

  if (primaryProcess.toolingCostINR > 0) {
    assumptions.push(
      `Lead time includes a flat +5 working days for first-time tooling setup (${primaryProcess.label}). Repeat orders skip this.`
    );
  }

  // 6. Cost
  const { costLowINR, costHighINR, breakdown } = computeCost(volumeCm3, material, primaryProcess, quantity, machiningHours);

  // Build alternative objects with full labels
  const alternativesOut = alternatives.map((alt) => ({
    key: alt.key,
    label: alt.label,
    tradeoff: alt.tradeoff,
  }));

  return {
    volumeCm3: Math.round(volumeCm3 * 1000) / 1000,   // 3 decimal places
    massKg: Math.round(massKg * 1000) / 1000,
    material: {
      key: material.key,
      label: material.label,
      source: materialAssumption ? "fallback-default" : "ai-estimated",
      costPerKgINR: material.costPerKgINR,
      densityGCm3: material.densityGCm3,
    },
    process: {
      recommended: { key: primaryKey, label: primaryProcess.label },
      alternatives: alternativesOut,
      reasoning,
    },
    cost: {
      currency: "INR",
      low: costLowINR,
      high: costHighINR,
      breakdown,
    },
    leadTime: { lowDays, highDays },
    quantity,
    assumptions,
  };
}
