export class ApiError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isCancellationError(error) {
  return error?.name === "AbortError" || error?.code === "cancelled" || error?.status === 499;
}

function isRetryableError(error) {
  return error?.code === "cancelled"
    ? false
    : error?.status === 0 || error?.status === 408 || error?.status === 429 || error?.status >= 500;
}

export async function postJson(url, body, { signal } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    throw new ApiError("Cannot reach the ReForge AI server. Is it running?", 0);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // ignore malformed body; use status text below
  }
  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed (${response.status}).`, response.status);
  }
  return payload;
}

export async function getJson(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
      credentials: "include",
    });
  } catch {
    throw new ApiError("Cannot reach the ReForge AI server. Is it running?", 0);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // ignore
  }
  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed (${response.status}).`, response.status);
  }
  return payload;
}

const MAX_UPLOAD_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_IMAGE_DIMENSION = 2048;
const COMPRESS_THRESHOLD_BYTES = 2.5 * 1024 * 1024;
const MAX_UPLOAD_IMAGES = 8;

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the selected image."));
    img.src = src;
  });
}

async function compressImageFile(file) {
  const dataUrl = await readFileAsDataURL(file);
  const originalMime = String(file.type || "image/png").toLowerCase();
  const isAvif = originalMime === "image/avif" || /\.avif$/i.test(file.name || "");
  let img;
  try {
    img = await loadImageElement(dataUrl);
  } catch (error) {
    if (isAvif) {
      throw new ApiError(
        `Image "${file.name || "upload"}" is AVIF but this browser could not decode it. Try another browser or convert it to JPEG/PNG/WebP.`,
        400
      );
    }
    throw error;
  }

  const maxDim = MAX_UPLOAD_IMAGE_DIMENSION;
  const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
  const needsResize = scale < 1;
  // Gemini does not accept AVIF inline data, so always transcode it to JPEG.
  const needsTranscode = isAvif;
  const needsCompress = file.size > COMPRESS_THRESHOLD_BYTES || needsResize || needsTranscode;
  if (!needsCompress) {
    const comma = dataUrl.indexOf(",");
    return { mimeType: originalMime || "image/png", data: dataUrl.slice(comma + 1) };
  }

  const width = Math.max(1, Math.round((img.width || 1) * scale));
  const height = Math.max(1, Math.round((img.height || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const comma = dataUrl.indexOf(",");
    return { mimeType: originalMime || "image/png", data: dataUrl.slice(comma + 1) };
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const mimeType = originalMime === "image/webp" && !needsTranscode ? "image/webp" : "image/jpeg";
  let quality = 0.85;
  let out = canvas.toDataURL(mimeType, quality);
  while (out.length * 0.75 > MAX_UPLOAD_IMAGE_BYTES && quality > 0.5) {
    quality -= 0.1;
    out = canvas.toDataURL(mimeType, quality);
  }
  const comma = out.indexOf(",");
  const data = out.slice(comma + 1);
  const approxBytes = Math.floor((data.length * 3) / 4);
  if (approxBytes > MAX_UPLOAD_IMAGE_BYTES) {
    throw new ApiError(
      `Image "${file.name || "upload"}" is too large after compression. Please use a smaller image (max ${Math.round(MAX_UPLOAD_IMAGE_BYTES / (1024 * 1024))} MB).`,
      413
    );
  }
  return { data, mimeType };
}

export async function fileToPayload(file) {
  if (!(file instanceof Blob)) {
    throw new ApiError("The selected image is no longer available. Remove it and select it again.", 400);
  }
  const mime = String(file.type || "").toLowerCase();
  const nameOk = /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name || "");
  if (mime && !mime.startsWith("image/") && !nameOk) {
    throw new ApiError(`Unsupported file type: ${file.type || "unknown"}. Use JPEG, PNG, WebP, GIF, BMP, or AVIF images.`, 400);
  }
  if (file.size > 30 * 1024 * 1024) {
    throw new ApiError(
      `Image "${file.name || "upload"}" is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum 30 MB before compression.`,
      413
    );
  }
  return compressImageFile(file);
}

function cancellationError() {
  return new ApiError("Reconstruction cancelled.", 499, "cancelled");
}

async function postNdjson(url, body, { onEvent, signal, attempt = 1 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    throw new ApiError("Cannot reach the ReForge AI server. Is it running?", 0);
  }

  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { /* use status text below */ }
    throw new ApiError(payload?.error || `Request failed (${response.status}).`, response.status);
  }

  const readEvents = async (lines) => {
    let result = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        throw new ApiError("Invalid reconstruction progress update from server.", 502);
      }
      onEvent?.({ ...event, attempt });
      if (event.type === "result") result = event;
      if (event.type === "failed") {
        throw new ApiError(event.message || "Analysis failed.", 502);
      }
    }
    return result;
  };

  try {
    if (!response.body?.getReader) {
      return await readEvents((await response.text()).split(/\r?\n/));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      const eventsResult = await readEvents(lines);
      if (eventsResult) result = eventsResult;
      if (done) break;
    }
    const tailResult = await readEvents([buffer]);
    if (tailResult) result = tailResult;
    if (!result) throw new ApiError("Server returned no analysis.", 502);
    return result;
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    throw error;
  }
}

