/**
 * reconstruction-adapter.js
 * Communicates with the Python reconstruction service (app.py).
 * Follows the fail-open pattern: if the reconstruction service is unavailable or disabled,
 * returns null so the existing workflow continues unchanged.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function reconstructionConfig() {
  return {
    enabled: process.env.RECONSTRUCTION_ENABLED === 'true',
    serviceUrl: process.env.RECONSTRUCTION_SERVICE_URL || 'http://127.0.0.1:8766',
    timeoutMs: (Number(process.env.RECONSTRUCTION_TIMEOUT_SECONDS) || 60) * 1000,
  };
}

export function isReconstructionEnabled() {
  return reconstructionConfig().enabled;
}

/**
 * Call POST /reconstruct on the Python reconstruction engine.
 * Always resolves (never rejects). Returns null on any failure.
 */
export async function callReconstructionService(payload) {
  const config = reconstructionConfig();
  if (!config.enabled) return null;

  const body = JSON.stringify(payload || {});

  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/reconstruct', config.serviceUrl);
    } catch {
      console.warn('[reconstruction-adapter] Invalid RECONSTRUCTION_SERVICE_URL:', config.serviceUrl);
      return resolve(null);
    }

    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

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

    req.setTimeout(config.timeoutMs, () => {
      console.warn('[reconstruction-adapter] Request timed out after', config.timeoutMs, 'ms');
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

