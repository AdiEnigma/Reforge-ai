import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeComponent, chatWithEngineer, sanitizeRecipe } from "./gemini.js";
import { computeManufacturingIntelligence } from "./manufacturing.js";
import { computeMaterialAlternatives } from "./material-comparison.js";
import { simulateEngineeringChange, analyzeDimensionSensitivity } from "./engineering-analysis.js";
import {
  isVisionEnabled,
  callVisionService,
  buildVisionEvidenceSummary,
  buildVisionObservations,
} from './vision-adapter.js';
import { isReconstructionEnabled, callReconstructionService } from './reconstruction-adapter.js';
import {
  stageReconstructionPhotos,
  reconstructionImageRoot,
} from './reconstruction-photos.js';
import { deriveAssumptions, deriveUserDimensions } from './assumptions.js';
import {
  isCadEnabled,
  callCadService,
  chooseCadRoute,
  chooseMeasurementRoute,
} from './cad-adapter.js';
import {
  newJobId,
  stageCadOutputs,
  resolveCadFile,
} from './cad-store.js';
import { createJob, getJob, updateJob, serializeJob } from './job-store.js';
import { logAnalysis, analysisLogConfig } from './analysis-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const MAX_IMAGES = 8;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DATA_CHARS = 4 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function allowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

const rateBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.start < cutoff) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(req, res, next) {
  if (req.path === "/health") return next();
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { start: now, count: 1 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests. Try again shortly." });
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: `${MAX_BODY_BYTES}` }));
app.use("/api", rateLimit);

function sendError(res, error, fallbackMessage) {
  const status = Number(error?.status) || 500;
  if (status >= 500) {
    console.error(fallbackMessage, error);
    return res.status(status).json({ error: "Internal server error." });
  }
  return res.status(status).json({ error: error?.message || fallbackMessage });
}

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
    if (image.data.length > MAX_IMAGE_DATA_CHARS) {
      const error = new Error("One of the images is too large. Use images under 3 MB.");
      error.status = 413;
      throw error;
    }
    clean.push({ data: image.data, mimeType: image.mimeType });
  }
  return clean;
}

const REFERENCE_KEYS = [
  "outerDiameter",
  "innerDiameter",
  "height",
  "length",
  "thickness",
  "width",
  "teeth",
  "module",
  "helixAngle",
  // A bore and a bolt pattern are what distinguish a flange from a blank disc.
  // Stripping them here made those features unreachable from the UI.
  "boltCircleDiameter",
  "holeDiameter",
  "holeCount",
];

function sanitizeReference(raw) {
  if (!raw || typeof raw !== "object") return {};
  const clean = {};
  for (const key of REFERENCE_KEYS) {
    const value = raw[key];
    if (typeof value !== "number" || !isFinite(value)) continue;
    if (key === "teeth") {
      if (value >= 4 && value <= 400) clean[key] = Math.round(value);
    } else if (key === "helixAngle") {
      if (value >= 0 && value <= 60) clean[key] = value;
    } else if (key === "module") {
      if (value > 0 && value <= 100) clean[key] = value;
    } else if (key === "holeCount") {
      if (value >= 1 && value <= 200) clean[key] = Math.round(value);
    } else if (value > 0 && value <= 100000) {
      clean[key] = value;
    }
  }
  return clean;
}

async function analyzeFromImages(images, reference) {
  // Optional vision preprocessing — fail-open by default (null if disabled/offline/error)
  let visionEvidence = null;
  let visionObservations = null;
  let featureMeasurements = null;
  const stages = { vision: "skipped", gemini: "pending", measurement: "unavailable" };
  if (isVisionEnabled()) {
    stages.vision = "executed";
    try {
      const visionResult = await callVisionService(images, reference);
      if (visionResult) {
        visionEvidence = buildVisionEvidenceSummary(visionResult);
        visionObservations = buildVisionObservations(visionResult);
        featureMeasurements = visionEvidence?.feature_measurements || null;
        stages.measurement = featureMeasurements
          ? (featureMeasurements.status === "ok" ? "executed" : "partial")
          : "unavailable";
      } else {
        stages.vision = "failed";
      }
    } catch (visionError) {
      stages.vision = "failed";
      console.warn('[analyze-component] Unexpected vision error (continuing without vision):', visionError?.message);
    }
  }

  const rawAnalysis = await analyzeComponent({ images, reference, visionEvidence });
  stages.gemini = "executed";
  const { analysis, hasEstimates, anchorDimension, anchorSource, scale } =
    deriveAssumptions(rawAnalysis, { reference, visionEvidence });

  if (visionObservations) {
    analysis.visionObservations = visionObservations;
  }
  if (featureMeasurements) {
    analysis.featureMeasurements = featureMeasurements;
  }

  const responseBody = {
    analysis,
    assumptions: analysis.assumptions,
    dimensionSources: analysis.dimensionSources,
    dimensionConfidence: analysis.dimensionConfidence,
    dimensionsDetail: analysis.dimensionsDetail,
    hasEstimates,
    anchorDimension,
    anchorSource,
    scale,
    featureMeasurements,
    stages,
    gemini: analysis.meta || null,
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
        opencv_circle_count: img.opencv?.circle_count ?? 0,
        calibration_status: img.calibration?.status ?? 'uncalibrated',
        warnings: [
          ...(img.opencv?.warnings || []),
          ...(img.depth?.warnings || []),
        ],
      })),
      warnings: visionEvidence.warnings || [],
    };
  }
  if (visionObservations) {
    responseBody.visionObservations = visionObservations;
  }
  return responseBody;
}

