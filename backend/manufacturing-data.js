// v1 starter constants — approximate India job-shop market levels (INR).
// These are illustrative placeholders for demo/estimation purposes only.
// Replace with real supplier/market data before using for actual quoting.
// Last updated: v1 / 2026 — not sourced from live supplier data.
//
// QUALITATIVE PROPERTIES NOTE:
// The `properties` fields (corrosionResistance, wearResistance, machinability,
// strengthLevel) are simplified application-level guidance for UI comparison only.
// They are NOT engineering-certified material specifications and MUST NOT be
// used for structural analysis, safety decisions, regulatory compliance, or
// production quoting without independent engineering verification.
// Labels are conservative best-effort assessments based on general material
// knowledge — treat them as approximate comparison guidance only.

export const MATERIALS = [
  {
    key: "mild_steel",
    label: "Mild Steel (MS)",
    match: ["mild steel", "carbon steel", "steel", "ms"],
    densityGCm3: 7.85,
    costPerKgINR: 65,
    category: "metal",
    properties: {
      corrosionResistance: "low",
      wearResistance: "medium",
      machinability: "high",
      strengthLevel: "medium",
    },
    comparisonTags: ["low material cost", "good machinability", "general-purpose"],
  },
  {
    key: "hardened_steel",
    label: "Hardened / Tool Steel",
    match: ["hardened steel", "tool steel", "alloy steel"],
    densityGCm3: 7.85,
    costPerKgINR: 110,
    category: "metal",
    properties: {
      corrosionResistance: "low",
      wearResistance: "high",
      machinability: "low",
      strengthLevel: "high",
    },
    comparisonTags: ["high wear resistance", "high strength", "tooling applications"],
  },
  {
    key: "stainless_steel",
    label: "Stainless Steel",
    match: ["stainless"],
    densityGCm3: 8.0,
    costPerKgINR: 220,
    category: "metal",
    properties: {
      corrosionResistance: "high",
      wearResistance: "medium",
      machinability: "medium",
      strengthLevel: "high",
    },
    comparisonTags: ["corrosion resistant", "food-grade compatible", "hygienic applications"],
  },
  {
    key: "cast_iron",
    label: "Cast Iron",
    match: ["cast iron"],
    densityGCm3: 7.2,
    costPerKgINR: 55,
    category: "metal",
    properties: {
      corrosionResistance: "low",
      wearResistance: "high",
      machinability: "medium",
      strengthLevel: "medium",
    },
    comparisonTags: ["lowest material cost", "vibration damping", "high wear resistance"],
  },
  {
    key: "aluminium",
    label: "Aluminium",
    match: ["aluminium", "aluminum"],
    densityGCm3: 2.7,
    costPerKgINR: 240,
    category: "metal",
    properties: {
      corrosionResistance: "high",
      wearResistance: "low",
      machinability: "high",
      strengthLevel: "medium",
    },
    comparisonTags: ["lightweight", "corrosion resistant", "good machinability"],
  },
  {
    key: "brass",
    label: "Brass",
    match: ["brass"],
    densityGCm3: 8.5,
    costPerKgINR: 480,
    category: "metal",
    properties: {
      corrosionResistance: "high",
      wearResistance: "medium",
      machinability: "high",
      strengthLevel: "low",
    },
    comparisonTags: ["decorative", "good machinability", "corrosion resistant"],
  },
  {
    key: "bronze",
    label: "Bronze",
    match: ["bronze"],
    densityGCm3: 8.8,
    costPerKgINR: 520,
    category: "metal",
    properties: {
      corrosionResistance: "high",
      wearResistance: "high",
      machinability: "medium",
      strengthLevel: "medium",
    },
    comparisonTags: ["wear resistant", "corrosion resistant", "bearings and bushings"],
  },
  {
    key: "plastic_generic",
    label: "Engineering Plastic",
    match: ["plastic", "nylon", "polymer", "abs", "pom", "delrin", "acetal"],
    densityGCm3: 1.15,
    costPerKgINR: 180,
    category: "plastic",
    properties: {
      corrosionResistance: "high",
      wearResistance: "low",
      machinability: "high",
      strengthLevel: "low",
    },
    comparisonTags: ["lightweight", "chemical resistant", "low cost"],
  },
];

// Fallback when materialEstimate is "unknown", empty, or matches nothing above.
// mild_steel — safest generic assumption for unidentified metal components.
export const DEFAULT_MATERIAL = MATERIALS[0];

// Hourly rates and process parameters for common manufacturing routes.
// removalRateCm3PerMin for non-subtractive processes (casting, injection molding, forging)
// is used as a loose "production rate" proxy for v1 time estimation only —
// it is NOT literal material removal and should NOT be used for real process planning.
export const PROCESS_RATES = {
  cnc_machining: {
    label: "CNC Machining (3-axis mill)",
    hourlyRateINR: 900,
    setupHours: 0.75,
    wasteFactor: 1.4,
    removalRateCm3PerMin: 8,
    toolingCostINR: 0,
  },
  cnc_turning: {
    label: "CNC Turning (lathe)",
    hourlyRateINR: 700,
    setupHours: 0.5,
    wasteFactor: 1.3,
    removalRateCm3PerMin: 10,
    toolingCostINR: 0,
  },
  casting: {
    label: "Sand / Die Casting",
    hourlyRateINR: 400,
    setupHours: 2.0,
    wasteFactor: 1.15,
    removalRateCm3PerMin: 40,
    toolingCostINR: 15000,
  },
  "3d_printing": {
    label: "3D Printing (FDM / SLA)",
    hourlyRateINR: 250,
    setupHours: 0.25,
    wasteFactor: 1.05,
    removalRateCm3PerMin: 6,
    toolingCostINR: 0,
  },
  injection_molding: {
    label: "Injection Molding",
    hourlyRateINR: 350,
    setupHours: 1.0,
    wasteFactor: 1.1,
    removalRateCm3PerMin: 60,
    toolingCostINR: 45000,
  },
  forging: {
    label: "Forging",
    hourlyRateINR: 500,
    setupHours: 3.0,
    wasteFactor: 1.2,
    removalRateCm3PerMin: 25,
    toolingCostINR: 25000,
  },
};

// Applied to (materialCost + machiningCost + toolingPerUnit) to cover
// overhead, finishing, QC, packaging, and profit margin — v1 flat rate.
export const OVERHEAD_MARGIN = 0.2;
