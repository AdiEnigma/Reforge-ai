import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getStorageRoot } from "./db.js";

/**
 * Ensures a directory exists synchronously.
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Returns the isolated directory path for a user's workbench.
 * Validates path traversal.
 */
export function getWorkbenchDir(userId, workbenchId, storageRoot = getStorageRoot()) {
  const root = path.resolve(storageRoot);
  const safeUser = String(userId).replace(/[^a-zA-Z0-9_-]/g, "");
  const safeWb = String(workbenchId).replace(/[^a-zA-Z0-9_-]/g, "");
  const targetDir = path.resolve(root, safeUser, safeWb);

  if (!targetDir.startsWith(root) || targetDir === root) {
    throw new Error("Invalid workbench path (potential path traversal detected).");
  }
  return targetDir;
}

/**
 * Validates file path within a workbench directory.
 */
export function getSafeAssetPath(workbenchDir, filename) {
  const safeFilename = path.basename(filename);
  const target = path.resolve(workbenchDir, safeFilename);
  if (!target.startsWith(workbenchDir)) {
    throw new Error("Invalid asset path traversal.");
  }
  return target;
}

/**
 * Creates a new workbench in SQLite.
 */
export function createWorkbench(db, { userId, organizationId = null, name = null, componentName = null }) {
  if (!userId) {
    const err = new Error("User ID is required to create a workbench.");
    err.status = 400;
    throw err;
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const finalName = (name && name.trim()) || (componentName && `${componentName} Reconstruction`) || `Workbench ${new Date(now).toISOString().slice(0, 10)}`;

  db.prepare(`
    INSERT INTO workbenches (
      id, user_id, organization_id, name, component_name, status, created_at, updated_at, last_opened_at, is_archived
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, 0)
  `).run(id, userId, organizationId, finalName, componentName, now, now, now);

  const workbenchDir = getWorkbenchDir(userId, id);
  ensureDir(workbenchDir);

  return getWorkbenchRecord(db, userId, id);
}

/**
 * Retrieves a raw workbench record for an authenticated user.
 */
function getWorkbenchRecord(db, userId, workbenchId) {
  const row = db.prepare(`
    SELECT * FROM workbenches WHERE id = ? AND user_id = ?
  `).get(workbenchId, userId);

  if (!row) {
    const err = new Error("Workbench not found or access denied.");
    err.status = 404;
    throw err;
  }
  return row;
}

/**
 * Lists all non-archived workbenches for a user with aggregated statistics.
 */
export function listWorkbenches(db, userId, { includeArchived = false } = {}) {
  const query = `
    SELECT 
      w.*,
      (SELECT COUNT(*) FROM workbench_assets a WHERE a.workbench_id = w.id AND a.category = 'uploaded_image') AS image_count,
      (SELECT COUNT(*) FROM workbench_assets a WHERE a.workbench_id = w.id AND a.category LIKE 'cad_%') AS cad_export_count,
      (SELECT s.version FROM workbench_snapshots s WHERE s.workbench_id = w.id ORDER BY s.version DESC LIMIT 1) AS latest_version
    FROM workbenches w
    WHERE w.user_id = ? ${includeArchived ? "" : "AND w.is_archived = 0"}
    ORDER BY w.updated_at DESC
  `;

  const rows = db.prepare(query).all(userId);
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    organizationId: r.organization_id,
    name: r.name,
    componentName: r.component_name,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastOpenedAt: r.last_opened_at,
    isArchived: Boolean(r.is_archived),
    imageCount: Number(r.image_count) || 0,
    cadExportCount: Number(r.cad_export_count) || 0,
    hasAnalysis: r.status === "analyzed" || r.status === "completed",
    hasGeometry: r.status === "analyzed" || r.status === "completed",
    latestVersion: r.latest_version || 0,
  }));
}

/**
 * Retrieves full details for a workbench including its latest snapshot and assets.
 */
