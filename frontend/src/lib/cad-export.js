/**
 * cad-export.js
 * Client helper for server-backed CAD exports.
 *
 * The Export Center used to assemble STEP/IGES text in the browser, which no CAD
 * kernel could read. All CAD/mesh downloads now come from the backend, which
 * builds real B-Rep solids with CadQuery (python-engine/exports/reconstruction_export.py).
 */

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

  let response;
  try {
    response = await fetch("/api/cad/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