app.post("/api/analyze-component", async (req, res) => {
  try {
    const images = validateImages(req.body?.images);
    const reference = sanitizeReference(req.body?.reference);
    const responseBody = await analyzeFromImages(images, reference);
    if (req.body?.consent_for_training === true) {
      logAnalysis({
        images,
        analysis: responseBody.analysis,
        reference,
        consent: true,
      }).catch(() => {});
    }
    res.json(responseBody);
  } catch (error) {
    sendError(res, error, "Analysis failed.");
  }
});

app.post("/api/analysis-feedback", async (req, res) => {
  const analysis = req.body?.analysis;
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return res.status(400).json({ error: "An analysis object is required." });
  }
  const result = await logAnalysis({
    analysis,
    reference: sanitizeReference(req.body?.reference),
    corrections: req.body?.corrections,
    consent: req.body?.consent_for_training === true,
  });
  return res.json({ ok: true, ...result });
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
    sendError(res, error, "Chat failed.");
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
    sendError(res, error, "Simulation failed.");
  }
});

app.post("/api/engineering-sensitivity", (req, res) => {
  try {
    const analysis = validateAnalysisShape(req.body?.analysis);
    const sensitivity = analyzeDimensionSensitivity({ analysis });
    res.json({ sensitivity });
  } catch (error) {
    sendError(res, error, "Sensitivity analysis failed.");
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

  return {
    componentType: typeof raw.componentType === "string" ? raw.componentType : "other",
    dimensions: cleanDims,
    features: Array.isArray(raw.features) ? raw.features.filter((f) => typeof f === "string") : [],
    materialEstimate: typeof raw.materialEstimate === "string" ? raw.materialEstimate : "",
    geometryRecipe: sanitizeRecipe(raw.geometryRecipe),
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
    sendError(res, error, "Manufacturing estimate failed.");
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
    sendError(res, error, "Material comparison failed.");
  }
});

function sanitizeReconstructBody(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const error = new Error("Request body must be an object.");
    error.status = 400;
    throw error;
  }

  const clean = {};
  if (typeof raw.job_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.job_id)) {
    clean.job_id = raw.job_id;
  }
  if (typeof raw.component_type === "string") {
    clean.component_type = raw.component_type.slice(0, 60);
  }
  for (const key of ["user_dimensions", "gemini_proposal", "opencv_observations"]) {
    const value = raw[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      clean[key] = value;
    }
  }
  if (Array.isArray(raw.constraints)) {
    clean.constraints = raw.constraints.slice(0, 50);
  }
  if (raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)) {
    const { output_dir: _ignored, ...options } = raw.options;
    clean.options = options;
  }

  const imageRoot = reconstructionImageRoot();
  if (Array.isArray(raw.image_paths)) {
    const resolvedRoot = path.resolve(imageRoot);
    const safePaths = [];
    for (const value of raw.image_paths.slice(0, 16)) {
      if (typeof value !== "string" || value.length > 4096) continue;
      const resolved = path.resolve(value);
      const relative = path.relative(resolvedRoot, resolved);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        safePaths.push(resolved);
      }
    }
    if (safePaths.length) clean.image_paths = safePaths;
  }

  return clean;
}

