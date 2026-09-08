/**
 * engineering-context.js
 * Builds a compact, normalized engineering context object for the AI Engineer Copilot.
 * Supports single components, gear pairs (Primary + Companion), and complete machinery assemblies.
 * Generates context-aware suggested questions based on the active viewport scope.
 */

import { computeAssemblyRelations } from './machinery-context.js';

/**
 * Builds a structured, compact engineering context object.
 */
export function buildEngineeringContext({
  analysis,
  manufacturingIntelligence,
  quantity = 1,
  features = [],
  materialAlternatives = null,
  machineryState = null,
  activeScope = 'single', // 'single' | 'pair' | 'assembly' | 'component'
  activeComponentId = null,
}) {
  if (!analysis && !machineryState) {
    return null;
  }

  // If a specific component is selected or standard single analysis is provided
  const targetAnalysis = analysis || machineryState?.primaryGear?.analysis;
  if (!targetAnalysis && !machineryState) return null;

  const compType = String(targetAnalysis?.componentType || "mechanical component").trim();
  const dims = targetAnalysis?.dimensions || {};
  const recipe = targetAnalysis?.geometryRecipe || {};

  // Clean numeric dimensions
  const cleanDims = {
    outerDiameter: typeof dims.outerDiameter === "number" ? dims.outerDiameter : null,
    innerDiameter: typeof dims.innerDiameter === "number" ? dims.innerDiameter : null,
    height: typeof dims.height === "number" ? dims.height : null,
    width: typeof dims.width === "number" ? dims.width : null,
    length: typeof dims.length === "number" ? dims.length : null,
    thickness: typeof dims.thickness === "number" ? dims.thickness : null,
    teeth: typeof targetAnalysis?.teeth === "number" ? Math.round(targetAnalysis.teeth) : (recipe.gear?.teeth || null),
    module: typeof targetAnalysis?.module === "number" ? targetAnalysis.module : (recipe.gear?.module || null),
    helixAngle: typeof targetAnalysis?.helixAngle === "number" ? targetAnalysis.helixAngle : null,
  };

  // Material info
  const mfgMat = manufacturingIntelligence?.material;
  const material = {
    key: mfgMat?.key || "mild_steel",
    label: mfgMat?.label || targetAnalysis?.materialEstimate || "Mild Steel",
    source: mfgMat?.materialSource || (targetAnalysis?.materialEstimate ? "ai-estimated" : "fallback-default"),
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

  // Machinery Context & Assembly Relations
  let machineryContextSummary = null;
  if (machineryState) {
    const relations = computeAssemblyRelations(
      machineryState.primaryGear,
      machineryState.companionGear,
      machineryState.additionalComponents || []
    );

    const formatCompImages = (images = []) =>
      images.map((img, idx) => ({
        id: img.id || `img-${idx}`,
        name: img.name || `Photo ${idx + 1}`,
        purpose: img.purpose || 'general',
        priority: img.priority || 'medium',
        note: img.note || '',
      }));

    const compList = [
      {
        id: machineryState.primaryGear?.id || 'comp-primary',
        name: machineryState.primaryGear?.name || 'Primary Gear',
        role: 'PRIMARY',
        type: machineryState.primaryGear?.type || 'spur gear',
        notes: machineryState.primaryGear?.notes || '',
        photoCount: machineryState.primaryGear?.images?.length || 0,
        images: formatCompImages(machineryState.primaryGear?.images),
      },
      ...(machineryState.companionGear
        ? [
            {
              id: machineryState.companionGear.id,
              name: machineryState.companionGear.name,
              role: 'COMPANION',
              type: machineryState.companionGear.type || 'spur gear',
              notes: machineryState.companionGear.notes || '',
              photoCount: machineryState.companionGear.images?.length || 0,
              images: formatCompImages(machineryState.companionGear.images),
            },
          ]
        : []),
      ...(machineryState.additionalComponents || []).map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        type: c.type,
        notes: c.notes || '',
        photoCount: c.images?.length || 0,
        images: formatCompImages(c.images),
      })),
    ];

    const totalGears =
      (machineryState.primaryGear ? 1 : 0) +
      (machineryState.companionGear ? 1 : 0) +
      (machineryState.additionalComponents || []).filter(
        (c) => c.role === 'ADDITIONAL_GEAR' || c.type?.toLowerCase().includes('gear') || c.name?.toLowerCase().includes('gear')
      ).length;

    machineryContextSummary = {
      activeScope,
      activeComponentId: activeComponentId || machineryState.primaryGear?.id,
      totalGears,
      components: compList,
      assemblyRelations: relations,
      hasCompanionGear: Boolean(machineryState.companionGear),
      assemblyContextNotes: machineryState.assemblyContext?.notes || '',
      surroundingsNotes: machineryState.environmentContext?.notes || machineryState.machineryContext?.notes || '',
      assemblyContextPhotos: formatCompImages(machineryState.assemblyContext?.images),
      environmentContextPhotos: formatCompImages(machineryState.environmentContext?.images),
      totalPhotos:
        (machineryState.primaryGear?.images?.length || 0) +
        (machineryState.companionGear?.images?.length || 0) +
        (machineryState.additionalComponents || []).reduce((acc, c) => acc + (c.images?.length || 0), 0) +
        (machineryState.assemblyContext?.images?.length || 0) +
        (machineryState.environmentContext?.images?.length || 0),
    };
  }

  return {
    component: {
      type: compType,
      name: targetAnalysis?.componentType ? String(targetAnalysis.componentType).toUpperCase() : "COMPONENT",
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
      overall: typeof targetAnalysis?.confidence === "number" ? Math.round(targetAnalysis.confidence * 100) / 100 : 0.8,
      uncertainties: Array.isArray(targetAnalysis?.uncertainties) ? targetAnalysis.uncertainties : [],
    },
    machineryContext: machineryContextSummary,
  };
}

/**
 * Generates component-specific and assembly-aware suggested questions.
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

  const mach = context.machineryContext;
  const scope = mach?.activeScope || 'single';

  // Assembly or Pair-Specific Questions
  if (scope === 'pair' && mach?.assemblyRelations?.companion) {
    const rel = mach.assemblyRelations.companion;
    suggestions.push(`What is the center distance (${rel.centerDistance} mm) and gear ratio (${rel.gearRatio}:1)?`);
    suggestions.push("How should backlash and contact stress be inspected between these two gears?");
    suggestions.push("Are both gears matched in module and pressure angle?");
    if (context.material?.label) {
      suggestions.push(`Should the companion gear use the same material (${context.material.label}) or a different hardness?`);
    }
    return suggestions.slice(0, 5);
  }

  if (scope === 'assembly' && mach) {
    suggestions.push("How do the shafts and bearings support load distribution in this gearbox?");
    suggestions.push("What lubrication and housing enclosure tolerances are recommended?");
    if (mach.assemblyRelations?.companion) {
      suggestions.push(`Analyze the complete power transmission chain (ratio ${mach.assemblyRelations.companion.gearRatio}:1).`);
    }
    suggestions.push("What are the primary sources of mechanical wear and vibration in this machinery?");
    return suggestions.slice(0, 5);
  }

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
