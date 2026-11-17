export class ApiError extends Error {
  constructor(message, status = 500, code = "api_error", details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// In-memory CSRF token storage
let currentCsrfToken = null;

export function setCsrfToken(token) {
  currentCsrfToken = token || null;
}

export function getCsrfToken() {
  return currentCsrfToken;
}

// Global session expiry subscriber callback
let onSessionExpiredCallback = null;

export function setSessionExpiredHandler(callback) {
  onSessionExpiredCallback = callback;
}

let sessionExpiredHandled = false;

export function resetSessionExpiredFlag() {
  sessionExpiredHandled = false;
}

/**
 * Universal API fetch helper
 */
export async function apiFetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...options.headers };

  // Include credentials (session cookies) on every request
  const fetchOptions = {
    ...options,
    method,
    credentials: "include",
    headers,
  };

  // Attach X-RF-CSRF header on state-changing requests if CSRF token is in memory
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && currentCsrfToken) {
    headers["X-RF-CSRF"] = currentCsrfToken;
  }

  let response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (err) {
    throw new ApiError("Cannot reach the ReForge AI server. Please check your network connection.", 0, "network_error");
  }

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorObj = payload?.error || {};
    const errorCode = typeof errorObj === "object" ? errorObj.code : (payload?.code || "error");
    const errorMessage = typeof errorObj === "object"
      ? (errorObj.message || payload?.message)
      : (typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`);
    const errorDetails = typeof errorObj === "object" ? (errorObj.details || {}) : {};

    // Single-flight session_expired handling
    if (response.status === 401 && (errorCode === "session_expired" || errorCode === "session_revoked")) {
      if (!sessionExpiredHandled && onSessionExpiredCallback && !url.includes("/api/auth/login") && !url.includes("/api/auth/register")) {
        sessionExpiredHandled = true;
        onSessionExpiredCallback(errorCode);
      }
    }

    const apiErr = new ApiError(errorMessage, response.status, errorCode, errorDetails);
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      apiErr.retryAfter = Number(retryAfter) || retryAfter;
    }
    throw apiErr;
  }

  return payload;
}

export async function getJson(url, options = {}) {
  return apiFetch(url, { ...options, method: "GET" });
}

export async function postJson(url, body, options = {}) {
  return apiFetch(url, {
    ...options,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body || {}),
  });
}

export async function deleteJson(url, options = {}) {
  return apiFetch(url, { ...options, method: "DELETE" });
}

export function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    if (!(file instanceof Blob)) {
      reject(new ApiError("The selected image is no longer available. Remove it and select it again.", 400, "invalid_file"));
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

export async function analyzeComponent(images, reference) {
  const payloads = await Promise.all(images.map(({ file }) => fileToPayload(file)));
  const result = await postJson("/api/analyze-component", { images: payloads, reference });
  if (!result || !result.analysis) throw new ApiError("Server returned no analysis.", 502, "empty_analysis");
  return result.analysis;
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
  if (!result || typeof result.text !== "string") throw new ApiError("Server returned no reply.", 502, "empty_reply");
  return result.text;
}

export async function simulateEngineeringChange(analysis, modifications, quantity = 10) {
  const result = await postJson("/api/engineering-simulate", { analysis, modifications, quantity });
  return result;
}