app.post("/api/reconstruct", async (req, res) => {
  try {
    if (!isReconstructionEnabled()) {
      return res.json({ status: "unavailable", message: "Reconstruction pipeline is not enabled. Set RECONSTRUCTION_ENABLED=true." });
    }
    const stagedPhotos = await stageReconstructionPhotos(
      req.body?.photos,
      req.body?.job_id
    );
    const mergedBody = { ...req.body };
    if (stagedPhotos.length) {
      const existing = Array.isArray(req.body?.image_paths) ? req.body.image_paths : [];
      mergedBody.image_paths = [...existing, ...stagedPhotos];
    }
    const payload = sanitizeReconstructBody(mergedBody);
    const result = await callReconstructionService(payload);
    if (!result) {
      return res.status(503).json({ status: "unavailable", error: "Reconstruction service is unreachable." });
    }
    res.json(result);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("Reconstruction request failed.", error);
    res.status(status).json({
      status: "failed",
      error: status >= 500 ? "Reconstruction failed." : error?.message || "Reconstruction failed.",
    });
  }
});

const CAD_DIMENSION_KEYS = [
  "outerDiameter",
  "innerDiameter",
  "height",
  "length",
  "thickness",
  "width",
  "teeth",
  "module",
  "helixAngle",
];

function analysisFromDimensions(recipe, dimensions) {
  const analysis = {
    geometryRecipe: recipe,
    dimensions: {},
    dimensionSources: {},
    dimensionConfidence: {},
    dimensionsDetail: [],
  };
  if (!Array.isArray(dimensions)) return analysis;
  for (const dimension of dimensions.slice(0, 40)) {
    if (!dimension || typeof dimension !== "object") continue;
    const key = dimension.key;
    if (!CAD_DIMENSION_KEYS.includes(key)) continue;
    const value = Number(dimension.value);
    if (!isFinite(value)) continue;
    const rawSource = String(dimension.source ?? dimension.provenance ?? "").toLowerCase();
    const source =
      rawSource === "user" || rawSource === "user_specified"
        ? "user"
        : rawSource === "measured"
          ? "measured"
          : "estimated";
    const unit =
      dimension.unit ||
      (key === "teeth" ? "count" : key === "helixAngle" ? "deg" : "mm");
    const entry = {
      key,
      value,
      unit,
      source,
      confidence:
        typeof dimension.confidence === "number" && isFinite(dimension.confidence)
          ? Math.max(0, Math.min(1, dimension.confidence))
          : source === "user"
            ? 1
            : 0.5,
      anchor: false,
      note: typeof dimension.note === "string" ? dimension.note.slice(0, 200) : null,
    };
    analysis.dimensionsDetail.push(entry);
    analysis.dimensionSources[key] = source;
    analysis.dimensionConfidence[key] = entry.confidence;
    if (["teeth", "module", "helixAngle"].includes(key)) {
      analysis[key] = key === "teeth" ? Math.round(value) : value;
    } else {
      analysis.dimensions[key] = value;
    }
    if (!analysis.anchorDimension && (source === "user" || source === "measured")) {
      analysis.anchorDimension = key;
      analysis.anchorSource = source;
      entry.anchor = true;
    }
  }
  return analysis;
}

const MEASUREMENT_KEY_MAP = {
  outerDiameter: "outer_diameter",
  innerDiameter: "bore_diameter",
  boreDiameter: "bore_diameter",
  height: "height",
  thickness: "thickness",
  width: "width",
  length: "length",
  holeCount: "hole_count",
  holeDiameter: "hole_diameter",
  boltCircleDiameter: "bolt_circle_diameter",
  boltCircleRadius: "bolt_circle_radius",
};

// True when the caller supplied dimensions that describe an interior feature.
// The measurement engine prefers them over photo ratios, so they can carry a
// build that the photograph alone cannot describe.
function hasUserFeatureDimensions(dims) {
  if (!dims || typeof dims !== "object") return false;
  const hasBore = Number.isFinite(dims.bore_diameter) && dims.bore_diameter > 0;
  const hasPattern =
    Number.isFinite(dims.hole_count) &&
    dims.hole_count > 0 &&
    Number.isFinite(dims.bolt_circle_diameter) &&
    dims.bolt_circle_diameter > 0 &&
    Number.isFinite(dims.hole_diameter) &&
    dims.hole_diameter > 0;
  return hasBore || hasPattern;
}

function normalizeMeasurementUserDimensions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = MEASUREMENT_KEY_MAP[key] || key;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    out[target] = value;
  }
  return Object.keys(out).length ? out : null;
}

function mapMeasurementNeedsInput(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return null;
      return item.question || item.reason || item.parameter || null;
    })
    .filter((item) => typeof item === "string" && item.length > 0);
}

