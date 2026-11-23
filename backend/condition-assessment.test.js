import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPixelEvidence,
  conditionPrompt,
  deriveConditionAssessment,
  heatLevel,
  unknownConditionAssessment,
} from "./condition-assessment.js";

test("severely corroded gear gets non-zero wear evidence and a reduced score", () => {
  const raw = {
    imageQuality: "adequate",
    observations: [
      {
        type: "corrosion",
        severity: "severe",
        extent: "widespread",
        evidence: "thick flaking orange oxide across tooth flanks and rim",
        confidence: 0.95,
      },
      {
        type: "surface_pitting",
        severity: "moderate",
        extent: "widespread",
        evidence: "numerous small craters on the tooth faces",
        confidence: 0.8,
      },
      {
        type: "tooth_wear",
        severity: "moderate",
        extent: "localized",
        evidence: "rounded tooth tips",
        confidence: 0.7,
      },
    ],
    suspectedInternal: [],
    summary: "Severe corrosion with surface deterioration.",
  };

  const result = deriveConditionAssessment(raw);

  assert.equal(result.status, "ACTION REQUIRED");
  assert.ok(result.healthScore < 60, `expected reduced score, got ${result.healthScore}`);
  assert.ok(result.wearEvidenceCount >= 3);
  assert.ok(result.observedDefects.some((tag) => /Corrosion/i.test(tag)));
  assert.ok(result.observedDefects.some((tag) => /Surface pitting/i.test(tag)));
  assert.ok(result.observedDefectTypes.includes("corrosion"));
  assert.ok(
    result.recommendedVerification.some((item) =>
      /remaining sound metal|pitting/i.test(item)
    )
  );
  assert.equal(result.critical, true);
  assert.equal(result.source, "visual-photograph");
});

test("insufficient image quality produces NEEDS INSPECTION with no invented score", () => {
  const result = deriveConditionAssessment({
    imageQuality: "insufficient",
    observations: [],
    suspectedInternal: [],
    summary: "Image too blurred to judge surface condition.",
  });

  assert.equal(result.status, "NEEDS INSPECTION");
  assert.equal(result.healthScore, null);
  assert.equal(result.wearEvidenceCount, 0);
  assert.deepEqual(result.observedDefects, []);
});

test("clean component with adequate images is NORMAL without defect tags", () => {
  const result = deriveConditionAssessment({
    imageQuality: "adequate",
    observations: [],
    suspectedInternal: [],
    summary: "No visible damage.",
  });

  assert.equal(result.status, "NORMAL");
  assert.equal(result.healthScore, 100);
  assert.equal(result.wearEvidenceCount, 0);
  assert.equal(result.critical, false);
});

test("suspected internal damage is separated from observed defects and blocks NORMAL", () => {
  const result = deriveConditionAssessment({
    imageQuality: "adequate",
    observations: [],
    suspectedInternal: [
      { concern: "subsurface fatigue", reason: "cannot be excluded from photographs" },
    ],
    summary: "Surface looks sound.",
  });

  assert.equal(result.status, "NEEDS INSPECTION");
  assert.equal(result.healthScore, null);
  assert.equal(result.wearEvidenceCount, 0);
  assert.ok(result.suspectedInternal[0].startsWith("Unconfirmed"));
  assert.ok(result.suspectedInternal[0].includes("Not established from photographs"));
  assert.ok(
    result.recommendedVerification.some((item) => /NDT/i.test(item))
  );
});

test("duplicate observations are aggregated into a single defect tag", () => {
  const result = deriveConditionAssessment({
    imageQuality: "adequate",
    observations: [
      {
        type: "corrosion",
        severity: "moderate",
        extent: "localized",
        evidence: "rust on hub",
        confidence: 0.8,
      },
      {
        type: "corrosion",
        severity: "severe",
        extent: "widespread",
        evidence: "rust across teeth",
        confidence: 0.9,
      },
    ],
    suspectedInternal: [],
    summary: "",
  });

  assert.equal(result.wearEvidenceCount, 1);
  assert.match(result.observedDefects[0], /^Severe Corrosion widespread/);
  assert.ok(result.healthScore < 70);
});

test("visible crack observation is reported as observed, not suspected", () => {
  const result = deriveConditionAssessment({
    imageQuality: "adequate",
    observations: [
      {
        type: "crack",
        severity: "severe",
        extent: "localized",
        evidence: "linear fracture visible at one tooth root",
        confidence: 0.95,
      },
    ],
    suspectedInternal: [],
    summary: "",
  });

  assert.ok(result.observedDefects.some((tag) => /Visible crack/i.test(tag)));
  assert.equal(result.suspectedInternal.length, 0);
  assert.equal(result.status, "ACTION REQUIRED");
});

