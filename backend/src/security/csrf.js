import { AppError } from "../errors.js";
import { getConfig } from "../config.js";
import { verifyCsrfToken } from "./passwords.js";

/**
 * Validates Origin and Sec-Fetch-Site for non-GET/HEAD/OPTIONS requests.
 */
export function originGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const config = getConfig();
  const origin = req.headers["origin"];
  const secFetchSite = req.headers["sec-fetch-site"];

  if (origin) {
    // Must match APP_ORIGIN or one of the configured CORS origins
    const allowed = [config.appOrigin, ...config.corsAllowedOrigins];
    if (!allowed.includes(origin)) {
      return next(new AppError("forbidden_origin", `Origin ${origin} is not allowed.`, 403));
    }
  } else if (secFetchSite) {
    if (secFetchSite !== "same-origin" && secFetchSite !== "same-site") {
      return next(new AppError("forbidden_cross_site", "Cross-site request rejected.", 403));
    }
  }

  next();
}

/**
 * Validates CSRF token for state-changing requests that use cookie sessions.
 * Compares X-RF-CSRF header against HMAC(CSRF_SECRET, sessionId) in constant time.
 */
export function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // If request has no session established on req.session, CSRF is not applicable
  // (e.g. initial public login, register, password reset using token)
  if (!req.session || !req.session.id) {
    return next();
  }

  const config = getConfig();
  const providedCsrf = req.headers["x-rf-csrf"];

  if (!providedCsrf || !verifyCsrfToken(config.csrfSecret, req.session.id, providedCsrf)) {
    return next(new AppError("invalid_csrf_token", "Invalid or missing CSRF token.", 403));
  }

  next();
}