function measurementConfidenceGate(featureMeasurements) {
  if (!featureMeasurements || typeof featureMeasurements !== "object") {
    return { pass: false, reason: "no_measurements" };
  }
  const gate = Number(process.env.MEASUREMENT_CONFIDENCE_GATE);
  const threshold = Number.isFinite(gate) ? gate : 0.55;
  const agreement = Number(featureMeasurements.agreement_score);
  const viewConfidence = Number(featureMeasurements.view?.confidence);
  const status = featureMeasurements.status;
  if (status === "failed" || status === "unknown") {
    return { pass: false, reason: "measurement_status_" + status, threshold };
  }
  if (!Number.isFinite(agreement) || agreement < threshold) {
    return {
      pass: false,
      reason: "agreement_below_gate",
      agreement: Number.isFinite(agreement) ? agreement : null,
      threshold,
    };
  }
  if (Number.isFinite(viewConfidence) && viewConfidence < 0.5) {
    return { pass: false, reason: "view_confidence_below_gate", viewConfidence, threshold };
  }
  return { pass: true, agreement, viewConfidence, threshold };
}

function sanitizeCadBuildBody(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const error = new Error("Request body must be an object.");
    error.status = 400;
    throw error;
  }
  let analysis = raw.analysis;
  let recipeSource = raw.recipe;
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    if (recipeSource == null && raw.feature_measurements == null) {
      const error = new Error("analysis, recipe or feature_measurements must be provided.");
      error.status = 400;
      throw error;
    }
    analysis = recipeSource != null
      ? analysisFromDimensions(recipeSource, raw.dimensions)
      : {};
  }
  recipeSource = recipeSource ?? analysis.geometryRecipe;

  let featureMeasurements = raw.feature_measurements ?? analysis.featureMeasurements ?? null;
  if (featureMeasurements != null) {
    if (typeof featureMeasurements !== "object" || Array.isArray(featureMeasurements)) {
      const error = new Error("feature_measurements must be an object.");
      error.status = 400;
      throw error;
    }
    if (JSON.stringify(featureMeasurements).length > 512 * 1024) {
      const error = new Error("feature_measurements is too large.");
      error.status = 413;
      throw error;
    }
  }
  if (
    (!recipeSource || typeof recipeSource !== "object" || Array.isArray(recipeSource)) &&
    !featureMeasurements
  ) {
    const error = new Error(
      "A geometry recipe or feature_measurements document is required before CAD can be built."
    );
    error.status = 400;
    throw error;
  }

  let solverOutput = null;
  if (raw.solver_output != null) {
    if (typeof raw.solver_output !== "object" || Array.isArray(raw.solver_output)) {
      const error = new Error("solver_output must be an object.");
      error.status = 400;
      throw error;
    }
    if (JSON.stringify(raw.solver_output).length > 1024 * 1024) {
      const error = new Error("solver_output is too large.");
      error.status = 413;
      throw error;
    }
    solverOutput = raw.solver_output;
  }

  const visionObservations =
    raw.vision_observations ??
    (analysis.visionObservations && typeof analysis.visionObservations === "object"
      ? analysis.visionObservations
      : null);
  if (visionObservations != null) {
    if (typeof visionObservations !== "object" || Array.isArray(visionObservations)) {
      const error = new Error("vision_observations must be an object.");
      error.status = 400;
      throw error;
    }
    if (JSON.stringify(visionObservations).length > 2 * 1024 * 1024) {
      const error = new Error("vision_observations is too large.");
      error.status = 413;
      throw error;
    }
  }

  return {
    analysis,
    recipeSource,
    reference: sanitizeReference(raw.reference),
    extraUserDimensions: sanitizeReference(raw.user_dimensions),
    solverOutput,
    visionObservations,
    featureMeasurements,
    exportOverride: raw.export_override === true,
  };
}

function cadProvenance(analysis) {
  return {
    hasEstimates: Boolean(analysis.hasEstimates),
    overallConfidence:
      typeof analysis.overallConfidence === "number" ? analysis.overallConfidence : null,
    anchorDimension: analysis.anchorDimension || null,
    anchorSource: analysis.anchorSource || null,
    dimensionSources: analysis.dimensionSources || {},
    dimensionConfidence: analysis.dimensionConfidence || {},
    dimensionsDetail: analysis.dimensionsDetail || [],
    assumptions: analysis.assumptions || [],
    scale: analysis.scale || null,
  };
}

