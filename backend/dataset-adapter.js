/**
 * dataset-adapter.js
 * Communicates with the independent Python dataset retrieval service.
 * Retrieval failures are fail-open by default so the Gemini path keeps working.
 */
import http from 'node:http';
import https from 'node:https';
import { getDatasetConfig, getCatalogSummary } from './dataset-catalog.js';

function requestJson({ url, method = 'GET', body = null, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error(`Invalid dataset service URL: ${error.message}`));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Dataset service returned HTTP ${res.statusCode}.`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Dataset service returned invalid JSON: ${error.message}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Dataset service request timed out after ${timeoutMs}ms.`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function unavailable(reason, details = {}) {
  return {
    schemaVersion: 1,
    status: 'unavailable',
    confidence: 0,
    analysis: null,
    match: null,
    candidates: [],
    diagnostics: { reason, checkedAt: new Date().toISOString(), ...details },
  };
}

function normalizeMatch(rawMatch) {
  if (!rawMatch || typeof rawMatch !== 'object') return null;
  const model = rawMatch.datasetModel;
  if (!model || typeof model.assetId !== 'string' || typeof model.viewerMeshBase64 !== 'string') {
    return null;
  }
  if (model.viewerMeshBase64.length < 100 || model.viewerMeshBase64.length > 12 * 1024 * 1024) {
    return null;
  }
  const confidence = Number(rawMatch.confidence);
  return {
    ...rawMatch,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}

export async function getDatasetServiceStatus() {
  const config = getDatasetConfig();
  const summary = getCatalogSummary();
  try {
    const health = await requestJson({
      url: new URL('/health', config.serviceUrl).toString(),
      timeoutMs: Math.min(3000, config.timeoutMs),
    });
    return {
      ...summary,
      serviceAvailable: Boolean(health?.ok),
      service: health,
    };
  } catch (error) {
    return {
      ...summary,
      serviceAvailable: false,
      serviceError: error?.message || 'Dataset service unreachable.',
    };
  }
}

export async function retrieveDatasetModel({ images, reference, visionEvidence }) {
  const config = getDatasetConfig();
  if (!config.enabled) {
    return { ...unavailable('Dataset retrieval is disabled.'), status: 'disabled' };
  }
  if (!config.datasetFirst) {
    return { ...unavailable('Dataset-first retrieval is disabled.'), status: 'skipped' };
  }
  if (!Array.isArray(images) || images.length === 0) {
    return unavailable('No images supplied to retrieval.');
  }

  const payload = {
    schemaVersion: 1,
    images: images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
    reference: reference || {},
    visionEvidence: visionEvidence || null,
  };

  try {
    const response = await requestJson({
      url: new URL('/retrieve', config.serviceUrl).toString(),
      method: 'POST',
      body: payload,
      timeoutMs: config.timeoutMs,
    });
    if (!response || response.schemaVersion !== 1 || !['match', 'rejected', 'unavailable'].includes(response.status)) {
      return unavailable('Dataset service returned an unsupported response envelope.');
    }
    const match = response.status === 'match' ? normalizeMatch(response.match) : null;
    const effectiveStatus = response.status === 'match' && !match ? 'rejected' : response.status;
    return {
      schemaVersion: 1,
      status: effectiveStatus,
      confidence: match ? match.confidence : 0,
      analysis: match,
      match,
      candidates: Array.isArray(response.candidates) ? response.candidates.slice(0, 8) : [],
      diagnostics: response.diagnostics || {},
    };
  } catch (error) {
    const reason = error?.message || 'Dataset retrieval failed.';
    console.warn('[dataset-adapter] Retrieval unavailable (continuing with Gemini path):', reason);
    return unavailable(reason, { failOpen: config.failOpen });
  }
}
