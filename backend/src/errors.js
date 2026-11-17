import crypto from "node:crypto";

/**
 * Standard Application Error with machine-readable code and status.
 */
export class AppError extends Error {
  constructor(code, message, status = 500, details = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Formats error responses into the standard P1 envelope:
 * {
 *   "error": {
 *     "code": "snake_case",
 *     "message": "User-safe message",
 *     "requestId": "request-id",
 *     "details": {}
 *   }
 * }
 */
export function formatErrorEnvelope(err, requestId = "unknown") {
  const code = err.code && typeof err.code === "string" ? err.code : "internal_error";
  const message = err.status && err.status < 500 ? err.message : (err.userMessage || "An unexpected internal server error occurred.");
  const details = err.details && typeof err.details === "object" ? err.details : {};

  return {
    error: {
      code,
      message,
      requestId,
      details,
    },
  };
}

/**
 * Request ID middleware.
 * Assigns or validates an incoming X-Request-Id header (alphanumeric/hyphen/underscore max 64 chars),
 * binds it to req.requestId, and sets the X-Request-Id response header.
 */
export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers["x-request-id"];
  const safeIncoming = typeof incoming === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(incoming)
    ? incoming
    : null;

  const id = safeIncoming || crypto.randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

/**
 * Central Error Handler Middleware.
 * Captures all thrown errors, maps to appropriate HTTP status, logs server diagnostics,
 * and responds with the standard error envelope without leaking stack traces or internal secrets.
 */
export function centralErrorHandler(err, req, res, _next) {
  const requestId = req?.requestId || res?.getHeader?.("X-Request-Id") || "unknown";
  const status = typeof err.status === "number" && err.status >= 400 && err.status < 600
    ? err.status
    : 500;

  // Log diagnostic info server-side with requestId for correlation
  if (status >= 500) {
    console.error(`[Error ${requestId}] ${status} ${req.method} ${req.originalUrl || req.url}:`, err);
  } else {
    console.warn(`[ClientError ${requestId}] ${status} ${req.method} ${req.originalUrl || req.url}: ${err.message}`);
  }

  // Handle PayloadTooLargeError from body-parser
  if (err.type === "entity.too.large" || err.status === 413) {
    const envelope = formatErrorEnvelope(
      new AppError("payload_too_large", "Request payload exceeds the maximum allowed size for this endpoint.", 413),
      requestId
    );
    return res.status(413).json(envelope);
  }

  // Handle SyntaxError from malformed JSON
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    const envelope = formatErrorEnvelope(
      new AppError("malformed_json", "Invalid JSON body provided in request.", 400),
      requestId
    );
    return res.status(400).json(envelope);
  }

  const envelope = formatErrorEnvelope(err, requestId);
  return res.status(status).json(envelope);
}
