export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
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

export async function analyzeComponentDetailed(images, reference) {
  const payloads = await Promise.all(images.map(({ file }) => fileToPayload(file)));
  const result = await postJson("/api/analyze-component", { images: payloads, reference });
  if (!result || !result.analysis) throw new ApiError("Server returned no analysis.", 502);
  return result;
}

export async function analyzeComponent(images, reference) {
  const result = await analyzeComponentDetailed(images, reference);
  return result.analysis;
}

export async function buildCad({ analysis, reference, recipe, userDimensions }) {
  return postJson("/api/cad/build", {
    analysis,
    reference,
    recipe,
    user_dimensions: userDimensions,
  });
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
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

const TERMINAL_JOB_STATES = new Set(["done", "failed", "needs_input", "unavailable"]);

export async function createJob(images, reference) {
  const payloads = await Promise.all((images || []).map(({ file }) => fileToPayload(file)));
  return postJson("/api/jobs", { images: payloads, reference });
}

export async function fetchJob(jobId) {
  return getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export async function resumeJob(jobId, userDimensions) {
  return postJson(`/api/jobs/${encodeURIComponent(jobId)}/resume`, {
    user_dimensions: userDimensions,
  });
}

export async function waitForJob(jobId, { intervalMs = 1200, timeoutMs = 180000, onUpdate } = {}) {
  const started = Date.now();
  for (;;) {
    const job = await fetchJob(jobId);
    if (typeof onUpdate === "function") onUpdate(job);
    if (job && TERMINAL_JOB_STATES.has(job.state)) return job;
    if (Date.now() - started > timeoutMs) {
      throw new ApiError("Reconstruction job timed out.", 504);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Create a job, then poll until it reaches a terminal state. */
export async function runAnalysisJob(images, reference, options = {}) {
  const job = await createJob(images, reference);
  if (!job?.id) throw new ApiError("Server did not return a job id.", 502);
  return waitForJob(job.id, options);
}

export async function fetchCadMesh(fileUrl, options) {
  const response = await fetch(fileUrl, options);
  if (!response.ok) {
    throw new ApiError(`Could not load CAD preview (${response.status}).`, response.status);
  }
  return response.json();
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

