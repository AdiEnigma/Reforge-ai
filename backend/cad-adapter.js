/**
 * cad-adapter.js
 * Communicates with the Python CAD engine (python-engine/app.py).
 *
 * Unlike the vision/reconstruction adapters this call is NOT fail-open: the
 * result of CAD generation is the deliverable, so transport and validation
 * failures are surfaced to the caller. The function still always resolves and
 * never throws.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

function cadConfig() {
  return {
    enabled: process.env.CAD_ENABLED === "true",
    serviceUrl: process.env.CAD_SERVICE_URL || "http://127.0.0.1:8766",
    timeoutMs: (Number(process.env.CAD_TIMEOUT_SECONDS) || 120) * 1000,
  };
}

export function isCadEnabled() {
  return cadConfig().enabled;
}

const ADVANCED_LEGACY_STYLES = new Set(["revolved", "extruded", "combination"]);

/**
 * Pick the Python CAD endpoint for a recipe.
 *
 * Legacy `/cad/generate` remains the default for every style (including gears,
 * which the advanced adapter cannot convert). When `CAD_ADVANCED_ENABLED=true`,
 * non-gear revolved/extruded/combination recipes are routed through the
 * feature-based `/cad/generate-advanced` pipeline.
 *
 * @returns {{ path: string, mode: "legacy" | "advanced" }}
 */
export function chooseCadRoute(recipe, _solverOutput = null) {
  const advancedEnabled = process.env.CAD_ADVANCED_ENABLED === "true";
  const style = recipe && typeof recipe === "object" ? recipe.style : null;
  if (advancedEnabled && ADVANCED_LEGACY_STYLES.has(style)) {
    return { path: "/cad/generate-advanced", mode: "advanced" };
  }
  return { path: "/cad/generate", mode: "legacy" };
}

/**
 * POST to the Python CAD engine.
 *
 * @param {Object} payload
 * @param {{ path?: string, mode?: string }} [route] - explicit route; when
 *   omitted, `chooseCadRoute(payload.recipe, payload.solver_output)` is used.
 *
 * Resolves with:
 *   { ok: true,  status, body }
 *   { ok: false, status, body, error }
 *
 * `body` is the parsed JSON response when available. Never rejects.
 */
export async function callCadService(payload, route = null) {
  const config = cadConfig();
  if (!config.enabled) {
    return {
      ok: false,
      status: 503,
      body: null,
      error: "CAD generation is disabled. Set CAD_ENABLED=true.",
    };
  }

  const body = JSON.stringify(payload || {});
  const routePath =
    (route && route.path) ||
    chooseCadRoute(payload?.recipe, payload?.solver_output).path;

  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(routePath, config.serviceUrl);
    } catch {
      console.warn("[cad-adapter] Invalid CAD_SERVICE_URL:", config.serviceUrl);
      return resolve({
        ok: false,
        status: 500,
        body: null,
        error: "CAD service URL is misconfigured.",
      });
    }

    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 16 * 1024 * 1024) {
            req.destroy();
            finish({
              ok: false,
              status: 502,
              body: null,
              error: "CAD service response was too large.",
            });
          }
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }
          const status = Number(res.statusCode) || 500;
          if (status >= 200 && status < 300 && parsed) {
            return finish({ ok: true, status, body: parsed });
          }
          finish({
            ok: false,
            status,
            body: parsed,
            error:
              parsed?.error ||
              parsed?.detail ||
              `CAD service responded with status ${status}.`,
          });
        });
      }
    );

    req.setTimeout(config.timeoutMs, () => {
      console.warn("[cad-adapter] Request timed out after", config.timeoutMs, "ms");
      req.destroy();
      finish({
        ok: false,
        status: 504,
        body: null,
        error: "CAD generation timed out.",
      });
    });

    req.on("error", (error) => {
      console.warn("[cad-adapter] CAD service unreachable:", error.message);
      finish({
        ok: false,
        status: 503,
        body: null,
        error: "CAD service is unreachable.",
      });
    });

    req.write(body);
    req.end();
  });
}
