import test from "node:test";
import assert from "node:assert/strict";
import {
  STANDARD_MODULES,
  snapToStandardModule,
  extractVisionObservations,
  resolveGeometryFromVision,
  reconcileGeminiWithVision,
  fallbackDeterministicAnalysis,
  buildBearingRecipe,
  buildBracketRecipe,
} from "./src/vision-geometry-resolver.js";

test("snapToStandardModule snaps close continuous modules to standard ISO/DIN values", () => {
  // Exact matches
  assert.equal(snapToStandardModule(2.0), 2.0);
  assert.equal(snapToStandardModule(5.0), 5.0);

  // Near matches within 12% tolerance
  assert.equal(snapToStandardModule(2.04), 2.0);
  assert.equal(snapToStandardModule(1.97), 2.0);
  assert.equal(snapToStandardModule(3.95), 4.0);
  assert.equal(snapToStandardModule(5.1), 5.0);

  // Outside tolerance returns rounded number
  const oddModule = 3.45;
  assert.equal(snapToStandardModule(oddModule), 3.45);

  // Edge cases
  assert.equal(snapToStandardModule(null), null);
  assert.equal(snapToStandardModule(0), null);
  assert.equal(snapToStandardModule(-5), null);
});

test("extractVisionObservations aggregates features across all input views", () => {
  assert.equal(extractVisionObservations(null), null);
  assert.equal(extractVisionObservations({ images: [] }), null);

  const mockVision = {
    images: [
      {
        opencv: {
          circles: [{ radius_px: 120 }, { radius_px: 30 }],
          symmetry_hints: ["n_fold_symmetry: 24"],
        },
        calibration: {
          status: "calibrated",
          mm_per_pixel: 0.5,
        },
      },
      {
        opencv: {
          circles: [{ radius_px: 120 }],
        },
      },
    ],
    warnings: ["low lighting"],
  };

  const obs = extractVisionObservations(mockVision);
  assert.ok(obs);
  assert.equal(obs.imageCount, 2);
  assert.equal(obs.circles.length, 3);
  assert.equal(obs.symmetryHints.length, 1);
  assert.equal(obs.calibrations.length, 1);
  assert.equal(obs.warnings.length, 1);
});

test("resolveGeometryFromVision does not default tooth-only evidence to spur", () => {
  const mockVision = {
    images: [
      {
        opencv: {
          circles: [{ radius_px: 100 }, { radius_px: 25 }],
          symmetry_hints: ["rotational_symmetry_order: 20"],
        },
        calibration: {
          status: "calibrated",
          mm_per_pixel: 0.5, // outer diameter = 100 * 2 * 0.5 = 100mm
        },
      },
    ],
  };

  const result = resolveGeometryFromVision(mockVision, { thickness: 25 });
  assert.equal(result.canResolveWithoutGemini, false);
  assert.ok(result.confidence < 0.80);
  assert.equal(result.analysis.componentType, "gear (type unconfirmed)");
  assert.equal(result.analysis.gearType, "unknown");
  assert.equal(result.analysis.requiresGearTypeConfirmation, true);
  assert.equal(result.analysis.teeth, 20);
  assert.ok(result.analysis.geometryRecipe);
  assert.equal(result.analysis.geometryRecipe.style, "gear");
  assert.equal(result.analysis.geometryRecipe.gear.teeth, 20);
  assert.equal(result.analysis.geometryRecipe.gear.gearType, "unknown");
  assert.ok(result.analysis.uncertainties.some((u) => /Gear type could not be identified/.test(u)));
  assert.equal(result.analysis.provenance, "computer_vision_direct");
});

