/**
 * engineering-context.js
 * Builds a compact, normalized engineering context object for the AI Engineer Copilot.
 * Generates context-aware suggested questions for the active mechanical component.
 */

/**
 * Builds a structured, compact engineering context object.
 */
export function buildEngineeringContext({
  analysis,
  manufacturingIntelligence,
  quantity = 1,
  features = [],
  materialAlternatives = null,
}) {
  if (!analysis || typeof analysis !== "object") {
    return null;
  }

  const compType = String(analysis.componentType || "mechanical component").trim();
  const dims = analysis.dimensions || {};
  const recipe = analysis.geometryRecipe || {};

  // Clean numeric dimensions
  const cleanDims = {
    outerDiameter: typeof dims.outerDiameter === "number" ? dims.outerDiameter : null,
    innerDiameter: typeof dims.innerDiameter === "number" ? dims.innerDiameter : null,
    height: typeof dims.height === "number" ? dims.height : null,
    width: typeof dims.width === "number" ? dims.width : null,
    length: typeof dims.length === "number" ? dims.length : null,
    thickness: typeof dims.thickness === "number" ? dims.thickness : null,
    teeth: typeof analysis.teeth === "number" ? Math.round(analysis.teeth) : (recipe.gear?.teeth || null),
    module: typeof analysis.module === "number" ? analysis.module : (recipe.gear?.module || null),
    helixAngle: typeof analysis.helixAngle === "number" ? analysis.helixAngle : null,
  };

  // Material info
  const mfgMat = manufacturingIntelligence?.material;
  const material = {
    key: mfgMat?.key || "mild_steel",
    label: mfgMat?.label || analysis.materialEstimate || "Mild Steel",
    source: mfgMat?.materialSource || (analysis.materialEstimate ? "ai-estimated" : "fallback-default"),
    densityGCm3: mfgMat?.densityGCm3 || 7.85,
    costPerKgINR: mfgMat?.costPerKgINR || 65,
    isAssumed: mfgMat?.materialSource === "fallback-default" || !mfgMat,
  };

  // Geometry recipe summary (compact representation)
  let recipeSummary = null;
  if (recipe.style === "revolved" && Array.isArray(recipe.revolvedProfile)) {
    recipeSummary = {
      style: "revolved",
      profilePoints: recipe.revolvedProfile.length,
      profile: recipe.revolvedProfile.slice(0, 8).map((p) => ({ z: p.z, radius: p.radius })),
    };
  } else if (recipe.style === "extruded" && Array.isArray(recipe.outline)) {
    recipeSummary = {
      style: "extruded",
      outlinePoints: recipe.outline.length,
      depth: recipe.depth || cleanDims.thickness || 20,
      holes: Array.isArray(recipe.holes) ? recipe.holes.slice(0, 8).map((h) => ({ cx: h.cx, cy: h.cy, radius: h.radius })) : [],
    };
  } else if (recipe.style === "gear" && recipe.gear) {
    recipeSummary = {
      style: "gear",
      teeth: recipe.gear.teeth,
      module: recipe.gear.module,
      faceWidth: recipe.gear.faceWidth,
      boreRadius: recipe.gear.boreRadius,
    };
  } else if (recipe.style === "combination" && Array.isArray(recipe.primitives)) {
    recipeSummary = {
      style: "combination",
      primitiveCount: recipe.primitives.length,
      primitives: recipe.primitives.slice(0, 6).map((p) => ({ kind: p.kind, size: p.size, position: p.position })),
    };
  }

  // Normalized features summary
  const cleanFeatures = (Array.isArray(features) ? features : []).slice(0, 10).map((f) => ({
    id: f.id,
    type: f.type,
    label: f.label,
    confidence: typeof f.confidence === "number" ? Math.round(f.confidence * 100) / 100 : 0.8,
    metadata: f.metadata || null,
  }));

  // Manufacturing Intelligence summary
  let mfgSummary = null;
  if (manufacturingIntelligence && !manufacturingIntelligence.error) {
    const m = manufacturingIntelligence;
    mfgSummary = {
      quantity: Math.max(1, Number(quantity) || m.quantity || 1),
      massKg: typeof m.massKg === "number" ? Math.round(m.massKg * 1000) / 1000 : null,
      volumeCm3: typeof m.volumeCm3 === "number" ? Math.round(m.volumeCm3 * 100) / 100 : null,
      recommendedProcess: m.process?.recommended?.label || "CNC Machining",
      processKey: m.process?.recommended?.key || "cnc_milling",
      reasoning: m.process?.reasoning || "",
      cost: {
        low: m.cost?.low || 0,
        high: m.cost?.high || 0,
        currency: "INR",
        breakdown: m.cost?.breakdown || null,
      },
      leadTime: {
        lowDays: m.leadTime?.lowDays || 1,
        highDays: m.leadTime?.highDays || 3,
      },
      alternatives: Array.isArray(m.process?.alternatives)
        ? m.process.alternatives.map((a) => ({ label: a.label, tradeoff: a.tradeoff }))
        : [],
    };
  }

  // Material alternatives summary
  let matAltsSummary = null;
  if (materialAlternatives?.alternatives && Array.isArray(materialAlternatives.alternatives)) {
    matAltsSummary = materialAlternatives.alternatives.slice(0, 3).map((alt) => ({
      key: alt.key,
      label: alt.label,
      massKg: alt.massKg,
      materialCostINR: alt.materialCostINR,
      weightChangePercent: alt.weightChangePercent,
      materialCostChangePercent: alt.materialCostChangePercent,
      whyConsider: alt.whyConsider,
      tradeoff: alt.tradeoff,
    }));
  }

  return {
    component: {
      type: compType,
      name: analysis.componentType ? String(analysis.componentType).toUpperCase() : "COMPONENT",
    },
    dimensions: cleanDims,
    material,
    geometry: {
      style: recipe.style || "parametric",
      recipe: recipeSummary,
      featureCount: cleanFeatures.length,
      holeCount: cleanDims.innerDiameter ? 1 : 0,
    },
    features: cleanFeatures,
    manufacturing: mfgSummary,
    materialAlternatives: matAltsSummary,
    confidence: {
      overall: typeof analysis.confidence === "number" ? Math.round(analysis.confidence * 100) / 100 : 0.8,
      uncertainties: Array.isArray(analysis.uncertainties) ? analysis.uncertainties : [],
    },
  };
}

