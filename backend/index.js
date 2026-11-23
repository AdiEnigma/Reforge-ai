import express from "express";
import path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeComponent, chatWithEngineer, sanitizeRecipe } from "./gemini.js";
import { computeManufacturingIntelligence } from "./manufacturing.js";
import { computeMaterialAlternatives } from "./material-comparison.js";
import { simulateEngineeringChange, analyzeDimensionSensitivity } from "./engineering-analysis.js";
import { isVisionEnabled, callVisionService, buildVisionEvidenceSummary } from './vision-adapter.js';
import { isReconstructionEnabled, callReconstructionService } from './reconstruction-adapter.js';
import { applyPixelEvidence, assessVisualCondition, unknownConditionAssessment } from './condition-assessment.js';
import { generateDamageMasks } from './damage-mask-adapter.js';
import { exportCadModel, isCadExportScriptPresent } from './cad-export-adapter.js';
import { retrieveDatasetModel, getDatasetServiceStatus } from './dataset-adapter.js';
import {
  getCatalogSummary,
  resolveAssetForDatasetModel,
  resolveDatasetAsset,
} from './dataset-catalog.js';
import { storeSpatialEvidence, getSpatialEvidence } from './src/spatial-evidence-store.js';
import {
  resolveGeometryFromVision,
  reconcileGeminiWithVision,
  fallbackDeterministicAnalysis,
  extractVisionObservations,
} from "./src/vision-geometry-resolver.js";
import { gearTypeFromText, normalizeGearType } from "./src/gear-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-load environment configuration from .env.local or .env
for (const envFile of [".env.local", ".env"]) {
  const envPath = path.resolve(__dirname, envFile);
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(envPath); } catch { }
  }
}

const PORT = Number(process.env.PORT) || 8787;
const MAX_IMAGES = 8;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: `${MAX_BODY_BYTES}` }));

function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    const error = new Error("No images provided. Add at least one component image.");
    error.status = 400;
    throw error;
  }
  if (images.length > MAX_IMAGES) {
    const error = new Error(`Too many images. Max ${MAX_IMAGES} views per analysis.`);
    error.status = 400;
    throw error;
  }
  const clean = [];
  for (const image of images) {
    if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string") {
      const error = new Error("Each image must include base64 data and a mimeType.");
      error.status = 400;
      throw error;
    }
    if (!image.mimeType.startsWith("image/")) {
      const error = new Error(`Invalid image type: ${image.mimeType || "unknown"}. Use PNG, JPG, WEBP or GIF.`);
      error.status = 400;
      throw error;
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(image.data) || image.data.length < 100) {
      const error = new Error("One of the images is not valid base64 data.");
      error.status = 400;
      throw error;
    }
    clean.push({ data: image.data, mimeType: image.mimeType });
  }
  return clean;
}

const REFERENCE_KEYS = ["outerDiameter", "innerDiameter", "height", "length", "thickness", "width", "teeth", "module", "helixAngle", "coneAngle", "pitch", "starts", "boltCount"];

function sanitizeReference(raw) {
  if (!raw || typeof raw !== "object") return {};
  const clean = {};
  if (typeof raw.name === "string") clean.name = raw.name.slice(0, 150);
  if (typeof raw.notes === "string") clean.notes = raw.notes.slice(0, 500);
  if (typeof raw.componentType === "string") clean.componentType = raw.componentType.slice(0, 100);
  if (typeof raw.role === "string") clean.role = raw.role.slice(0, 50);
  if (typeof raw.gearType === "string") clean.gearType = normalizeGearType(raw.gearType);

  for (const key of REFERENCE_KEYS) {
    const value = raw[key];
    if (typeof value !== "number" || !isFinite(value)) continue;
    if (key === "teeth") {
      if (value >= 4 && value <= 400) clean[key] = Math.round(value);
    } else if (key === "helixAngle") {
      if (value >= 0 && value <= 60) clean[key] = value;
    } else if (key === "module") {
      if (value > 0 && value <= 100) clean[key] = value;
    } else if (key === "coneAngle") {
      if (value > 0 && value <= 90) clean[key] = value;
    } else if (key === "starts") {
      if (value >= 1 && value <= 32) clean[key] = Math.round(value);
    } else if (key === "boltCount") {
      if (value >= 2 && value <= 64) clean[key] = Math.round(value);
    } else if (value > 0 && value <= 100000) {
      clean[key] = value;
    }
  }
  return clean;
}