export function getWorkbench(db, userId, workbenchId) {
  const wb = getWorkbenchRecord(db, userId, workbenchId);

  // Update last_opened_at
  const now = Date.now();
  db.prepare("UPDATE workbenches SET last_opened_at = ? WHERE id = ?").run(now, workbenchId);

  const snapshotRow = db.prepare(`
    SELECT * FROM workbench_snapshots 
    WHERE workbench_id = ? 
    ORDER BY version DESC LIMIT 1
  `).get(workbenchId);

  let snapshotState = null;
  if (snapshotRow && snapshotRow.state_json) {
    try {
      snapshotState = JSON.parse(snapshotRow.state_json);
    } catch {
      snapshotState = null;
    }
  }

  const assets = db.prepare(`
    SELECT * FROM workbench_assets 
    WHERE workbench_id = ? 
    ORDER BY created_at ASC
  `).all(workbenchId).map((a) => ({
    id: a.id,
    workbenchId: a.workbench_id,
    category: a.category,
    originalFilename: a.original_filename,
    mimeType: a.mime_type,
    fileSize: a.file_size,
    createdAt: a.created_at,
    url: `/api/workbenches/${workbenchId}/assets/${a.id}`,
  }));

  return {
    workbench: {
      id: wb.id,
      userId: wb.user_id,
      organizationId: wb.organization_id,
      name: wb.name,
      componentName: wb.component_name,
      status: wb.status,
      createdAt: wb.created_at,
      updatedAt: wb.updated_at,
      lastOpenedAt: now,
      isArchived: Boolean(wb.is_archived),
    },
    snapshot: snapshotRow
      ? {
          id: snapshotRow.id,
          version: snapshotRow.version,
          schemaVersion: snapshotRow.schema_version,
          createdAt: snapshotRow.created_at,
          state: snapshotState,
        }
      : null,
    assets,
  };
}

/**
 * Updates metadata of a workbench (rename, archive, status).
 */
export function updateWorkbenchMetadata(db, userId, workbenchId, updates = {}) {
  getWorkbenchRecord(db, userId, workbenchId);
  const now = Date.now();

  const allowedFields = [];
  const params = [];

  if (typeof updates.name === "string" && updates.name.trim()) {
    allowedFields.push("name = ?");
    params.push(updates.name.trim());
  }
  if (typeof updates.componentName === "string") {
    allowedFields.push("component_name = ?");
    params.push(updates.componentName.trim());
  }
  if (typeof updates.status === "string") {
    allowedFields.push("status = ?");
    params.push(updates.status);
  }
  if (typeof updates.isArchived === "boolean") {
    allowedFields.push("is_archived = ?");
    params.push(updates.isArchived ? 1 : 0);
  }

  if (allowedFields.length === 0) {
    return getWorkbenchRecord(db, userId, workbenchId);
  }

  allowedFields.push("updated_at = ?");
  params.push(now);
  params.push(workbenchId);
  params.push(userId);

  const query = `UPDATE workbenches SET ${allowedFields.join(", ")} WHERE id = ? AND user_id = ?`;
  db.prepare(query).run(...params);

  return getWorkbenchRecord(db, userId, workbenchId);
}

/**
 * Saves a versioned snapshot of the engineering state.
 */
export function saveSnapshot(db, userId, workbenchId, state) {
  const wb = getWorkbenchRecord(db, userId, workbenchId);
  const now = Date.now();

  if (!state || typeof state !== "object") {
    const err = new Error("Invalid state payload for snapshot.");
    err.status = 400;
    throw err;
  }

  // Determine latest version
  const lastSnap = db.prepare(`
    SELECT version FROM workbench_snapshots WHERE workbench_id = ? ORDER BY version DESC LIMIT 1
  `).get(workbenchId);

  const nextVersion = (lastSnap?.version || 0) + 1;
  const snapshotId = crypto.randomUUID();
  const serialized = JSON.stringify(state);

  // Check if status or component name can be deduced
  let componentName = wb.component_name;
  let status = wb.status;
  let name = wb.name;

  if (typeof state.workbenchName === "string" && state.workbenchName.trim()) {
    name = state.workbenchName.trim();
  } else if (typeof state.name === "string" && state.name.trim()) {
    name = state.name.trim();
  }

  const analysis = state.analysis || state.machineryState?.primaryGear?.analysis;
  if (analysis) {
    status = "completed";
    if (analysis.componentName && typeof analysis.componentName === "string") {
      componentName = analysis.componentName;
    }
  } else if (state.machineryState?.primaryGear?.images?.length) {
    status = "draft";
  }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO workbench_snapshots (id, workbench_id, version, schema_version, state_json, created_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(snapshotId, workbenchId, nextVersion, serialized, now);

    db.prepare(`
      UPDATE workbenches 
      SET updated_at = ?, status = ?, component_name = ?, name = ?
      WHERE id = ? AND user_id = ?
    `).run(now, status, componentName, name, workbenchId, userId);
  });

  tx();

  return {
    id: snapshotId,
    workbenchId,
    version: nextVersion,
    schemaVersion: 1,
    createdAt: now,
  };
}

