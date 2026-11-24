/**
 * spatial-evidence-store.js
 * Content-addressed, structured storage and retrieval for raw spatial vision evidence.
 * Preserves 100% of SAM 2 masks, boundary polygons, Depth Anything V2 depth grids,
 * and OpenCV contour coordinate arrays without truncating or stripping.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const EVIDENCE_DIR = path.resolve(os.tmpdir(), 'reforge_spatial_evidence');

try {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
} catch (err) {
  console.warn('[spatial-evidence-store] Error creating storage directory:', err.message);
}

// In-memory hot cache for active reconstruction turn
const memoryCache = new Map();

/**
 * Computes a deterministic SHA256 identifier for a spatial evidence payload.
 */
export function computeEvidenceHash(evidence) {
  if (!evidence) return null;
  const hash = crypto.createHash('sha256');
  if (typeof evidence === 'string') {
    hash.update(evidence);
  } else {
    hash.update(JSON.stringify(evidence));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Stores full spatial vision evidence (boundary polygons, depth grids, contours, circles).
 * Returns a stable reference ID.
 */
export function storeSpatialEvidence(rawVisionResult, customId = null) {
  if (!rawVisionResult || typeof rawVisionResult !== 'object') return null;

  const id = customId || `ev_${Date.now()}_${computeEvidenceHash(rawVisionResult) || Math.random().toString(36).slice(2, 8)}`;
  
  // Store in memory cache
  memoryCache.set(id, rawVisionResult);

  // Store on disk
  try {
    const filePath = path.join(EVIDENCE_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(rawVisionResult), 'utf-8');
  } catch (err) {
    console.warn(`[spatial-evidence-store] Failed to write evidence ${id} to disk:`, err.message);
  }

  return id;
}

/**
 * Retrieves the full uncompressed spatial vision evidence by reference ID.
 */
export function getSpatialEvidence(evidenceId) {
  if (!evidenceId) return null;

  if (memoryCache.has(evidenceId)) {
    return memoryCache.get(evidenceId);
  }

  try {
    const filePath = path.join(EVIDENCE_DIR, `${evidenceId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      memoryCache.set(evidenceId, data);
      return data;
    }
  } catch (err) {
    console.warn(`[spatial-evidence-store] Failed to read evidence ${evidenceId} from disk:`, err.message);
  }

  return null;
}

/**
 * Clears expired or cached evidence (optional maintenance).
 */
export function clearEvidenceCache() {
  memoryCache.clear();
}
