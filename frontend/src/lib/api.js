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

export function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    if (!(file instanceof Blob)) {
      reject(new ApiError("The selected image is no longer available. Remove it and select it again.", 400));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.onload = () => {
      const dataUrl = reader.result;
      const comma = dataUrl.indexOf(",");
      resolve({ mimeType: file.type || "image/png", data: dataUrl.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });
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
  const totalImages = images.length;

  if (signal?.aborted) throw cancellationError();
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
      // Preserve the unified reconstruction envelope on the analysis object so
      // existing consumers keep working while provenance/solver mode remain
      // available to the viewer and engineering panels.
      return {
        ...result.analysis,
        solverMode: result.solverMode || result.analysis.solverMode || null,
        datasetRetrieval: result.datasetRetrieval || result.analysis.datasetRetrieval || null,
        visionDiagnostics: result.visionDiagnostics || result.analysis.visionDiagnostics || null,
      };
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