export async function analyzeComponent(images, reference, options = {}) {
  const { onProgress, signal, retries = 0, includeCondition = false } = options;
  const totalImages = Array.isArray(images) ? images.length : 0;

  if (signal?.aborted) throw cancellationError();
  if (!totalImages) throw new ApiError("No images provided. Add at least one component image.", 400);
  if (totalImages > MAX_UPLOAD_IMAGES) {
    throw new ApiError(`Too many images. Maximum ${MAX_UPLOAD_IMAGES} images per analysis.`, 400);
  }
  onProgress?.({ stage: "image-analysis", status: "running", completed: 0, total: totalImages });

  let payloads;
  try {
    payloads = await Promise.all(images.map(({ file }) => fileToPayload(file)));
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    throw error;
  }
  onProgress?.({ stage: "image-analysis", status: "complete", completed: totalImages, total: totalImages });

  const maxAttempts = Math.max(1, retries + 1);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw cancellationError();
    if (attempt > 1) {
      onProgress?.({
        stage: "image-analysis",
        status: "running",
        attempt,
        completed: 0,
        total: totalImages,
        message: `Retrying analysis (attempt ${attempt}).`,
      });
    }
    try {
      const result = await postNdjson(
        "/api/analyze-component/stream",
        { images: payloads, reference, includeCondition },
        { onEvent: onProgress, signal, attempt }
      );
      if (!result || !result.analysis) throw new ApiError("Server returned no analysis.", 502);
      const analysis = {
        ...result.analysis,
        solverMode: result.solverMode || result.analysis.solverMode || null,
        datasetRetrieval: result.datasetRetrieval || result.analysis.datasetRetrieval || null,
        visionDiagnostics: result.visionDiagnostics || result.analysis.visionDiagnostics || null,
      };
      // Defense in depth: never present a deterministic template fallback as a
      // successful image-derived reconstruction.
      if (analysis.solverMode === "deterministic_fallback" || analysis.provenance === "deterministic_fallback_engine") {
        throw new ApiError(
          "Image analysis could not be completed by the AI model. A generic template was not used. Check GEMINI_API_KEY/model availability and retry with clear component photos.",
          502
        );
      }
      return analysis;
    } catch (error) {
      if (isCancellationError(error)) throw cancellationError();
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableError(error)) throw error;
    }
  }
  throw lastError || new ApiError("Analysis failed.", 500);
}

/**
 * Loads image-space condition evidence only when the health panel or heatmap
 * is opened. Geometry reconstruction never waits for this request.
 */
export async function analyzeCondition(images, analysis, { signal } = {}) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const payloads = await Promise.all(images.map(({ file }) => fileToPayload(file)));
  const result = await postJson(
    "/api/analyze-condition",
    {
      images: payloads,
      analysis: {
        componentType: analysis?.componentType || '',
        gearType: analysis?.gearType || analysis?.geometryRecipe?.gear?.gearType || null,
        requiresGearTypeConfirmation: Boolean(analysis?.requiresGearTypeConfirmation),
        teeth: analysis?.teeth ?? analysis?.geometryRecipe?.gear?.teeth ?? null,
        module: analysis?.module ?? analysis?.geometryRecipe?.gear?.module ?? null,
        helixAngle: analysis?.helixAngle ?? analysis?.geometryRecipe?.gear?.helixAngle ?? null,
        coneAngle: analysis?.coneAngle ?? analysis?.geometryRecipe?.gear?.coneAngle ?? null,
        geometryRecipe: analysis?.geometryRecipe || null,
      },
    },
    { signal }
  );
  return result?.conditionAssessment || null;
}

export async function sendChatMessage(message, engineeringContextOrAnalysis, history) {
  const isContext =
    engineeringContextOrAnalysis &&
    typeof engineeringContextOrAnalysis === "object" &&
    "component" in engineeringContextOrAnalysis;

  const payload = {
    message,
    history,
    engineeringContext: isContext ? engineeringContextOrAnalysis : null,
    analysis: isContext ? null : engineeringContextOrAnalysis,
  };

  const result = await postJson("/api/chat", payload);
  if (!result || typeof result.text !== "string") throw new ApiError("Server returned no reply.", 502);
  return result.text;
}

export async function simulateEngineeringChange(analysis, modifications, quantity = 10) {
  const result = await postJson("/api/engineering-simulate", { analysis, modifications, quantity });
  return result;
}

