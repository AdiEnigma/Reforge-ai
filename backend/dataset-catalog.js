/**
 * dataset-catalog.js
 * Reads the dataset index/manifest produced by the Python retrieval tools and
 * resolves dataset asset paths for viewer/export endpoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE = path.resolve(__dirname, 'var', 'datasets');
const JSON_CACHE = new Map();
const FORMAT_MIME = Object.freeze({
  step: 'application/step',
  stl: 'model/stl',
  obj: 'text/plain',
  image: 'image/png',
  metadata: 'text/yaml',
  stats: 'text/yaml',
  features: 'text/yaml',
});

export function getDatasetConfig() {
  const storagePath = path.resolve(
    process.env.DATASET_STORAGE_PATH || process.env.REFORGE_DATASET_ROOT || DEFAULT_STORAGE
  );
  return {
    enabled: process.env.DATASET_RETRIEVAL_ENABLED !== 'false',
    datasetFirst: process.env.DATASET_FIRST !== 'false',
    failOpen: process.env.DATASET_FAIL_OPEN !== 'false',
    serviceUrl: process.env.DATASET_SERVICE_URL || 'http://127.0.0.1:8767',
    timeoutMs: (Number(process.env.DATASET_REQUEST_TIMEOUT_SECONDS) || 20) * 1000,
    storagePath,
    indexPath: path.join(storagePath, 'index', 'dataset-index.json'),
    manifestPath: path.join(storagePath, 'index', 'acquisition-manifest.json'),
  };
}

function readJson(file, fallback = null) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    JSON_CACHE.delete(file);
    return fallback;
  }
  const cached = JSON_CACHE.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    JSON_CACHE.set(file, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (error) {
    console.warn('[dataset-catalog] Could not read', file, error?.message);
    JSON_CACHE.delete(file);
    return fallback;
  }
}

export function readDatasetIndex() {
  return readJson(getDatasetConfig().indexPath);
}

export function readAcquisitionManifest() {
  return readJson(getDatasetConfig().manifestPath);
}

export function getCatalogSummary() {
  const config = getDatasetConfig();
  const index = readDatasetIndex();
  const manifest = readAcquisitionManifest();
  return {
    enabled: config.enabled,
    datasetFirst: config.datasetFirst,
    storagePath: config.storagePath,
    indexPresent: Boolean(index),
    manifestPresent: Boolean(manifest),
    counts: index?.counts || null,
    datasetAvailability: index?.datasetAvailability || null,
    licenseSummary: index?.licenseSummary || null,
    acquisition: manifest
      ? {
          generatedAt: manifest.generatedAt,
          abc: manifest.datasets?.abc?.status || null,
          multimodal: manifest.datasets?.multimodal?.status || null,
          multimodalParts: (manifest.datasets?.multimodal?.parts || []).map((part) => ({
            name: part.name,
            status: part.status,
            error: part.error || null,
          })),
        }
      : null,
  };
}

function isInsideStorage(filePath, storagePath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(storagePath) + path.sep;
  return resolved.startsWith(root);
}

export function resolveDatasetAsset(assetId, format) {
  if (typeof assetId !== 'string' || typeof format !== 'string') return null;
  const config = getDatasetConfig();
  const index = readDatasetIndex();
  if (!index || !Array.isArray(index.entries)) return null;
  const entry = index.entries.find(
    (candidate) => candidate.id === assetId || candidate.sourceId === assetId
  );
  if (!entry) return null;
  const asset = entry.assets?.[format.toLowerCase()];
  if (!asset || typeof asset.path !== 'string') return null;
  if (!isInsideStorage(asset.path, config.storagePath)) return null;
  if (!fs.existsSync(asset.path)) return null;
  return {
    ...asset,
    assetId: entry.id,
    entry,
    mimeType: FORMAT_MIME[format.toLowerCase()] || 'application/octet-stream',
  };
}

export function resolveAssetForDatasetModel(datasetModel, format) {
  if (!datasetModel || typeof datasetModel !== 'object') return null;
  const formats = Array.isArray(datasetModel.formats) ? datasetModel.formats : [];
  if (formats.includes(format)) return resolveDatasetAsset(datasetModel.assetId, format);
  return null;
}