/**
 * Saves an asset file to disk and registers metadata in SQLite.
 */
export function saveAsset(db, userId, workbenchId, {
  category = "uploaded_image",
  originalFilename = "asset",
  mimeType = "application/octet-stream",
  buffer,
}) {
  getWorkbenchRecord(db, userId, workbenchId);

  if (!buffer || !(buffer instanceof Buffer || buffer instanceof Uint8Array)) {
    const err = new Error("Asset buffer is required.");
    err.status = 400;
    throw err;
  }

  const assetId = crypto.randomUUID();
  const wbDir = getWorkbenchDir(userId, workbenchId);
  ensureDir(wbDir);

  const ext = path.extname(originalFilename) || "";
  const storedFilename = `${assetId}${ext}`;
  const targetPath = getSafeAssetPath(wbDir, storedFilename);

  // Atomic file write using temporary file
  const tmpPath = `${targetPath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, targetPath);

  const fileSize = buffer.length;
  const relativePath = path.join(String(userId), String(workbenchId), storedFilename);
  const now = Date.now();

  db.prepare(`
    INSERT INTO workbench_assets (
      id, workbench_id, user_id, category, original_filename, stored_filename, mime_type, file_size, relative_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(assetId, workbenchId, userId, category, originalFilename, storedFilename, mimeType, fileSize, relativePath, now);

  // Touch workbench updated_at
  db.prepare("UPDATE workbenches SET updated_at = ? WHERE id = ?").run(now, workbenchId);

  return {
    id: assetId,
    workbenchId,
    category,
    originalFilename,
    storedFilename,
    mimeType,
    fileSize,
    createdAt: now,
    url: `/api/workbenches/${workbenchId}/assets/${assetId}`,
  };
}

/**
 * Retrieves asset record and full file path.
 */
export function getAsset(db, userId, workbenchId, assetId) {
  const asset = db.prepare(`
    SELECT * FROM workbench_assets 
    WHERE id = ? AND workbench_id = ? AND user_id = ?
  `).get(assetId, workbenchId, userId);

  if (!asset) {
    const err = new Error("Asset not found or access denied.");
    err.status = 404;
    throw err;
  }

  const wbDir = getWorkbenchDir(userId, workbenchId);
  const filePath = getSafeAssetPath(wbDir, asset.stored_filename);

  if (!fs.existsSync(filePath)) {
    const err = new Error("Asset file missing on disk.");
    err.status = 404;
    throw err;
  }

  return { asset, filePath };
}

/**
 * Lists all assets for a given workbench.
 */
export function listAssets(db, userId, workbenchId) {
  getWorkbenchRecord(db, userId, workbenchId);

  return db.prepare(`
    SELECT * FROM workbench_assets 
    WHERE workbench_id = ? AND user_id = ?
    ORDER BY created_at ASC
  `).all(workbenchId, userId).map((a) => ({
    id: a.id,
    workbenchId: a.workbench_id,
    category: a.category,
    originalFilename: a.original_filename,
    storedFilename: a.stored_filename,
    mimeType: a.mime_type,
    fileSize: a.file_size,
    createdAt: a.created_at,
    url: `/api/workbenches/${workbenchId}/assets/${a.id}`,
  }));
}

/**
 * Safely deletes a workbench and its assets from SQLite and filesystem.
 */
export function deleteWorkbench(db, userId, workbenchId) {
  getWorkbenchRecord(db, userId, workbenchId);

  // Database cascade deletes snapshots and assets
  db.prepare("DELETE FROM workbenches WHERE id = ? AND user_id = ?").run(workbenchId, userId);

  try {
    const wbDir = getWorkbenchDir(userId, workbenchId);
    if (fs.existsSync(wbDir)) {
      fs.rmSync(wbDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Warning: Failed to clean up workbench directory:", err);
  }

  return { ok: true, deletedId: workbenchId };
}