async function buildCadFromBody(rawBody) {
  const body = sanitizeCadBuildBody(rawBody);
  const {
    analysis,
    reference,
    extraUserDimensions,
    solverOutput,
    visionObservations,
    featureMeasurements,
    exportOverride,
  } = body;
  const { analysis: enriched } = deriveAssumptions(analysis, { reference });
  const recipe = body.recipeSource
    ? sanitizeRecipe(enriched.geometryRecipe ?? body.recipeSource)
    : null;
  const gate = measurementConfidenceGate(featureMeasurements);
  // Weak photo agreement must not throw away measurements the user typed in.
  // A photo can hide an interior feature entirely (a white-on-white bore, bolt
  // holes lost in shadow); the recipe fallback cannot express those features at
  // all, so honour the user's dimensions and let the measurement engine build
  // from them.
  const userFeatureDimensions = normalizeMeasurementUserDimensions(extraUserDimensions);
  const userDimensionsOverrideGate =
    Boolean(featureMeasurements) &&
    !gate.pass &&
    (gate.reason === "agreement_below_gate" ||
      gate.reason === "view_confidence_below_gate") &&
    hasUserFeatureDimensions(userFeatureDimensions);
  const effectiveGate = userDimensionsOverrideGate
    ? { ...gate, pass: true, rawPass: false, overriddenBy: "user_feature_dimensions" }
    : gate;
  const useMeasurements = Boolean(featureMeasurements) && effectiveGate.pass;
  const photoMeasurementRejected =
    Boolean(featureMeasurements) && !effectiveGate.pass && !userDimensionsOverrideGate;
  let fellBackFromMeasurement = false;
  if ((!recipe || !recipe.style) && !useMeasurements) {
    return ({
      jobId: null,
      state: "failed",
      status: "failed",
      progress: 0,
      warnings: [],
      needsInput: null,
      result: null,
      stage: featureMeasurements ? "measurement_confidence_gate" : "geometry_recipe",
      error: featureMeasurements
        ? `Vision measurements were not confident enough to drive CAD (${gate.reason}).`
        : "The geometry recipe is not supported. Adjust the dimensions and try again.",
      measurementGate: effectiveGate,
      photoMeasurementRejected: photoMeasurementRejected,
    });
  }
  const provenance = cadProvenance(enriched);
  const jobId = newJobId();
  // Assumed dimensions must never be exported by default. Opt in explicitly
  // with ALLOW_ASSUMED_EXPORTS=true (and/or an export_override request).
  const allowAssumedExports = process.env.ALLOW_ASSUMED_EXPORTS === "true";
  const legacyExportBlocked = !allowAssumedExports && !enriched.anchorDimension;
  const legacyExportBlockedReason = legacyExportBlocked
    ? "Add at least one user-provided or measured dimension to enable STEP/STL export."
    : null;
  let exportBlocked = legacyExportBlocked;
  let exportBlockedReason = legacyExportBlockedReason;

  if (!isCadEnabled()) {
    return ({
      jobId: null,
      state: "unavailable",
      status: "unavailable",
      progress: 0,
      warnings: [],
      needsInput: null,
      result: null,
      error: "CAD generation is not enabled. Showing the approximate preview instead.",
      exportBlocked: true,
      exportBlockedReason,
      photoMeasurementRejected,
      provenance,
    });
  }

  const userDimensions = {
    ...deriveUserDimensions(enriched),
    ...extraUserDimensions,
  };
  const measurementUserDimensions = normalizeMeasurementUserDimensions({
    ...userDimensions,
    ...extraUserDimensions,
  });

  let cadRoute = useMeasurements
    ? chooseMeasurementRoute()
    : chooseCadRoute(recipe, solverOutput);
  let cadPayload;
  if (cadRoute.mode === "measurement") {
    cadPayload = {
      job_id: jobId,
      measurements: featureMeasurements,
      user_dimensions: measurementUserDimensions,
      hints: { part_type: enriched.componentType || null },
      generate_previews: false,
      allow_assumed_exports: allowAssumedExports,
      export_override: exportOverride,
    };
  } else {
    cadPayload = {
      job_id: jobId,
      recipe,
      user_dimensions: Object.keys(userDimensions).length ? userDimensions : null,
      solver_output: solverOutput,
      opencv_observations: visionObservations,
    };
    if (cadRoute.mode === "advanced") {
      cadPayload.strict = false;
    }
  }
  let result = await callCadService(cadPayload, cadRoute);
  const routeAttempts = [{
    mode: cadRoute.mode,
    ok: Boolean(result.ok),
    status: result.status,
    stage: result.body?.stage || null,
  }];
  let measurementFailure = null;

  if (!result.ok && cadRoute.mode === "measurement") {
    measurementFailure = {
      status: result.status,
      stage: result.body?.stage || "measurement_cad",
      error: result.error || result.body?.error || null,
      details: result.body?.details ?? null,
      featureId: result.body?.feature_id ?? null,
      validationReport: result.body?.validation_report ?? null,
      needsInput: mapMeasurementNeedsInput(result.body?.needs_input),
      sanityErrors: result.body?.sanity_errors ?? null,
    };
    if (recipe && recipe.style) {
      fellBackFromMeasurement = true;
      cadRoute = chooseCadRoute(recipe, solverOutput);
      cadPayload = {
        job_id: jobId,
        recipe,
        user_dimensions: Object.keys(userDimensions).length ? userDimensions : null,
        solver_output: solverOutput,
        opencv_observations: visionObservations,
      };
      if (cadRoute.mode === "advanced") cadPayload.strict = false;
      result = await callCadService(cadPayload, cadRoute);
      routeAttempts.push({
        mode: cadRoute.mode,
        ok: Boolean(result.ok),
        status: result.status,
        stage: result.body?.stage || null,
        fallbackFrom: "measurement",
      });
    }
  }

  if (!result.ok) {
    const unavailable = [502, 503, 504].includes(result.status);
    const bodyNeedsInput = result.body?.status === "needs_input";
    const measurementNeedsInput = mapMeasurementNeedsInput(result.body?.needs_input);
    const needsInput = bodyNeedsInput || measurementNeedsInput.length > 0;
    const stage = result.body?.stage || measurementFailure?.stage || "cad_generation";
    return ({
      jobId: needsInput ? jobId : null,
      state: unavailable ? "unavailable" : needsInput ? "needs_input" : "failed",
      status: unavailable ? "unavailable" : needsInput ? "needs_input" : "failed",
      progress: 0,
      warnings: [],
      needsInput: needsInput
        ? (result.body?.missing ?? measurementNeedsInput)
        : null,
      result: null,
      stage,
      error: unavailable
        ? "CAD service is unavailable. Showing the approximate preview instead."
        : needsInput
          ? "Additional dimensions are required to build this model."
          : "CAD generation failed. Check the required dimensions and try again.",
      details: result.body?.details ?? null,
      featureId: result.body?.feature_id ?? null,
      validationReport: result.body?.validation_report ?? null,
      serviceError: result.error || result.body?.error || null,
      measurementFailure,
      routeAttempts,
      measurementGate: effectiveGate,
      photoMeasurementRejected: photoMeasurementRejected || fellBackFromMeasurement,
      exportBlocked: true,
      exportBlockedReason,
      provenance,
    });
  }

  const responseBody = result.body || {};
  const isMeasurement = cadRoute.mode === "measurement";
  const responseExportAllowed = isMeasurement
    ? responseBody.export_allowed !== false
    : !exportBlocked;
  exportBlocked = !responseExportAllowed;
  if (isMeasurement) {
    const reasons = Array.isArray(responseBody.export_block_reasons)
      ? responseBody.export_block_reasons
      : [];
    exportBlockedReason = exportBlocked
      ? `Manufacturing export blocked: ${reasons.join(", ") || "unknown critical dimensions"}.`
      : null;
  }
  // A recipe built only because photo measurements were rejected (or the
  // measurement service failed) is an approximate preview, not a validated
  // model: block STEP/STL export unless the caller explicitly opted in.
  const recipeFallbackFromPhoto = photoMeasurementRejected || fellBackFromMeasurement;
  if (recipeFallbackFromPhoto && !exportOverride && !isMeasurement) {
    exportBlocked = true;
    exportBlockedReason =
      "Photo measurements were not confident enough to validate this model; enter dimensions to enable export.";
  }
  const files = await stageCadOutputs({
    jobId,
    stepPath: responseBody.step_path,
    stlPath: responseBody.stl_path,
    meshPath: isMeasurement
      ? (responseBody.mesh_path || responseBody.preview_mesh_path)
      : responseBody.mesh_path,
    includeStep: !exportBlocked,
    includeStl: !exportBlocked,
    includeMesh: true,
  });

  const metrics = responseBody.validation_report?.metrics || {};
  const bbox = metrics.actual_bbox || null;
  const issues = Array.isArray(responseBody.validation_report?.issues)
    ? responseBody.validation_report.issues.slice(0, 20)
    : [];
  const measurement = isMeasurement
    ? {
        status: responseBody.measurement_status || null,
        previewOnly: Boolean(responseBody.preview_only),
        manufacturingReady: Boolean(responseBody.manufacturing_ready),
        exportAllowed: Boolean(responseBody.export_allowed),
        exportBlockReasons: responseBody.export_block_reasons || [],
        scale: responseBody.scale || null,
        topology: responseBody.topology || null,
        provenance: responseBody.provenance || {},
        needsInput: responseBody.needs_input || [],
        assumedDimensions: responseBody.assumed_dimensions || [],
        criticalUnknowns: responseBody.critical_unknowns || [],
        validationStatuses: responseBody.validation_statuses || {},
        featureFit: responseBody.feature_fit || null,
        confidence: typeof responseBody.confidence === "number" ? responseBody.confidence : null,
        featureRecipe: responseBody.feature_recipe || null,
      }
    : null;
  const dimensionalScore = measurement?.featureFit?.score ?? null;
  const validationReport = {
    ...(responseBody.validation_report || {}),
    validation_statuses: responseBody.validation_statuses || undefined,
    feature_fit: responseBody.feature_fit || undefined,
  };

  return ({
    jobId,
    state: "done",
    status: "done",
    progress: 1,
    warnings: [],
    needsInput: null,
    result: {
      meshUrl: files.mesh || null,
      stepUrl: files.step || null,
      stlUrl: files.stl || null,
      exportBlocked,
      exportBlockedReason,
      validationReport,
      featureTree: responseBody.feature_tree || responseBody.feature_history || [],
      cadMode: cadRoute.mode,
      dimensions: provenance.dimensionsDetail,
      hasEstimates: provenance.hasEstimates,
      confidence: isMeasurement
        ? (measurement?.confidence ?? null)
        : (typeof enriched.overallConfidence === "number"
            ? enriched.overallConfidence
            : Number(enriched.confidence) || 0),
      classificationConfidence:
        typeof enriched.overallConfidence === "number"
          ? enriched.overallConfidence
          : Number(enriched.confidence) || 0,
      measurement,
      gemini: enriched.meta || analysis.meta || null,
      model: {
        bbox,
        volumeMm3:
          typeof metrics.actual_volume_mm3 === "number"
            ? metrics.actual_volume_mm3
            : null,
        solidCount: metrics.solid_count ?? null,
        style: metrics.style || responseBody.cad_spec?.style || null,
      },
      validation: {
        valid: Boolean(responseBody.validation_report?.valid),
        fitScore:
          typeof responseBody.validation_report?.fit_score === "number"
            ? responseBody.validation_report.fit_score
            : null,
        dimensionalScore,
        dimensionalStatus: measurement?.featureFit?.status || null,
        issues,
      },
      stages: {
        measurement: {
          status: isMeasurement ? "executed" : (measurementFailure ? "failed" : "skipped"),
          reason: gate.pass ? null : gate.reason,
        },
        cad: { status: "executed", mode: cadRoute.mode, path: cadRoute.path },
      },
    },
    error: null,
    exportBlocked,
    exportBlockedReason,
    previewOnly: isMeasurement ? Boolean(responseBody.preview_only) : exportBlocked,
    measurementFailure,
    routeAttempts,
    measurementGate: effectiveGate,
    photoMeasurementRejected: recipeFallbackFromPhoto,
    provenance,
  });
}