test("resolveGeometryFromVision resolves gear geometry when the type is explicit", () => {
  const mockVision = {
    images: [
      {
        opencv: {
          circles: [{ radius_px: 100 }, { radius_px: 25 }],
          symmetry_hints: ["rotational_symmetry_order: 20"],
        },
        calibration: { status: "calibrated", mm_per_pixel: 0.5 },
      },
    ],
  };

  const result = resolveGeometryFromVision(mockVision, {
    thickness: 25,
    gearType: "spur",
  });
  assert.equal(result.canResolveWithoutGemini, true);
  assert.ok(result.confidence >= 0.80);
  assert.equal(result.analysis.componentType, "spur gear");
  assert.equal(result.analysis.gearType, "spur");
  assert.equal(result.analysis.requiresGearTypeConfirmation, false);
  assert.equal(result.analysis.teeth, 20);
  assert.equal(result.analysis.geometryRecipe.gear.gearType, "spur");
  assert.equal(result.analysis.provenance, "computer_vision_direct");
});

test("resolveGeometryFromVision deterministically resolves shaft geometry without Gemini", () => {
  const mockVision = {
    images: [
      {
        opencv: {
          circles: [{ radius_px: 50 }],
        },
        calibration: {
          status: "calibrated",
          mm_per_pixel: 0.5, // outer diameter = 50mm
        },
      },
    ],
  };

  const result = resolveGeometryFromVision(mockVision, { length: 150 });
  assert.equal(result.canResolveWithoutGemini, true);
  assert.equal(result.analysis.componentType, "cylinder/shaft");
  assert.equal(result.analysis.dimensions.outerDiameter, 50);
  assert.equal(result.analysis.dimensions.length, 150);
  assert.equal(result.analysis.geometryRecipe.style, "revolved");
  assert.equal(result.analysis.provenance, "computer_vision_direct");
});

test("reconcileGeminiWithVision locks ground-truth dimensions and overwrites Gemini guesswork", () => {
  const geminiProposal = {
    componentType: "gear",
    teeth: 18, // Gemini guesses 18
    dimensions: {
      outerDiameter: 105,
      innerDiameter: 30,
      height: 20,
    },
    module: 4.8,
  };

  const mockVision = {
    images: [
      {
        opencv: {
          symmetry_hints: ["symmetry: 24"], // Vision detects 24 teeth
        },
      },
    ],
  };

  // User explicitly confirmed teeth: 24, outerDiameter: 130
  const userRef = { teeth: 24, outerDiameter: 130, thickness: 28 };
  const reconciled = reconcileGeminiWithVision(geminiProposal, mockVision, userRef);

  assert.equal(reconciled.teeth, 24); // Ground truth overrides Gemini guess
  assert.equal(reconciled.dimensions.thickness, 28);
  assert.equal(reconciled.geometryRecipe.style, "gear");
  assert.equal(reconciled.geometryRecipe.gear.teeth, 24);
  assert.equal(reconciled.provenance, "gemini_assisted_vision");
  assert.equal(reconciled.geometrySource, "template_gear");
});

test("fallbackDeterministicAnalysis produces watertight valid CAD model when Gemini fails", () => {
  const fallback = fallbackDeterministicAnalysis({ teeth: 30, outerDiameter: 160 }, "Gemini API 503");
  assert.ok(fallback);
  assert.equal(fallback.componentType, "gear (type unconfirmed)");
  assert.equal(fallback.gearType, "unknown");
  assert.equal(fallback.requiresGearTypeConfirmation, true);
  assert.equal(fallback.teeth, 30);
  assert.ok(fallback.dimensions.outerDiameter > 0);
  assert.ok(fallback.dimensions.innerDiameter > 0);
  assert.equal(fallback.geometryRecipe.style, "gear");
  assert.equal(fallback.geometryRecipe.gear.teeth, 30);
  assert.equal(fallback.provenance, "deterministic_fallback_engine");
  assert.equal(fallback.confidence, 0);
  assert.equal(fallback.geometrySource, "template_fallback");
  assert.ok(fallback.uncertainties.some((u) => /synthesized from a standard template/i.test(u)));

  // Non-toothed component defaults to flange with bolt holes, NOT a spur gear!
  const nonGearFallback = fallbackDeterministicAnalysis({ outerDiameter: 140 }, "Gemini offline");
  assert.equal(nonGearFallback.componentType, "flange");
  assert.equal(nonGearFallback.geometryRecipe.style, "flange");
  assert.ok(nonGearFallback.geometryRecipe.holes.length > 1);
});

