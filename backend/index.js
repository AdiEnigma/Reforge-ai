import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeComponent, chatWithEngineer, sanitizeRecipe } from "./gemini.js";
import { computeManufacturingIntelligence } from "./manufacturing.js";
import { computeMaterialAlternatives } from "./material-comparison.js";
import { simulateEngineeringChange, analyzeDimensionSensitivity } from "./engineering-analysis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const REFERENCE_KEYS = ["outerDiameter", "innerDiameter", "height", "length", "thickness", "width", "teeth", "module", "helixAngle"];

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
    } else if (value > 0 && value <= 100000) {
      clean[key] = value;
    }
  }
  return clean;
}

app.post("/api/analyze-component", async (req, res) => {
  try {
    const images = validateImages(req.body?.images);
    const reference = sanitizeReference(req.body?.reference);
    const analysis = await analyzeComponent({ images, reference });
    res.json({ analysis });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Analysis failed." });
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, geminiConfigured: Boolean(process.env.GEMINI_API_KEY) });
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