app.post("/api/cad/build", async (req, res) => {
  try {
    const result = await buildCadFromBody(req.body);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "Invalid CAD build request.");
  }
});

async function processAnalysisJob(jobId, input) {
  try {
    updateJob(jobId, {
      state: "analyzing",
      status: "analyzing",
      progress: 0.1,
      stage: "analysis",
    });

    const analysisResponse = await analyzeFromImages(input.images, input.reference);
    updateJob(jobId, {
      state: "generating_cad",
      status: "generating_cad",
      progress: 0.55,
      stage: "cad",
      analysis: analysisResponse.analysis,
      warnings: analysisResponse.visionDiagnostics?.warnings || [],
    });

    const build = await buildCadFromBody({
      analysis: analysisResponse.analysis,
      reference: input.reference,
      user_dimensions: input.reference,
      feature_measurements: analysisResponse.featureMeasurements,
    });
    const state = build?.state || "failed";
    updateJob(jobId, {
      state,
      status: build?.status || state,
      progress:
        typeof build?.progress === "number"
          ? build.progress
          : state === "done"
            ? 1
            : 0.7,
      stage: build?.stage || null,
      needsInput: build?.needsInput ?? null,
      result: build?.result ?? null,
      error: build?.error ?? null,
      details: build?.details ?? null,
      featureId: build?.featureId ?? null,
      validationReport: build?.validationReport ?? null,
      measurementFailure: build?.measurementFailure ?? null,
      measurementGate: build?.measurementGate ?? null,
      routeAttempts: build?.routeAttempts ?? null,
      exportBlocked: Boolean(build?.exportBlocked),
      exportBlockedReason: build?.exportBlockedReason || null,
      provenance: build?.provenance || null,
      gemini: analysisResponse.gemini || null,
      stages: build?.result?.stages
        ? { ...analysisResponse.stages, ...build.result.stages }
        : analysisResponse.stages,
      warnings: [
        ...(analysisResponse.visionDiagnostics?.warnings || []),
        ...(build?.warnings || []),
      ],
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[jobs] processing failed", error);
    updateJob(jobId, {
      state: "failed",
      status: "failed",
      progress: 0,
      stage: "orchestration",
      error:
        status >= 500
          ? "Job processing failed."
          : error?.message || "Job failed.",
    });
  }
}

app.post("/api/jobs", (req, res) => {
  try {
    const images = validateImages(req.body?.images);
    const reference = sanitizeReference(req.body?.reference);
    const job = createJob({ images, reference });
    setImmediate(() => processAnalysisJob(job.id, job.input));
    return res.status(202).json(serializeJob(job));
  } catch (error) {
    return sendError(res, error, "Could not create job.");
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired." });
  }
  return res.json(serializeJob(job));
});

app.post("/api/jobs/:id/resume", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired." });
  }
  if (job.state !== "needs_input") {
    return res.status(409).json({ error: "Only jobs awaiting input can be resumed." });
  }
  const supplied = sanitizeReference(
    req.body?.user_dimensions ?? req.body?.reference
  );
  if (!Object.keys(supplied).length) {
    return res.status(400).json({ error: "Provide at least one dimension to resume." });
  }
  const reference = { ...(job.input?.reference || {}), ...supplied };
  job.input = { ...(job.input || {}), reference };
  updateJob(job.id, {
    state: "queued",
    status: "queued",
    progress: 0,
    needsInput: null,
    error: null,
  });
  setImmediate(() => processAnalysisJob(job.id, job.input));
  return res.status(202).json(serializeJob(job));
});