test("unavailable assessment fails closed to NEEDS INSPECTION", () => {
  const result = unknownConditionAssessment("Gemini unavailable");
  assert.equal(result.status, "NEEDS INSPECTION");
  assert.equal(result.healthScore, null);
  assert.equal(result.wearEvidenceCount, 0);
  assert.deepEqual(result.damageRegions, []);
  assert.match(result.summary, /Gemini unavailable/);
});

test("visible defects produce localised, severity-coloured heatmap regions", () => {
  const result = deriveConditionAssessment(
    {
      imageQuality: "adequate",
      observations: [
        {
          type: "rust",
          severity: "severe",
          extent: "localized",
          evidence: "orange oxide on one tooth flank",
          confidence: 0.9,
          regions: [
            { imageIndex: 0, x: 0.2, y: 0.3, width: 0.15, height: 0.12, confidence: 0.9 },
          ],
        },
        {
          type: "corrosion",
          severity: "severe",
          extent: "widespread",
          evidence: "oxide across the rim",
          confidence: 0.95,
          regions: [
            { imageIndex: 1, x: 0.1, y: 0.1, width: 0.7, height: 0.5, confidence: 0.95 },
          ],
        },
        {
          type: "surface_pitting",
          severity: "minor",
          extent: "localized",
          evidence: "a few small craters near the bore",
          confidence: 0.8,
          regions: [
            { imageIndex: 0, x: 0.45, y: 0.55, width: 0.08, height: 0.06, confidence: 0.8 },
          ],
        },
      ],
      suspectedInternal: [],
      summary: "Visible corrosion and pitting.",
    },
    { imageCount: 2 }
  );

  assert.equal(result.damageRegions.length, 3);
  assert.deepEqual(
    result.damageRegions.map((r) => r.level),
    ["high", "severe", "low"]
  );
  assert.deepEqual(result.damageRegions.map((r) => r.imageIndex), [0, 1, 0]);
  assert.equal(result.damageRegions[0].type, "rust");
  assert.equal(result.damageRegions[1].label, "Corrosion");
  assert.equal(result.damageRegions[0].confidence, 0.9);
});

test("heatmap regions are clamped and invalid boxes are discarded", () => {
  const result = deriveConditionAssessment(
    {
      imageQuality: "adequate",
      observations: [
        {
          type: "crack",
          severity: "moderate",
          extent: "localized",
          evidence: "visible linear indication",
          confidence: 0.85,
          regions: [
            // out-of-range coordinates are clamped to the supplied image
            { imageIndex: 9, x: -0.2, y: -0.1, width: 2, height: 0.2, confidence: 0.8 },
            // zero-size box cannot represent a detected area
            { imageIndex: 0, x: 0.1, y: 0.1, width: 0, height: 0.2, confidence: 0.9 },
            // low-confidence guess must not be painted as damage
            { imageIndex: 0, x: 0.5, y: 0.5, width: 0.1, height: 0.1, confidence: 0.2 },
            // non-numeric garbage
            { imageIndex: "front", x: "left", y: 0, width: 0.2, height: 0.2, confidence: 0.9 },
          ],
        },
      ],
      suspectedInternal: [],
      summary: "",
    },
    { imageCount: 2 }
  );

  assert.equal(result.damageRegions.length, 1);
  const region = result.damageRegions[0];
  assert.equal(region.imageIndex, 1);
  assert.equal(region.x, 0);
  assert.equal(region.y, 0);
  assert.equal(region.width, 1);
  assert.ok(region.height > 0 && region.height <= 1);
  assert.equal(region.level, "moderate");
});

test("insufficient image quality and clean components produce no heatmap regions", () => {
  const insufficient = deriveConditionAssessment({
    imageQuality: "insufficient",
    observations: [
      {
        type: "rust",
        severity: "severe",
        extent: "widespread",
        evidence: "blurred orange area",
        confidence: 0.9,
        regions: [{ imageIndex: 0, x: 0, y: 0, width: 1, height: 1, confidence: 0.9 }],
      },
    ],
    suspectedInternal: [],
    summary: "",
  });
  assert.deepEqual(insufficient.damageRegions, []);

  const clean = deriveConditionAssessment({
    imageQuality: "adequate",
    observations: [],
    suspectedInternal: [],
    summary: "No visible damage.",
  });
  assert.deepEqual(clean.damageRegions, []);
});

test("heat level mapping keeps green/yellow/orange/red distinct", () => {
  assert.equal(heatLevel("minor", "localized"), "low");
  assert.equal(heatLevel("moderate", "widespread"), "moderate");
  assert.equal(heatLevel("severe", "localized"), "high");
  assert.equal(heatLevel("severe", "widespread"), "severe");
});

