import express from "express";
import fs from "node:fs";
import { validateSession } from "./auth-service.js";
import { COOKIE_NAME } from "./auth-routes.js";
import {
  createWorkbench,
  listWorkbenches,
  getWorkbench,
  updateWorkbenchMetadata,
  saveSnapshot,
  saveAsset,
  getAsset,
  listAssets,
  deleteWorkbench,
} from "./workbench-service.js";
import { exportCadModel, CAD_EXPORT_MIME_TYPES } from "../cad-export-adapter.js";

const CAD_EXPORT_FORMATS = Object.keys(CAD_EXPORT_MIME_TYPES);

function cadSlug(analysis) {
  const raw =
    analysis?.componentName ||
    analysis?.componentType ||
    analysis?.label ||
    analysis?.classification?.type ||
    "component";
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "component";
}

/**
 * Express router for workbenches, snapshots, and asset persistence.
 * @param {import('better-sqlite3').Database} db
 */
export function createWorkbenchRouter(db) {
  const router = express.Router();

  // Authentication middleware
  router.use((req, res, next) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: "Authentication required to access workbenches." });
    }
    const user = validateSession(db, token);
    if (!user) {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      return res.status(401).json({ error: "Session expired or invalid." });
    }
    req.user = user;
    next();
  });

  /**
   * POST /api/workbenches
   * Creates a new workbench.
   */
  router.post("/", (req, res) => {
    try {
      const { name, componentName } = req.body || {};
      const orgId = req.user.organization?.id || null;
      const wb = createWorkbench(db, {
        userId: req.user.id,
        organizationId: orgId,
        name,
        componentName,
      });
      return res.status(201).json({ ok: true, workbench: wb });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to create workbench." });
    }
  });

  /**
   * GET /api/workbenches
   * Lists the authenticated user's workbenches.
   */
  router.get("/", (req, res) => {
    try {
      const includeArchived = req.query.archived === "true";
      const workbenches = listWorkbenches(db, req.user.id, { includeArchived });
      return res.json({ ok: true, workbenches });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to list workbenches." });
    }
  });

  /**
   * GET /api/workbenches/:id
   * Retrieves a workbench, its latest snapshot, and its asset list.
   */
  router.get("/:id", (req, res) => {
    try {
      const data = getWorkbench(db, req.user.id, req.params.id);
      return res.json({ ok: true, ...data });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to retrieve workbench." });
    }
  });

  /**
   * PATCH /api/workbenches/:id
   * Updates metadata (name, status, isArchived).
   */
  router.patch("/:id", (req, res) => {
    try {
      const updated = updateWorkbenchMetadata(db, req.user.id, req.params.id, req.body || {});
      return res.json({ ok: true, workbench: updated });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to update workbench." });
    }
  });

  /**
   * PUT & POST /api/workbenches/:id/snapshot
   * Saves a versioned snapshot of the engineering state.
   */
  const handleSaveSnapshot = (req, res) => {
    try {
      const state = req.body?.state;
      if (!state) {
        return res.status(400).json({ error: "Missing state in request body." });
      }
      const snapshot = saveSnapshot(db, req.user.id, req.params.id, state);
      return res.json({ ok: true, snapshot });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to save snapshot." });
    }
  };
  router.put("/:id/snapshot", handleSaveSnapshot);
  router.post("/:id/snapshot", handleSaveSnapshot);

  /**
   * POST /api/workbenches/:id/images
   * Uploads and stores an image file for this workbench.
   * Body: { name, mimeType, data (base64) }
   */
  router.post("/:id/images", (req, res) => {
    try {
      const { name, mimeType, data } = req.body || {};
      if (!data || typeof data !== "string") {
        return res.status(400).json({ error: "Image data (base64) is required." });
      }
      const cleanData = data.includes(",") ? data.split(",")[1] : data;
      const buffer = Buffer.from(cleanData, "base64");
      const safeMime = (typeof mimeType === "string" && mimeType.startsWith("image/")) ? mimeType : "image/png";
      const safeName = (typeof name === "string" && name.trim()) ? name.trim() : `image_${Date.now()}.png`;

      const asset = saveAsset(db, req.user.id, req.params.id, {
        category: "uploaded_image",
        originalFilename: safeName,
        mimeType: safeMime,
        buffer,
      });

      return res.status(201).json({ ok: true, asset });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to upload image." });
    }
  });

  /**
   * GET /api/workbenches/:id/assets
   * Lists assets for a workbench.
   */
  router.get("/:id/assets", (req, res) => {
    try {
      const assets = listAssets(db, req.user.id, req.params.id);
      return res.json({ ok: true, assets });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to list assets." });
    }
  });

  /**
   * GET /api/workbenches/:id/assets/:assetId
   * Streams or downloads an asset file.
   */
  router.get("/:id/assets/:assetId", (req, res) => {
    try {
      const { asset, filePath } = getAsset(db, req.user.id, req.params.id, req.params.assetId);

      res.setHeader("Content-Type", asset.mime_type || "application/octet-stream");
      res.setHeader("Content-Length", String(asset.file_size));
      res.setHeader("Content-Disposition", `inline; filename="${asset.original_filename}"`);

      const stream = fs.createReadStream(filePath);
      stream.on("error", (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read asset stream." });
        }
      });
      stream.pipe(res);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Asset not found." });
    }
  });

  /**
   * POST /api/workbenches/:id/export-cad
   * Generates CAD via OpenCASCADE/CadQuery AND automatically persists the export asset in this workbench.
   */
  router.post("/:id/export-cad", async (req, res) => {
    let cleanup = () => {};
    try {
      const analysis = req.body?.analysis;
      const format = String(req.body?.format || "step").toLowerCase();
      if (!CAD_EXPORT_FORMATS.includes(format)) {
        return res.status(400).json({ error: `Unsupported CAD export format: ${format}` });
      }
      const requested = typeof req.body?.baseName === "string" ? req.body.baseName.trim() : "";
      const baseName = requested || cadSlug(analysis);

      // Call cad-export-adapter
      const result = await exportCadModel({ analysis, format, baseName });
      cleanup = result.cleanup;

      // Read resulting file into buffer to persist as asset
      const fileBuffer = fs.readFileSync(result.path);
      cleanup(); // clean up temporary export output

      const assetCategory = `cad_${format}`;
      const asset = saveAsset(db, req.user.id, req.params.id, {
        category: assetCategory,
        originalFilename: result.filename,
        mimeType: result.mimeType,
        buffer: fileBuffer,
      });

      return res.json({
        ok: true,
        asset,
        filename: result.filename,
        mimeType: result.mimeType,
        format,
        bytes: asset.fileSize,
        solids: result.manifest.solids,
      });
    } catch (err) {
      cleanup();
      return res.status(err.status || 500).json({ error: err.message || "CAD export failed." });
    }
  });

  /**
   * DELETE /api/workbenches/:id
   * Deletes a workbench and its assets.
   */
  router.delete("/:id", (req, res) => {
    try {
      const result = deleteWorkbench(db, req.user.id, req.params.id);
      return res.json(result);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Failed to delete workbench." });
    }
  });

  return router;
}