test("reconcileGeminiWithVision accurately resolves flange and generates bolt holes pattern", () => {
  const geminiProposal = {
    componentType: "pipe flange",
    features: ["8 bolt holes", "central bore", "raised face"],
    dimensions: {
      outerDiameter: 150,
      innerDiameter: 50,
      height: 30,
      thickness: 18,
    },
    // Even if Gemini mistakenly proposed a revolved style
    geometryRecipe: {
      style: "revolved",
      revolvedProfile: [{ z: 0, radius: 25 }, { z: 30, radius: 75 }],
    },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, { outerDiameter: 160 });
  assert.equal(reconciled.componentType, "flange");
  assert.equal(reconciled.geometryRecipe.style, "flange");
  assert.ok(reconciled.geometryRecipe.flange);
  assert.equal(reconciled.geometryRecipe.flange.boltCount, 8);
  assert.ok(reconciled.geometryRecipe.holes.length >= 9); // 1 center bore + 8 bolt holes
  assert.equal(reconciled.dimensions.outerDiameter, 160);
  assert.equal(reconciled.geometrySource, "template_flange");
});

test("resolveGeometryFromVision deterministically resolves flange with bolt holes", () => {
  const mockVision = {
    images: [
      {
        opencv: {
          circles: [
            { radius_px: 100 }, // outer rim
            { radius_px: 30 },  // bore
            { radius_px: 10 },  // bolt 1
            { radius_px: 10 },  // bolt 2
            { radius_px: 10 },  // bolt 3
            { radius_px: 10 },  // bolt 4
          ],
        },
        calibration: {
          status: "calibrated",
          mm_per_pixel: 0.5,
        },
      },
    ],
  };

  const result = resolveGeometryFromVision(mockVision, { componentType: "flange" });
  assert.equal(result.canResolveWithoutGemini, true);
  assert.equal(result.analysis.componentType, "flange");
  assert.equal(result.analysis.geometryRecipe.style, "flange");
  assert.ok(result.analysis.geometryRecipe.holes.length > 1);
});

test("reconcileGeminiWithVision accurately resolves bevel gear with conical pitch angle and does not force spur gear", () => {
  const geminiProposal = {
    componentType: "bevel gear",
    gearType: "bevel",
    coneAngle: 45,
    teeth: 20,
    module: 3.5,
    features: ["20 conical bevel teeth", "45 deg pitch cone", "central bore", "rear hub collar"],
    dimensions: {
      outerDiameter: 85,
      innerDiameter: 22,
      height: 25,
      thickness: 25,
    },
    geometryRecipe: {
      style: "gear",
      gear: {
        teeth: 20,
        module: 3.5,
        coneAngle: 45,
        gearType: "bevel",
        faceWidth: 25,
        boreRadius: 11,
      },
    },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, {});
  assert.equal(reconciled.componentType, "bevel gear");
  assert.equal(reconciled.gearType, "bevel");
  assert.equal(reconciled.coneAngle, 45);
  assert.equal(reconciled.geometryRecipe.style, "gear");
  assert.equal(reconciled.geometryRecipe.gear.gearType, "bevel");
  assert.equal(reconciled.geometryRecipe.gear.coneAngle, 45);
  assert.ok(reconciled.geometryRecipe.gear.hubDiameter > 0);
  assert.ok(reconciled.geometryRecipe.gear.hubLength > 0);
  assert.equal(reconciled.geometrySource, "template_gear");
});