test("pixel evidence replaces a broad model severity with measured coverage", () => {
  const broad = deriveConditionAssessment({
    imageQuality: "adequate",
    observations: [
      {
        type: "corrosion",
        severity: "moderate",
        extent: "widespread",
        evidence: "possible oxidation",
        confidence: 0.8,
      },
    ],
    suspectedInternal: [],
    summary: "",
  });

  const result = applyPixelEvidence(broad, {
    maskedPixels: 220,
    severity: "minor",
    extent: "localized",
    damageRatioOfComponent: 0.012,
    connectedRegions: 2,
    confidence: 0.8,
    types: ["rust"],
  });

  assert.equal(result.severity, "minor");
  assert.equal(result.extent, "localized");
  assert.match(result.observedDefects[0], /^Minor Surface rust/);
  assert.ok(result.healthScore > 85);
  assert.equal(result.status, "ATTENTION ADVISED");
  assert.equal(result.pixelEvidence.confirmed, true);
});

test("severe widespread pixel coverage still produces a reduced score", () => {
  const result = applyPixelEvidence(
    deriveConditionAssessment({
      imageQuality: "adequate",
      observations: [],
      suspectedInternal: [],
      summary: "",
    }),
    {
      maskedPixels: 18000,
      severity: "severe",
      extent: "widespread",
      damageRatioOfComponent: 0.36,
      connectedRegions: 14,
      confidence: 0.94,
      types: ["rust", "surface_pitting"],
    }
  );

  assert.equal(result.status, "ACTION REQUIRED");
  assert.ok(result.healthScore < 60);
  assert.equal(result.critical, true);
  assert.equal(result.wearEvidenceCount, 2);
});

test("broad defect claims without pixel evidence fail closed", () => {
  const broad = deriveConditionAssessment({
    imageQuality: "adequate",
    observations: [
      {
        type: "corrosion",
        severity: "moderate",
        extent: "widespread",
        evidence: "broad orange tint",
        confidence: 0.7,
      },
    ],
    suspectedInternal: [],
    summary: "",
  });

  const result = applyPixelEvidence(broad, { maskedPixels: 0, types: [] });
  assert.equal(result.status, "NEEDS INSPECTION");
  assert.equal(result.healthScore, null);
  assert.equal(result.pixelEvidence.confirmed, false);
});

test("conditionPrompt uses the confirmed gear type and reconstructed gear geometry", () => {
  const prompt = conditionPrompt({
    componentType: "helical gear",
    gearType: "helical",
    geometryRecipe: { gear: { teeth: 24, module: 4, helixAngle: 25 } },
  });
  assert.match(prompt, /Confirmed gear type: helical/);
  assert.match(prompt, /angled tooth flanks/);
  assert.match(prompt, /24 teeth, module 4 mm, helix 25°/);
  assert.doesNotMatch(prompt, /Describe damage on straight parallel tooth flanks/);
});

test("conditionPrompt does not apply spur vocabulary to a worm gear", () => {
  const prompt = conditionPrompt({
    componentType: "worm gear",
    gearType: "worm",
    geometryRecipe: { gear: { teeth: 1, pitch: 8, starts: 1 } },
  });
  assert.match(prompt, /Confirmed gear type: worm/);
  assert.match(prompt, /continuous worm flight/);
  assert.doesNotMatch(prompt, /Describe damage on straight parallel tooth flanks/);
});

test("conditionPrompt flags unconfirmed tooth form instead of assuming spur", () => {
  const prompt = conditionPrompt({
    componentType: "gear (type unconfirmed)",
    gearType: "unknown",
    requiresGearTypeConfirmation: true,
    geometryRecipe: { gear: { teeth: 20 } },
  });
  assert.match(prompt, /tooth form is unconfirmed/);
  assert.doesNotMatch(prompt, /Confirmed gear type/);
});

test("type-specific verification follows the confirmed gear type", () => {
  const raw = {
    imageQuality: "adequate",
    observations: [
      {
        type: "tooth_wear",
        severity: "moderate",
        extent: "localized",
        evidence: "polished flight flank",
        confidence: 0.9,
      },
    ],
    suspectedInternal: [],
    summary: "",
  };
  const worm = deriveConditionAssessment(raw, { gearType: "worm" });
  const bevel = deriveConditionAssessment(raw, { gearType: "bevel" });
  assert.equal(worm.assessedGearType, "worm");
  assert.ok(worm.recommendedVerification.some((item) => /worm flight/i.test(item)));
  assert.equal(bevel.assessedGearType, "bevel");
  assert.ok(bevel.recommendedVerification.some((item) => /pitch cone/i.test(item)));
});