const CAD_FILE_PATTERN = /^([A-Za-z0-9_-]{8,64})\.(step|stl|mesh\.json)$/;

const CAD_CONTENT_TYPES = {
  step: "application/step",
  stl: "model/stl",
  mesh: "application/json",
};

app.get("/api/cad/files/:filename", (req, res) => {
  const filename = String(req.params.filename || "");
  if (!CAD_FILE_PATTERN.test(filename)) {
    return res.status(404).json({ error: "File not found." });
  }
  const entry = resolveCadFile(filename);
  if (!entry) {
    return res.status(404).json({ error: "File not found." });
  }
  res.type(CAD_CONTENT_TYPES[entry.kind] || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.sendFile(entry.path, (error) => {
    if (error && !res.headersSent) {
      res.status(404).json({ error: "File not found." });
    }
  });
});

async function probeService(name, baseUrl, enabled) {
  if (!enabled) {
    return { name, enabled: false, reachable: false, status: "disabled" };
  }
  try {
    const url = new URL("/health", baseUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON health payloads still count as reachable.
    }
    return {
      name,
      enabled: true,
      reachable: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      name,
      enabled: true,
      reachable: false,
      status: "unreachable",
      error: error?.name === "TimeoutError" ? "timeout" : "unreachable",
    };
  }
}

app.get("/api/health", async (_req, res) => {
  const services = await Promise.all([
    probeService(
      "vision",
      process.env.VISION_SERVICE_URL || "http://127.0.0.1:8765",
      isVisionEnabled()
    ),
    probeService(
      "cad",
      process.env.CAD_SERVICE_URL || "http://127.0.0.1:8766",
      isCadEnabled()
    ),
    probeService(
      "reconstruction",
      process.env.RECONSTRUCTION_SERVICE_URL || "http://127.0.0.1:8766",
      isReconstructionEnabled()
    ),
  ]);
  res.json({
    ok: true,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    cadEnabled: isCadEnabled(),
    visionEnabled: isVisionEnabled(),
    reconstructionEnabled: isReconstructionEnabled(),
    analysisLog: analysisLogConfig(),
    services,
  });
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