test("reconcileGeminiWithVision accurately resolves stepped shaft with multi-diameter profile", () => {
  const geminiProposal = {
    componentType: "stepped drive shaft",
    features: ["bearing journals", "spline head", "center shoulder"],
    dimensions: {
      outerDiameter: 42,
      innerDiameter: 0,
      height: 180,
      length: 180,
    },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, {});
  assert.equal(reconciled.componentType, "stepped shaft");
  assert.equal(reconciled.geometryRecipe.style, "revolved");
  assert.ok(Array.isArray(reconciled.geometryRecipe.revolvedProfile));
  assert.ok(reconciled.geometryRecipe.revolvedProfile.length >= 8);
  const radii = new Set(reconciled.geometryRecipe.revolvedProfile.map(p => p.radius));
  assert.ok(radii.size >= 3, "Profile must have multiple stepped radii");
  assert.equal(reconciled.geometrySource, "template_shaft");
  assert.ok(
    !reconciled.features.some((f) => /Involute Spline/i.test(String(f))),
    "the reconciler must not invent a spline feature"
  );
});

test("fallbackDeterministicAnalysis produces stepped shaft and bevel gear according to reference hints", () => {
  const bevelFallback = fallbackDeterministicAnalysis({ componentType: "bevel gear", teeth: 18 }, "Gemini offline");
  assert.equal(bevelFallback.componentType, "bevel gear");
  assert.equal(bevelFallback.gearType, "bevel");
  assert.equal(bevelFallback.geometryRecipe.gear.gearType, "bevel");
  assert.equal(bevelFallback.geometryRecipe.gear.coneAngle, 45);

  const shaftFallback = fallbackDeterministicAnalysis({ componentType: "shaft", length: 160, outerDiameter: 35 }, "Gemini offline");
  assert.equal(shaftFallback.componentType, "stepped shaft");
  assert.equal(shaftFallback.geometryRecipe.style, "revolved");
  assert.ok(shaftFallback.geometryRecipe.revolvedProfile.length >= 8);
  assert.equal(shaftFallback.geometrySource, "template_fallback");
});

test("reconcileGeminiWithVision keeps an extruded bracket recipe instead of forcing a flange", () => {
  const geminiProposal = {
    componentType: "mounting bracket",
    features: ["4 mounting holes", "counterbored", "gusset"],
    dimensions: { outerDiameter: 120, innerDiameter: 0, height: 40, width: 80, length: 120, thickness: 10 },
    geometryRecipe: {
      style: "extruded",
      depth: 10,
      outline: [
        { x: -40, y: -20 },
        { x: 40, y: -20 },
        { x: 40, y: 20 },
        { x: -40, y: 20 },
      ],
      holes: [
        { cx: 0, cy: 0, radius: 8 },
        { cx: -30, cy: 0, radius: 4 },
        { cx: 30, cy: 0, radius: 4 },
      ],
    },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, {});
  assert.equal(reconciled.componentType, "mounting bracket");
  assert.equal(reconciled.geometryRecipe.style, "extruded");
  assert.equal(reconciled.geometrySource, "image_recipe_refined");
});

test("reconcileGeminiWithVision does not turn a long plate into a stepped shaft", () => {
  const geminiProposal = {
    componentType: "mounting plate",
    features: ["through holes", "chamfered corners"],
    dimensions: { outerDiameter: 60, innerDiameter: 0, height: 12, width: 60, length: 200, thickness: 12 },
    geometryRecipe: {
      style: "extruded",
      depth: 12,
      outline: [
        { x: -30, y: -100 },
        { x: 30, y: -100 },
        { x: 30, y: 100 },
        { x: -30, y: 100 },
      ],
      holes: [],
    },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, {});
  assert.equal(reconciled.componentType, "mounting plate");
  assert.equal(reconciled.geometryRecipe.style, "extruded");
});

test("reconcileGeminiWithVision does not invent a gear bore", () => {
  const geminiProposal = {
    componentType: "spur gear",
    teeth: 24,
    dimensions: { outerDiameter: 96, innerDiameter: null, height: 20, thickness: 20 },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, {});
  assert.equal(reconciled.geometryRecipe.style, "gear");
  assert.equal(reconciled.geometryRecipe.gear.boreRadius, 0);
  assert.equal(reconciled.dimensions.innerDiameter, null);
});