const ANALYSIS_STAGES = Object.freeze({
  IMAGE: 'image-analysis',
  GEOMETRY: 'geometry-extraction',
  DATASET: 'dataset-matching',
  GEMINI: 'gemini-reconstruction',
});

async function attachConditionAssessment({ analysis, images }) {
  // Visual condition and pixel masks are image-space diagnostics, not geometry.
  // They are computed on demand (health panel / heatmap) so initial 3D
  // reconstruction never waits for a second Gemini call or OpenCV segmentation.
  try {
    analysis.conditionAssessment = await assessVisualCondition({ images, analysis });
  } catch (conditionError) {
    console.warn('[analyze-component] Visual condition assessment failed:', conditionError?.message);
    analysis.conditionAssessment = unknownConditionAssessment();
  }

  analysis.conditionAssessment.damageMasks = [];
  try {
    const masks = await generateDamageMasks({
      images,
      observedTypes: analysis.conditionAssessment.observedDefectTypes || [],
    });
    analysis.conditionAssessment.damageMasks = masks;
    const primaryMask = masks.reduce((best, mask) => {
      if (!best) return mask;
      return mask.stats.damageRatioOfComponent > best.stats.damageRatioOfComponent ? mask : best;
    }, null);
    analysis.conditionAssessment = applyPixelEvidence(
      analysis.conditionAssessment,
      primaryMask?.stats
    );
  } catch (maskError) {
    // Never fall back to broad rectangles: an unavailable mask simply means
    // no areas are painted and no pixel-derived score is asserted.
    console.warn('[analyze-component] Pixel damage segmentation failed:', maskError?.message);
    analysis.conditionAssessment.damageMaskUnavailable = true;
    analysis.conditionAssessment = applyPixelEvidence(analysis.conditionAssessment, null);
  }
  return analysis.conditionAssessment;
}

function summarizeDatasetResult(result) {
  if (!result) return { status: 'not_attempted' };
  return {
    status: result.status,
    confidence: result.confidence || 0,
    provenance: result.analysis?.provenance || null,
    validation: result.analysis?.validation || null,
    candidates: (result.candidates || []).slice(0, 5).map((candidate) => ({
      id: candidate.id,
      dataset: candidate.dataset,
      confidence: candidate.confidence,
      accepted: candidate.accepted,
      scores: candidate.scores,
      violations: candidate.violations,
    })),
    diagnostics: result.diagnostics || {},
  };
}

class ReconstructionCancelledError extends Error {
  constructor() {
    super('Reconstruction cancelled.');
    this.name = 'ReconstructionCancelledError';
    this.status = 499;
  }
}

