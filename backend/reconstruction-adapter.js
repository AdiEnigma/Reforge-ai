/**
 * reconstruction-adapter.js
 * Communicates with the Python reconstruction service (app.py).
 * Follows the fail-open pattern: if the reconstruction service is unavailable or disabled,
 * returns null so the existing workflow continues unchanged.
 */
import { request } from 'node:http';

const RECONSTRUCTION_SERVICE_URL = process.env.RECONSTRUCTION_SERVICE_URL || 'http://127.0.0.1:8766';
const RECONSTRUCTION_ENABLED = process.env.RECONSTRUCTION_ENABLED === 'true';
const RECONSTRUCTION_TIMEOUT_MS = (Number(process.env.RECONSTRUCTION_TIMEOUT_SECONDS) || 60) * 1000;

export function isReconstructionEnabled() {
  return RECONSTRUCTION_ENABLED;
}

/**
 * Call POST /reconstruct on the Python reconstruction engine.
 * Always resolves (never rejects). Returns null on any failure.
 */
export async function callReconstructionService(payload) {
  if (!RECONSTRUCTION_ENABLED) return null;

  const body = JSON.stringify(payload || {});

  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/reconstruct', RECONSTRUCTION_SERVICE_URL);
    } catch {
      console.warn('[reconstruction-adapter] Invalid RECONSTRUCTION_SERVICE_URL:', RECONSTRUCTION_SERVICE_URL);
      return resolve(null);
    }

    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 8766,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            console.warn('[reconstruction-adapter] Invalid JSON response:', e.message);
            resolve(null);
          }
        });
      }
    );

    req.setTimeout(RECONSTRUCTION_TIMEOUT_MS, () => {
      console.warn('[reconstruction-adapter] Request timed out after', RECONSTRUCTION_TIMEOUT_MS, 'ms');
      req.destroy();
      resolve(null);
    });

    req.on('error', (e) => {
      console.warn('[reconstruction-adapter] Service unreachable (continuing without reconstruction):', e.message);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