test("reconcileGeminiWithVision accurately resolves and preserves prismatic extruded components (brackets/links)", () => {
  const geminiProposal = {
    componentType: "mounting bracket",
    dimensions: { width: 60, length: 140, thickness: 15, innerDiameter: 18 },
    features: ["Center Mounting Bore Ø18mm", "Dual Perimeter Holes Ø8mm", "Machined Aluminium Plate"],
    geometryRecipe: {
      style: "extruded",
      outline: [
        { x: -70, y: -30 },
        { x: 70, y: -30 },
        { x: 70, y: 30 },
        { x: -70, y: 30 },
      ],
      holes: [
        { cx: 0, cy: 0, radius: 9 },
        { cx: -45, cy: 0, radius: 4 },
        { cx: 45, cy: 0, radius: 4 },
      ],
      depth: 15,
    },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, {});
  assert.equal(reconciled.componentType, "mounting bracket");
  assert.equal(reconciled.geometryType, "prismatic_extruded");
  assert.equal(reconciled.geometryRecipe.style, "extruded");
  assert.equal(reconciled.geometryRecipe.outline.length, 4);
  assert.equal(reconciled.geometryRecipe.holes.length, 3);
  assert.equal(reconciled.dimensions.thickness, 15);
});

test("fallbackDeterministicAnalysis produces extruded bracket when prismatic reference is given", () => {
  const bracketFallback = fallbackDeterministicAnalysis({ componentType: "bracket", width: 50, length: 120, thickness: 12 }, "Gemini offline");
  assert.equal(bracketFallback.componentType, "bracket");
  assert.equal(bracketFallback.geometryType, "prismatic_extruded");
  assert.equal(bracketFallback.geometryRecipe.style, "extruded");
  assert.ok(bracketFallback.geometryRecipe.outline.length >= 4);
  assert.ok(bracketFallback.geometryRecipe.holes.length >= 1);
  assert.equal(bracketFallback.dimensions.width, 50);
  assert.equal(bracketFallback.dimensions.length, 120);
});

test("reconcileGeminiWithVision accurately resolves compound gear without turning into stepped shaft", () => {
  const geminiProposal = {
    componentType: "Compound Gear",
    teeth: 28,
    dimensions: { outerDiameter: 140, innerDiameter: 30, thickness: 50 },
    features: ["Stage 1 Spur Gear 28T", "Stage 2 Pinion Gear 16T", "Keyway Slot", "Central Bore"],
    geometryRecipe: {
      style: "compound_gear",
      gear: {
        stages: [
          { teeth: 28, module: 4.5, faceWidth: 28 },
          { teeth: 16, module: 4.5, faceWidth: 22 },
        ],
        boreRadius: 15,
        keyway: { width: 8, depth: 4 },
      },
    },
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, {});
  assert.equal(reconciled.componentType, "compound gear");
  assert.equal(reconciled.geometryType, "compound_gear_cluster");
  assert.equal(reconciled.geometryRecipe.style, "compound_gear");
  assert.equal(reconciled.geometryRecipe.gear.stages.length, 2);
  assert.equal(reconciled.geometryRecipe.gear.stages[0].teeth, 28);
  assert.equal(reconciled.geometryRecipe.gear.stages[1].teeth, 16);
  assert.ok(reconciled.geometryRecipe.gear.keyway);
});

test("reconcileGeminiWithVision accurately resolves flanged linear spline shaft without collapsing to flat flange", () => {
  const geminiProposal = {
    componentType: "linear spline shaft with flange",
    dimensions: { outerDiameter: 80, innerDiameter: 25, length: 220, thickness: 18 },
    features: ["4-Hole Circular Mounting Flange", "Longitudinal Spline Grooves", "Precision Linear Shaft"],
  };

  const reconciled = reconcileGeminiWithVision(geminiProposal, null, { outerDiameter: 80, innerDiameter: 25, length: 220 });
  assert.equal(reconciled.componentType, "flanged spline shaft");
  assert.equal(reconciled.geometryType, "flanged_linear_shaft");
  assert.equal(reconciled.geometryRecipe.style, "flanged_shaft");
  assert.ok(reconciled.geometryRecipe.shaft);
  assert.equal(reconciled.geometryRecipe.shaft.splineCount, 6);
  assert.ok(reconciled.geometryRecipe.flange);
  assert.equal(reconciled.geometryRecipe.flange.boltCount, 4);
  assert.ok(reconciled.geometryRecipe.meshData);
  assert.ok(reconciled.geometryRecipe.meshData.vertices.length > 100);
});