/**
 * Generates component-specific suggested questions.
 */
export function getEngineeringSuggestions(context) {
  if (!context || !context.component) {
    return [
      "What is CNC turning?",
      "How are manufacturing costs estimated?",
      "What is the difference between casting and machining?",
    ];
  }

  const suggestions = [];
  const compType = String(context.component.type || "").toLowerCase();
  const proc = context.manufacturing?.recommendedProcess || "CNC Machining";
  const innerDia = context.dimensions?.innerDiameter;
  const isGear = compType.includes("gear") || context.geometry?.style === "gear";
  const isShaft = compType.includes("shaft") || compType.includes("cylinder") || context.geometry?.style === "revolved";
  const isFlange = compType.includes("flange");
  const qty = context.manufacturing?.quantity || 1;

  // 1. Process reasoning
  suggestions.push(`Why is ${proc} recommended?`);

  // 2. Dimension hypothetical
  if (innerDia && innerDia > 0) {
    const nextDia = Math.round(innerDia * 1.25);
    suggestions.push(`What happens if I increase the bore from ${innerDia} mm to ${nextDia} mm?`);
  } else if (context.dimensions?.outerDiameter) {
    suggestions.push("Which dimension contributes most to machining time?");
  } else if (context.dimensions?.thickness) {
    suggestions.push("Can the thickness be reduced to save material?");
  }

  // 3. Material comparison
  if (context.material?.label?.toLowerCase().includes("steel")) {
    suggestions.push("Would aluminium reduce the cost or weight?");
  } else {
    suggestions.push("What material alternative is best for this part?");
  }

  // 4. Batch quantity effect
  if (qty <= 20) {
    suggestions.push("What changes if I manufacture 500 units instead of " + qty + "?");
  } else {
    suggestions.push("How does batch quantity affect the per-unit cost?");
  }

  // 5. Manufacturability & critical feature
  if (isGear) {
    suggestions.push("How does the gear tooth geometry affect machining complexity?");
  } else if (isShaft) {
    suggestions.push("What feature should I inspect first for stress concentration?");
  } else if (isFlange) {
    suggestions.push("Can the bolt hole pattern be optimized for machining?");
  } else {
    suggestions.push("Can this part be 3D printed for prototyping?");
  }

  return suggestions.slice(0, 5);
}