async function runComponentAnalysis({ body, onProgress = () => {}, isCancelled = () => false }) {
  const emit = (stage, status, detail = {}) => {
    if (!isCancelled()) onProgress({ stage, status, ...detail });
  };
  const checkCancelled = () => {
    if (isCancelled()) throw new ReconstructionCancelledError();
  };

  emit(ANALYSIS_STAGES.IMAGE, 'running');
  let images;
  try {
    images = validateImages(body?.images);
  } catch (error) {
    error.stage = ANALYSIS_STAGES.IMAGE;
    throw error;
  }
  emit(ANALYSIS_STAGES.IMAGE, 'complete', { completed: images.length, total: images.length });
  checkCancelled();

  const reference = sanitizeReference(body?.reference);

  emit(ANALYSIS_STAGES.GEOMETRY, 'running');
  let visionEvidence = null;
  let rawVisionResult = null;
  let spatialEvidenceRef = null;
  if (isVisionEnabled()) {
    try {
      const visionResult = await callVisionService(images, reference);
      if (visionResult) {
        rawVisionResult = visionResult;
        spatialEvidenceRef = storeSpatialEvidence(visionResult);
        visionEvidence = buildVisionEvidenceSummary(visionResult, spatialEvidenceRef);
      }
    } catch (visionError) {
      // callVisionService should never throw (resolves null on error), but guard anyway
      console.warn('[analyze-component] Unexpected vision error (continuing without vision):', visionError?.message);
    }
  }
  emit(ANALYSIS_STAGES.GEOMETRY, 'complete');
  checkCancelled();

  let analysis = null;
  let solverMode = null;

  emit(ANALYSIS_STAGES.DATASET, 'running');
  let datasetResult = null;
  try {
    datasetResult = await retrieveDatasetModel({ images, reference, visionEvidence });
  } catch (datasetError) {
    // The adapter is expected to fail open; this guard keeps a malformed
    // service response from taking down the whole analysis pipeline.
    console.warn('[analyze-component] Unexpected dataset retrieval error:', datasetError?.message);
    datasetResult = {
      status: 'unavailable',
      confidence: 0,
      candidates: [],
      diagnostics: { reason: datasetError?.message || 'Dataset retrieval failed.' },
    };
  }

  if (datasetResult.status === 'match' && datasetResult.analysis) {
    analysis = datasetResult.analysis;
    solverMode = 'dataset_retrieval';
    emit(ANALYSIS_STAGES.DATASET, 'complete', {
      message: `Matched ${datasetResult.analysis.datasetModel?.assetId || 'dataset asset'} with confidence ${Math.round((datasetResult.confidence || 0) * 100)}%.`,
      confidence: datasetResult.confidence,
      source: datasetResult.analysis.provenance?.dataset || 'dataset',
    });
    emit(ANALYSIS_STAGES.GEMINI, 'skipped', {
      message: 'Dataset match supplied geometry; Gemini reconstruction skipped.',
    });
  } else {
    // No reliable dataset hit: keep the existing vision solver, then Gemini.
    const visionResolution = resolveGeometryFromVision(rawVisionResult, reference);
    if (visionResolution.canResolveWithoutGemini && visionResolution.confidence >= 0.80) {
      analysis = visionResolution.analysis;
      solverMode = "deterministic_cv";
      emit(ANALYSIS_STAGES.DATASET, 'complete', {
        message: 'No reliable dataset match; resolved from measured vision evidence.',
      });
      emit(ANALYSIS_STAGES.GEMINI, 'skipped', {
        message: 'Measured vision evidence supplied geometry; Gemini reconstruction skipped.',
      });
    } else {
      emit(ANALYSIS_STAGES.DATASET, rawVisionResult ? 'complete' : 'skipped', {
        message: datasetResult.diagnostics?.reason
          || (rawVisionResult
            ? 'No reliable dataset match; using Gemini reconstruction.'
            : 'Dataset retrieval unavailable; using Gemini reconstruction.'),
      });
    }
  }
  checkCancelled();

  if (!analysis) {
    emit(ANALYSIS_STAGES.GEMINI, 'running');
    try {
      const geminiRaw = await analyzeComponent({ images, reference, visionEvidence });
      // Reconcile Gemini's high-level semantic proposal with exact physical measurements & vision
      analysis = reconcileGeminiWithVision(geminiRaw, rawVisionResult, reference);
      solverMode = "gemini_assisted";
      emit(ANALYSIS_STAGES.GEMINI, 'complete');
    } catch (geminiError) {
      console.warn('[analyze-component] Gemini assist failed or unavailable (falling back to deterministic solver):', geminiError?.message);
      // Guaranteed zero-crash fallback: synthesized engineering geometry adhering to ISO standards
      analysis = fallbackDeterministicAnalysis(reference, geminiError?.message || 'Gemini assist offline', images);
      solverMode = "deterministic_fallback";
      emit(ANALYSIS_STAGES.GEMINI, 'complete', {
        warning: 'Gemini unavailable; deterministic fallback used.',
      });
    }
  }
  checkCancelled();

  if (body?.includeCondition === true) {
    await attachConditionAssessment({ analysis, images });
    checkCancelled();
  }

  // Anchor spatial evidence to analysis object
  if (analysis && typeof analysis === 'object') {
    if (spatialEvidenceRef) {
      analysis.spatialEvidenceRef = spatialEvidenceRef;
    }
    if (rawVisionResult) {
      analysis.spatialObservations = extractVisionObservations(rawVisionResult);
    }
  }

  const responseBody = {
    analysis,
    solverMode,
    datasetRetrieval: summarizeDatasetResult(datasetResult),
    spatialEvidenceRef,
  };
  if (visionEvidence) {
    responseBody.visionDiagnostics = {
      status: visionEvidence.status,
      images: visionEvidence.images.map((img) => ({
        image_index: img.image_index,
        segmentation_status: img.segmentation?.status ?? 'unavailable',
        candidate_count: img.segmentation?.candidate_count ?? 0,
        depth_status: img.depth?.status ?? 'unavailable',
        opencv_contour_count: img.opencv?.contour_count ?? 0,
        warnings: [
          ...(img.opencv?.warnings || []),
          ...(img.depth?.warnings || []),
        ],
      })),
      warnings: visionEvidence.warnings || [],
    };
  }
  return responseBody;
}


      app.post("/api/analyze-component", async (req, res) => {
        try {
          res.json(await runComponentAnalysis({ body: req.body }));
        } catch (error) {
          res.status(error.status || 500).json({ error: error.message || "Analysis failed." });
        }
      });

      app.post("/api/analyze-component/stream", async (req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        let cancelled = false;
        res.on('close', () => {
          if (!res.writableEnded) cancelled = true;
        });

        const emit = (event) => {
          if (cancelled || res.destroyed || res.writableEnded) return;
          res.write(`${JSON.stringify(event)}\n`);
        };

        try {
          const result = await runComponentAnalysis({
            body: req.body,
            onProgress: emit,
            isCancelled: () => cancelled,
          });
          if (cancelled || res.destroyed) return;
          emit({ type: 'result', ...result });
          res.end();
        } catch (error) {
          if (cancelled || res.destroyed) return;
          emit({
            type: 'failed',
            stage: error.stage,
            message: error.message || 'Analysis failed.',
          });
          res.end();
        }
      });

      app.get("/api/spatial-evidence/:evidenceId", async (req, res) => {
        try {
          const { evidenceId } = req.params;
          const evidence = getSpatialEvidence(evidenceId);
          if (!evidence) {
            return res.status(404).json({ error: "Spatial evidence not found or expired." });
          }
          res.json(evidence);
        } catch (error) {
          res.status(500).json({ error: error.message || "Failed to retrieve spatial evidence." });
        }
      });

      app.post("/api/chat", async (req, res) => {
        try {
          const rawContext = req.body?.engineeringContext;
          const engineeringContext = rawContext ? validateEngineeringContext(rawContext) : null;
          const rawAnalysis = req.body?.analysis;
          const analysis = rawAnalysis ? validateAnalysisShape(rawAnalysis) : null;

          const result = await chatWithEngineer({
            message: req.body?.message,
            engineeringContext,
            analysis,
            history: req.body?.history,
          });
          res.json(result);
        } catch (error) {
          res.status(error.status || 500).json({ error: error.message || "Chat failed." });
        }
      });

      app.post("/api/engineering-simulate", (req, res) => {
        try {
          const analysis = validateAnalysisShape(req.body?.analysis);
          const modifications = Array.isArray(req.body?.modifications) ? req.body.modifications : [];
          const quantity = clampQuantity(req.body?.quantity);

          const result = simulateEngineeringChange({ analysis, modifications, quantity });
          res.json(result);
        } catch (error) {
          res.status(error.status || 500).json({ error: error.message || "Simulation failed." });
        }
      });

      app.post("/api/engineering-sensitivity", (req, res) => {
        try {
          const analysis = validateAnalysisShape(req.body?.analysis);
          const sensitivity = analyzeDimensionSensitivity({ analysis });
          res.json({ sensitivity });
        } catch (error) {
          res.status(error.status || 500).json({ error: error.message || "Sensitivity analysis failed." });
        }
      });

      // ---------------------------------------------------------------------------
      // Helpers for /api/manufacturing-intelligence
      // ---------------------------------------------------------------------------

      /**
       * Validate and sanitize untrusted client-supplied engineeringContext.
       */
      function validateEngineeringContext(raw) {
        if (!raw || typeof raw !== "object") return null;

        const comp = raw.component && typeof raw.component === "object" ? raw.component : {};
        const dims = raw.dimensions && typeof raw.dimensions === "object" ? raw.dimensions : {};
        const mat = raw.material && typeof raw.material === "object" ? raw.material : {};
        const mfg = raw.manufacturing && typeof raw.manufacturing === "object" ? raw.manufacturing : null;
        const geom = raw.geometry && typeof raw.geometry === "object" ? raw.geometry : {};
        const conf = raw.confidence && typeof raw.confidence === "object" ? raw.confidence : {};

        const cleanDims = {};
        for (const [k, v] of Object.entries(dims)) {
          if (typeof v === "number" && isFinite(v) && v > 0) cleanDims[k] = v;
          else cleanDims[k] = null;
        }

        const cleanFeatures = Array.isArray(raw.features)
          ? raw.features.slice(0, 15).map((f) => ({
            id: typeof f.id === "string" ? f.id.slice(0, 40) : "feature",
            type: typeof f.type === "string" ? f.type.slice(0, 30) : "other",
            label: typeof f.label === "string" ? f.label.slice(0, 50) : "Feature",
            confidence: typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0.8,
            metadata: f.metadata && typeof f.metadata === "object" ? f.metadata : null,
          }))
          : [];

        return {
          component: {
            type: typeof comp.type === "string" ? comp.type.slice(0, 60) : "mechanical component",
            name: typeof comp.name === "string" ? comp.name.slice(0, 60) : "COMPONENT",
          },
          dimensions: cleanDims,
          material: {
            key: typeof mat.key === "string" ? mat.key.slice(0, 30) : "mild_steel",
            label: typeof mat.label === "string" ? mat.label.slice(0, 40) : "Mild Steel",
            source: typeof mat.source === "string" ? mat.source.slice(0, 30) : "fallback-default",
            densityGCm3: typeof mat.densityGCm3 === "number" ? mat.densityGCm3 : 7.85,
            costPerKgINR: typeof mat.costPerKgINR === "number" ? mat.costPerKgINR : 65,
            isAssumed: Boolean(mat.isAssumed),
          },
          geometry: {
            style: typeof geom.style === "string" ? geom.style.slice(0, 30) : "parametric",
            recipe: geom.recipe && typeof geom.recipe === "object" ? geom.recipe : null,
            featureCount: typeof geom.featureCount === "number" ? geom.featureCount : cleanFeatures.length,
            holeCount: typeof geom.holeCount === "number" ? geom.holeCount : 0,
          },
          features: cleanFeatures,
          manufacturing: mfg,
          materialAlternatives: Array.isArray(raw.materialAlternatives) ? raw.materialAlternatives.slice(0, 5) : null,
          confidence: {
            overall: typeof conf.overall === "number" ? Math.max(0, Math.min(1, conf.overall)) : 0.8,
            uncertainties: Array.isArray(conf.uncertainties) ? conf.uncertainties.slice(0, 5) : [],
          },
          machineryContext: raw.machineryContext && typeof raw.machineryContext === "object" ? raw.machineryContext : null,
        };
      }

      const DIMENSION_KEYS = ["outerDiameter", "innerDiameter", "height", "width", "length", "thickness"];

      /**
       * Validate that analysis has the expected shape.
       * Strips unknown fields; validates dimensions; re-sanitises geometryRecipe.
       * Throws 400 on clearly malformed input.
       */
      function validateAnalysisShape(raw) {
        if (!raw || typeof raw !== "object") {
          const err = new Error("analysis must be a non-null object.");
          err.status = 400;
          throw err;
        }

        const dims = raw.dimensions && typeof raw.dimensions === "object" ? raw.dimensions : {};
        const cleanDims = {};
        for (const key of DIMENSION_KEYS) {
          const val = dims[key];
          cleanDims[key] = typeof val === "number" && isFinite(val) && val > 0 ? val : null;
        }
        const cleanNumber = (value) => (
          typeof value === "number" && isFinite(value) ? value : null
        );
        const geometryRecipe = sanitizeRecipe(raw.geometryRecipe);
        const features = Array.isArray(raw.features) ? raw.features.filter((f) => typeof f === "string") : [];
        const componentType = typeof raw.componentType === "string" ? raw.componentType : "other";
        const rawExplicitType = raw.gearType ?? geometryRecipe?.gear?.gearType;
        const explicitType = typeof rawExplicitType === "string" ? normalizeGearType(rawExplicitType) : null;
        const inferredType = explicitType === null
          ? gearTypeFromText(`${componentType} ${features.join(" ")}`)
          : "unknown";
        const isToothed = raw.teeth != null
          || geometryRecipe?.gear != null
          || /gear|tooth|teeth|cog|worm|rack/i.test(`${componentType} ${features.join(" ")}`);
        const gearType = explicitType !== null && explicitType !== "unknown"
          ? explicitType
          : (inferredType !== "unknown" ? inferredType : (isToothed || explicitType === "unknown" ? "unknown" : null));
        const requiresGearTypeConfirmation = Boolean(raw.requiresGearTypeConfirmation) || gearType === "unknown";
        if (geometryRecipe?.gear && typeof geometryRecipe.gear === "object" && gearType) {
          geometryRecipe.gear.gearType = gearType;
        }
        if (geometryRecipe && requiresGearTypeConfirmation) {
          geometryRecipe.requiresGearTypeConfirmation = true;
        }

        return {
          componentType,
          dimensions: cleanDims,
          features,
          materialEstimate: typeof raw.materialEstimate === "string" ? raw.materialEstimate : "",
          geometryRecipe,
          gearType,
          classificationSource: typeof raw.classificationSource === "string" ? raw.classificationSource.slice(0, 60) : null,
          requiresGearTypeConfirmation,
          teeth: cleanNumber(raw.teeth),
          module: cleanNumber(raw.module),
          helixAngle: cleanNumber(raw.helixAngle),
          coneAngle: cleanNumber(raw.coneAngle),
          pitch: cleanNumber(raw.pitch),
          starts: cleanNumber(raw.starts),
        };
      }

      /**
       * Clamp quantity to a safe integer in [1, 100 000].
       */
      function clampQuantity(raw) {
        const n = Number(raw);
        if (!isFinite(n) || n < 1) return 1;
        return Math.max(1, Math.min(100000, Math.round(n)));
      }

      app.post("/api/manufacturing-intelligence", (req, res) => {
        try {
          const analysis = validateAnalysisShape(req.body?.analysis);
          const quantity = clampQuantity(req.body?.quantity);
          const result = computeManufacturingIntelligence({ analysis, quantity });
          // result may be { error, message } if geometry is insufficient — return 200 so
          // the frontend can display the graceful "not enough data" state without a network error.
          res.json({ manufacturingIntelligence: result });
        } catch (error) {
          res.status(error.status || 500).json({ error: error.message || "Manufacturing estimate failed." });
        }
      });

      // ---------------------------------------------------------------------------
      // Helpers for /api/material-alternatives
      // ---------------------------------------------------------------------------

      /**
       * Validate the manufacturingIntelligence object for the comparison endpoint.
       * Only the fields actually consumed by computeMaterialAlternatives are checked.
       */
      function validateManufacturingIntelligenceForComparison(raw) {
        if (!raw || typeof raw !== "object") {
          const err = new Error("manufacturingIntelligence must be a non-null object.");
          err.status = 400;
          throw err;
        }
        if (typeof raw.volumeCm3 !== "number" || !isFinite(raw.volumeCm3) || raw.volumeCm3 <= 0) {
          const err = new Error(
            "manufacturingIntelligence.volumeCm3 must be a finite positive number."
          );
          err.status = 400;
          throw err;
        }
        return {
          volumeCm3: raw.volumeCm3,
          quantity:
            typeof raw.quantity === "number" && isFinite(raw.quantity)
              ? Math.max(1, Math.round(raw.quantity))
              : 1,
        };
      }

      app.post("/api/material-alternatives", (req, res) => {
        try {
          const analysis = validateAnalysisShape(req.body?.analysis);
          const manufacturingIntelligence = validateManufacturingIntelligenceForComparison(
            req.body?.manufacturingIntelligence
          );
          const result = computeMaterialAlternatives({ analysis, manufacturingIntelligence });
          // { error: "insufficient-data" } is a graceful case — return 200 so the
          // frontend can display the friendly state without a network error.
          res.json({ materialAlternatives: result });
        } catch (error) {
          res
            .status(error.status || 500)
            .json({ error: error.message || "Material comparison failed." });
        }
      });

      app.post("/api/reconstruct", async (req, res) => {
        try {
          if (!isReconstructionEnabled()) {
            return res.json({ status: "unavailable", message: "Reconstruction pipeline is not enabled. Set RECONSTRUCTION_ENABLED=true." });
          }
          const result = await callReconstructionService(req.body);
          if (!result) {
            return res.status(503).json({ status: "unavailable", error: "Reconstruction service is unreachable." });
          }
          res.json(result);
        } catch (error) {
          res.status(500).json({ status: "failed", error: error.message });
        }
      });

      // ---------------------------------------------------------------------------
      // CAD export — real B-Rep solids built by python-engine (CadQuery/OpenCASCADE)
      // ---------------------------------------------------------------------------

      const CAD_EXPORT_FORMATS = ["step", "iges", "stl", "obj"];

      function cadSlug(analysis) {
        const raw = analysis?.componentName || analysis?.componentType || "component";
        return String(raw)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "component";
      }

      /**
       * Validate analysis for CAD export: the shared shape validator plus the
       * dimension-free hints the geometry builders rely on.
       */
      function validateCadExportAnalysis(raw) {
        const base = validateAnalysisShape(raw);
        const pick = (value, min, max) => {
          const n = Number(value);
          if (!isFinite(n)) return null;
          return Math.max(min, Math.min(max, n));
        };
        const datasetModel = raw?.datasetModel && typeof raw.datasetModel === 'object'
          ? {
            assetId: typeof raw.datasetModel.assetId === 'string' ? raw.datasetModel.assetId.slice(0, 120) : '',
            formats: Array.isArray(raw.datasetModel.formats)
              ? raw.datasetModel.formats.filter((value) => typeof value === 'string').slice(0, 20)
              : [],
            validation: raw.datasetModel.validation && typeof raw.datasetModel.validation === 'object'
              ? raw.datasetModel.validation
              : null,
          }
          : null;

        return {
          ...base,
          componentName: typeof raw?.componentName === "string" ? raw.componentName.slice(0, 60) : "",
          teeth: pick(raw?.teeth, 4, 400),
          module: pick(raw?.module, 0.01, 100),
          helixAngle: pick(raw?.helixAngle, -60, 60),
          coneAngle: pick(raw?.coneAngle, 0, 90),
          boltCount: pick(raw?.boltCount, 3, 64),
          gearType: base.gearType,
          requiresGearTypeConfirmation: base.requiresGearTypeConfirmation,
          datasetModel,
        };
      }

      app.post("/api/cad/export", async (req, res) => {
        let cleanup = () => { };
        try {
          const analysis = validateCadExportAnalysis(req.body?.analysis);
          const format = String(req.body?.format || "step").toLowerCase();
          if (!CAD_EXPORT_FORMATS.includes(format)) {
            return res.status(400).json({ error: `Unsupported CAD export format: ${format}` });
          }
          if (analysis.gearType === "unknown" || analysis.requiresGearTypeConfirmation) {
            return res.status(422).json({
              error: "Gear type is unconfirmed. Confirm spur, helical, bevel, worm, rack, internal, compound, pinion, stepped or flanged before exporting CAD.",
            });
          }
          const requested = typeof req.body?.baseName === "string" ? req.body.baseName.trim() : "";
          const baseName = requested || cadSlug(analysis);

          // Dataset-backed reconstructions export their real acquired asset. Never
          // substitute a parametric guess when the retrieved source format exists.
          if (analysis.datasetModel) {
            const asset = resolveAssetForDatasetModel(analysis.datasetModel, format);
            if (!asset) {
              return res.status(422).json({
                error: `Retrieved dataset asset does not include a real ${format.toUpperCase()} file. Available formats: ${(analysis.datasetModel.formats || []).join(', ') || 'none'}.`,
              });
            }
            const extension = path.extname(asset.path) || `.${format}`;
            res.setHeader("Content-Type", asset.mimeType);
            res.setHeader("Content-Disposition", `attachment; filename="${baseName}${extension}"`);
            res.setHeader("Content-Length", String(asset.bytes));
            res.setHeader("X-ReForge-CAD-Source", "dataset");
            const datasetStream = createReadStream(asset.path);
            datasetStream.on("error", (streamError) => {
              if (!res.headersSent) {
                res.status(500).json({ error: streamError.message || 'Dataset asset stream failed.' });
              } else {
                res.destroy(streamError);
              }
            });
            datasetStream.pipe(res);
            return undefined;
          }

          const result = await exportCadModel({ analysis, format, baseName });
          cleanup = result.cleanup;

          res.setHeader("Content-Type", result.mimeType);
          res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
          res.setHeader("Content-Length", String(result.bytes));
          res.setHeader("X-ReForge-CAD-Solids", String(result.manifest.solids));

          const stream = createReadStream(result.path);
          stream.on("error", (streamError) => {
            cleanup();
            if (!res.headersSent) {
              res.status(500).json({ error: streamError.message || "CAD export stream failed." });
            } else {
              res.destroy(streamError);
            }
          });
          stream.on("close", cleanup);
          stream.pipe(res);
          return undefined;
        } catch (error) {
          cleanup();
          return res.status(error.status || 500).json({ error: error.message || "CAD export failed." });
        }
      });

      app.post("/api/analyze-condition", async (req, res) => {
        try {
          const images = validateImages(req.body?.images);
          const rawAnalysis = req.body?.analysis && typeof req.body.analysis === 'object'
            ? req.body.analysis
            : {};
          const recipe = sanitizeRecipe(rawAnalysis.geometryRecipe);
          const rawExplicitType = rawAnalysis.gearType ?? recipe?.gear?.gearType;
          const explicitType = typeof rawExplicitType === 'string' ? normalizeGearType(rawExplicitType) : null;
          const componentType = typeof rawAnalysis.componentType === 'string'
            ? rawAnalysis.componentType.slice(0, 60)
            : '';
          const inferredType = explicitType === null
            ? gearTypeFromText(`${componentType} ${(rawAnalysis.features || []).join(' ')}`)
            : 'unknown';
          const numeric = (value) => typeof value === 'number' && isFinite(value) ? value : null;
          const gearType = explicitType !== null && explicitType !== 'unknown'
            ? explicitType
            : (inferredType !== 'unknown' ? inferredType : (explicitType === 'unknown' ? 'unknown' : null));
          const requiresGearTypeConfirmation = Boolean(rawAnalysis.requiresGearTypeConfirmation) || gearType === 'unknown';
          if (recipe?.gear && typeof recipe.gear === 'object' && gearType) {
            recipe.gear.gearType = gearType;
          }
          if (recipe && requiresGearTypeConfirmation) {
            recipe.requiresGearTypeConfirmation = true;
          }
          const analysis = {
            componentType,
            gearType,
            requiresGearTypeConfirmation,
            teeth: numeric(rawAnalysis.teeth),
            module: numeric(rawAnalysis.module),
            helixAngle: numeric(rawAnalysis.helixAngle),
            coneAngle: numeric(rawAnalysis.coneAngle),
            geometryRecipe: recipe,
          };
          const conditionAssessment = await attachConditionAssessment({ analysis, images });
          res.json({ conditionAssessment });
        } catch (error) {
          res.status(error.status || 500).json({ error: error.message || 'Condition analysis failed.' });
        }
      });

      app.get("/api/health", (_req, res) => {
        const catalog = getCatalogSummary();
        res.json({
          ok: true,
          geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
          cadExportAvailable: isCadExportScriptPresent(),
          datasetRetrievalEnabled: catalog.enabled,
          datasetCatalog: {
            indexPresent: catalog.indexPresent,
            manifestPresent: catalog.manifestPresent,
            counts: catalog.counts,
          },
        });
      });

      app.get("/api/dataset/status", async (_req, res) => {
        try {
          res.json(await getDatasetServiceStatus());
        } catch (error) {
          res.status(500).json({ error: error.message || 'Dataset status failed.' });
        }
      });

      app.get("/api/dataset/asset/:assetId", (req, res) => {
        const format = String(req.query.format || 'stl').toLowerCase();
        const asset = resolveDatasetAsset(req.params.assetId, format);
        if (!asset) {
          return res.status(404).json({ error: 'Dataset asset not found or outside configured storage.' });
        }
        res.setHeader('Content-Type', asset.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(asset.path)}"`);
        if (asset.bytes) res.setHeader('Content-Length', String(asset.bytes));
        const stream = createReadStream(asset.path);
        stream.on('error', (error) => {
          if (!res.headersSent) res.status(500).json({ error: error.message });
          else res.destroy(error);
        });
        stream.pipe(res);
        return undefined;
      });

      const distDir = path.resolve(__dirname, "../frontend/dist");
      if (existsSync(distDir)) {
        app.use(express.static(distDir));
        app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
      } else {
        app.get("/", (_req, res) => {
          res
            .type("text")
            .send("ReForge AI API is running. Build the frontend (npm run build) or run the Vite dev server with the /api proxy to use the app.");
        });
      }

      app.use((_req, res) => res.status(404).json({ error: "Not found." }));

      app.listen(PORT, () => {
        console.log(`ReForge AI server listening on http://localhost:${PORT}`);
        console.log(process.env.GEMINI_API_KEY ? "Gemini API key: configured" : "Gemini API key: NOT set — analysis/chat will fail until GEMINI_API_KEY is provided in .env.local");
      });