test("reconcileGeminiWithVision prevents shaft bore from turning compound gear into gear shaft", () => {
  const proposal = {
    componentType: "Compound Gear",
    teeth: 28,
    dimensions: { outerDiameter: 140, innerDiameter: 30, thickness: 50 },
    features: ["Stage 1 Spur Gear 28T", "Stage 2 Pinion Gear 16T", "Keyway for drive shaft", "Shaft mounting bore"],
  };
  const reconciled = reconcileGeminiWithVision(proposal, null, {});
  assert.equal(reconciled.componentType, "compound gear");
  assert.equal(reconciled.geometryType, "compound_gear_cluster");
  assert.equal(reconciled.geometryRecipe.style, "compound_gear");
  assert.equal(reconciled.geometryRecipe.gear.stages.length, 2);
});

test("reconcileGeminiWithVision accurately resolves helical pinion shaft without becoming compound gear or flat disc", () => {
  const proposal = {
    componentType: "helical pinion shaft",
    teeth: 18,
    helixAngle: 22.5,
    dimensions: { outerDiameter: 65, length: 240, thickness: 45 },
    features: ["Integral Helical Pinion", "Precision Ground Bearing Journals", "Drive Shaft Extension"],
  };
  const reconciled = reconcileGeminiWithVision(proposal, null, {});
  assert.equal(reconciled.componentType, "helical pinion shaft");
  assert.equal(reconciled.geometryType, "integral_pinion_shaft");
  assert.equal(reconciled.geometryRecipe.style, "pinion_shaft");
  assert.equal(reconciled.geometryRecipe.shaft.length, 240);
  assert.ok(reconciled.geometryRecipe.meshData);
});

test("fallbackDeterministicAnalysis produces authentic compound gear and flanged spline shaft", () => {
  const compFallback = fallbackDeterministicAnalysis({ componentType: "compound gear", teeth: 30, outerDiameter: 150 }, "Gemini offline");
  assert.equal(compFallback.componentType, "compound gear");
  assert.equal(compFallback.geometryRecipe.style, "compound_gear");
  assert.equal(compFallback.geometryRecipe.gear.stages.length, 2);

  const shaftFallback = fallbackDeterministicAnalysis({ componentType: "flanged spline shaft", outerDiameter: 76, length: 200, boltCount: 4 }, "Gemini offline");
  assert.equal(shaftFallback.componentType, "flanged spline shaft");
  assert.equal(shaftFallback.geometryRecipe.style, "flanged_shaft");
  assert.equal(shaftFallback.geometryRecipe.shaft.splineCount, 6);
  assert.equal(shaftFallback.geometryRecipe.flange.boltCount, 4);
});

test("PHASE 3: buildParameterConfidence classifies MEASURED vs ESTIMATED vs UNKNOWN correctly", () => {
  const proposal = {
    componentType: "helical pinion shaft",
    teeth: 18,
    helixAngle: 22.5,
    dimensions: { outerDiameter: 65, length: 240, thickness: 45 },
    features: ["Integral Helical Pinion", "Precision Ground Bearing Journals"],
  };
  // User provided verified outerDiameter and length
  const reference = { outerDiameter: 65, length: 240 };
  const reconciled = reconcileGeminiWithVision(proposal, null, reference);

  assert.ok(reconciled.parameterConfidence);
  assert.equal(reconciled.parameterConfidence.outerDiameter.status, "MEASURED");
  assert.equal(reconciled.parameterConfidence.outerDiameter.source, "user_reference");
  assert.equal(reconciled.parameterConfidence.length.status, "MEASURED");
  assert.equal(reconciled.parameterConfidence.length.source, "user_reference");
  assert.equal(reconciled.parameterConfidence.innerDiameter.status, "UNKNOWN");
  assert.ok(reconciled.uncertainties.length > 0);
});

