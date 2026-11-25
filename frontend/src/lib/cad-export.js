/**
 * cad-export.js
 * Client helper for server-backed CAD exports.
 *
 * The Export Center used to assemble STEP/IGES text in the browser, which no CAD
 * kernel could read. All CAD/mesh downloads now come from the backend, which
 * builds real B-Rep solids with CadQuery (python-engine/exports/reconstruction_export.py).
 */

import { exportAndSaveCadApi } from "./workbench-api.js";

export const CAD_EXPORT_MIME_TYPES = {
  step: "application/step",
  iges: "application/iges",
  stl: "model/stl",
  obj: "model/obj",
};

export function cadExportSlug(analysis, fallback = "component") {
  const raw =
    analysis?.componentName ||
    analysis?.componentType ||
    analysis?.label ||
    analysis?.classification?.type ||
    fallback;
  const slug = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function filenameFromDisposition(header) {
  if (!header || typeof header !== "string") return null;
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8 && utf8[1]) return decodeURIComponent(utf8[1]);
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain && plain[1] ? plain[1] : null;
}

/**
 * Request a CAD artifact from the backend.
 * Resolves with { blob, filename, format, mimeType }.
 */
export async function requestCadExport(analysis, format, options = {}) {
  const mimeType = CAD_EXPORT_MIME_TYPES[format];
  if (!mimeType) {
    throw new Error(`Unsupported CAD export format: ${format}`);
  }
  const baseName = options.baseName || cadExportSlug(analysis);
  const wbId = options.workbenchId || (typeof window !== "undefined" ? window.__REFORGE_CURRENT_WB_ID__ : null);
  let response;
  let assetUrl;
  if (wbId) {
    const saved = await exportAndSaveCadApi(wbId, { analysis, format, baseName });
    if (!saved?.asset?.id) throw new Error("CAD export did not return a saved asset.");
    assetUrl = `/api/workbenches/${encodeURIComponent(wbId)}/assets/${encodeURIComponent(saved.asset.id)}`;
  }
  try {
    response = assetUrl ? await fetch(assetUrl, { credentials: "include" }) : await fetch("/api/cad/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ analysis, format, baseName }),
    });
  } catch {
    throw new Error(
      "Cannot reach the ReForge AI server — CAD export runs on the backend, so start it with `npm run server`."
    );
  }

  if (!response.ok) {
    let message = `CAD export failed (${response.status}).`;
    try {
      const payload = await response.json();
      if (payload && typeof payload.error === "string") message = payload.error;
    } catch {
      // keep the status-based message
    }
    throw new Error(message);
  }

  const contentType = response.headers?.get?.("content-type") || "";
  if (/json|text\/html/i.test(contentType)) {
    throw new Error("The CAD download returned a server message instead of a model.");
  }
  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers?.get?.("content-disposition")) ||
    `${baseName}.${format}`;
  return { blob, filename, format, mimeType };
}

/**
 * Request and trigger the browser download.
 * Returns { content, filename, mimeType } (also in Node, so tests can assert it).
 */
export async function downloadCadExport(analysis, format, options = {}) {
  const { blob, filename, mimeType } = await requestCadExport(analysis, format, options);

  if (typeof document === "undefined" || typeof window === "undefined") {
    return { content: blob, filename, mimeType };
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    if (link.parentNode) document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 300);

  return { content: blob, filename, mimeType };
}