test("OPERATOR A: reconcileGeminiWithVision outputs continuous axialSegments and avoids visualMesh hijacking", () => {
  const visionWithBoundary = {
    images: [{
      width: 640,
      height: 480,
      segmentation: {
        boundary_polygon_px: [{ x: 50, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 200 }, { x: 50, y: 200 }],
        candidate_count: 1,
      },
      depth: { depth_grid: [[0.5, 0.5], [0.5, 0.5]] }
    }]
  };
  const proposal = {
    componentType: "compound gear",
    teeth: 28,
    dimensions: { outerDiameter: 140, innerDiameter: 30, thickness: 50 },
    features: ["Stage 1 Bull Gear 28T", "Stage 2 Pinion 16T"],
  };
  const reconciled = reconcileGeminiWithVision(proposal, visionWithBoundary, {});
  // Must NOT be hijacked to 'mesh'
  assert.notEqual(reconciled.geometryRecipe.style, "mesh");
  assert.ok(Array.isArray(reconciled.geometryRecipe.axialSegments));
  assert.equal(reconciled.geometryRecipe.axialSegments.length, 2);
  assert.equal(reconciled.geometryRecipe.operator, "axial_segments");
});

test("OPERATOR A: resolveGeometryFromVision detects elongated pinion shaft from aspect ratio", () => {
  const visionWithElongatedShaft = {
    images: [{
      width: 640,
      height: 480,
      opencv: {
        symmetry_hints: ["teeth: 16"],
        bounding_box: {
          rotated_size_px: [320, 75], // 4.26:1 aspect ratio
        },
      },
    }],
  };
  const res = resolveGeometryFromVision(visionWithElongatedShaft, {});
  assert.equal(res.canResolveWithoutGemini, true);
  assert.equal(res.analysis.componentType, "helical pinion shaft");
  assert.equal(res.analysis.geometryType, "integral_pinion_shaft");
  assert.ok(res.analysis.geometryRecipe.axialSegments.length >= 3);
});

test("OPERATOR A: fallbackDeterministicAnalysis detects elongated shaft image without falling back to spur gear", () => {
  // A mock PNG with width 256 and height 64 (4:1 aspect ratio)
  const samplePngBase64 = Buffer.from('89504e470d0a1a0a0000000d4948445200000100000000400806000000', 'hex').toString('base64');
  const res = fallbackDeterministicAnalysis({}, "offline", [{ data: samplePngBase64, mimeType: "image/png" }]);
  assert.equal(res.componentType, "helical pinion shaft");
  assert.equal(res.geometryType, "integral_pinion_shaft");
  assert.ok(res.geometryRecipe.axialSegments.length >= 3);
  assert.equal(res.dimensions.innerDiameter, 0); // solid core
});

test("OPERATOR A: fallbackDeterministicAnalysis produces multi-junction precision worm drive shaft", () => {
  const samplePngBase64 = Buffer.from('89504e470d0a1a0a0000000d4948445200000100000000400806000000', 'hex').toString('base64');
  const res = fallbackDeterministicAnalysis({ name: "Worm Screw Shaft" }, "offline", [{ data: samplePngBase64, mimeType: "image/png" }]);
  assert.equal(res.componentType, "precision worm drive shaft");
  assert.equal(res.geometryType, "worm_drive_spindle");
  assert.equal(res.geometryRecipe.style, "axial_segments");
  assert.equal(res.geometryRecipe.axialSegments.length, 7);
  assert.equal(res.geometryRecipe.modifiers.length, 2);
  const wormFlight = res.geometryRecipe.axialSegments.find(s => s.featureType === "worm_thread");
  assert.ok(wormFlight);
  assert.equal(wormFlight.starts, 1);
  assert.equal(wormFlight.pitch, 8.0);
});
