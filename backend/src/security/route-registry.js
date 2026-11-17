import { ROLES, hasRoleAtLeast } from "./policy.js";
import { AppError } from "../errors.js";
import { getConfig } from "../config.js";
import { SessionService } from "../services/session-service.js";
import { originGuard, csrfGuard } from "./csrf.js";
import { createRateLimiterMiddleware } from "./rate-limiter.js";
import { getQuotaService } from "../services/quota-service.js";

/**
 * P3 Deny-By-Default Route Registry & Authorization Architecture
 *
 * Every API route is registered with its access specifications:
 * - public: boolean (true = no session required)
 * - minRole: role string from ROLES (if authenticated)
 * - rateLimit: { keyGenerator, maxAttempts, windowMs, errorCode, message } (optional)
 * - stateChanging: boolean (if true and authenticated, requires CSRF and Origin checks)
 * - quota: { action, getLimit(config), checkGlobalGemini?: boolean } (optional)
 */
export const ROUTE_REGISTRY = {
  // Public Health & Fallbacks
  "GET /api/health": {
    public: true,
    minRole: null,
    stateChanging: false,
  },

  // Auth Routes (Public)
  "GET /api/auth/config": {
    public: true,
    minRole: null,
    stateChanging: false,
  },
  "POST /api/auth/register": {
    public: true,
    minRole: null,
    stateChanging: true, // Covered by auth router's internal rate limiting & originGuard
  },
  "POST /api/auth/login": {
    public: true,
    minRole: null,
    stateChanging: true,
  },
  "POST /api/auth/verify-email": {
    public: true,
    minRole: null,
    stateChanging: true,
  },
  "POST /api/auth/resend-verification": {
    public: true,
    minRole: null,
    stateChanging: true,
  },
  "POST /api/auth/forgot-password": {
    public: true,
    minRole: null,
    stateChanging: true,
  },
  "POST /api/auth/reset-password": {
    public: true,
    minRole: null,
    stateChanging: true,
  },

  // Auth Routes (Authenticated)
  "GET /api/auth/me": {
    public: false,
    minRole: ROLES.VIEWER,
    stateChanging: false,
  },
  "POST /api/auth/logout": {
    public: false,
    minRole: ROLES.VIEWER,
    stateChanging: true,
  },
  "POST /api/auth/change-password": {
    public: false,
    minRole: ROLES.VIEWER,
    stateChanging: true,
  },
  "GET /api/auth/sessions": {
    public: false,
    minRole: ROLES.VIEWER,
    stateChanging: false,
  },
  "DELETE /api/auth/sessions/:id": {
    public: false,
    minRole: ROLES.VIEWER,
    stateChanging: true,
  },

  // Engineering Endpoints (Protected when AUTH_ENFORCED=true)
  "POST /api/analyze-component": {
    public: false,
    minRole: ROLES.ENGINEER,
    stateChanging: true,
    rateLimit: {
      keyGenerator: (req) => `analyze:${req.user?.id || req.ip}`,
      maxAttempts: 10,
      windowMs: 60 * 1000, // 10 req/min per user
      errorCode: "analyze_rate_limit",
      message: "Too many analyze requests. Max 10 requests per minute.",
    },
    quota: {
      action: "gemini_analyze",
      checkGlobalGemini: true,
      getLimit: (cfg) => cfg.quotas.orgDailyAnalyze,
    },
  },

  "POST /api/chat": {
    public: false,
    minRole: ROLES.ENGINEER,
    stateChanging: true,
    rateLimit: {
      keyGenerator: (req) => `chat:${req.user?.id || req.ip}`,
      maxAttempts: 20,
      windowMs: 60 * 1000, // 20 req/min per user
      errorCode: "chat_rate_limit",
      message: "Too many chat requests. Max 20 requests per minute.",
    },
    quota: {
      action: "gemini_chat",
      checkGlobalGemini: true,
      getLimit: (cfg) => cfg.quotas.orgDailyChat,
    },
  },

  "POST /api/engineering-simulate": {
    public: false,
    minRole: ROLES.ENGINEER,
    stateChanging: true,
  },

  "POST /api/engineering-sensitivity": {
    public: false,
    minRole: ROLES.ENGINEER,
    stateChanging: true,
  },

  "POST /api/manufacturing-intelligence": {
    public: false,
    minRole: ROLES.ENGINEER,
    stateChanging: true,
  },

  "POST /api/material-alternatives": {
    public: false,
    minRole: ROLES.VIEWER,
    stateChanging: true,
  },

  "POST /api/reconstruct": {
    public: false,
    minRole: ROLES.ENGINEER,
    stateChanging: true,
  },
};

/**
 * Helper to match an incoming HTTP request (method + path) to a registry entry.
 * Supports exact paths and parameter paths like /api/auth/sessions/:id
 */
export function lookupRoute(method, pathname) {
  const normalizedMethod = method.toUpperCase();
  const directKey = `${normalizedMethod} ${pathname}`;
  if (ROUTE_REGISTRY[directKey]) {
    return { key: directKey, spec: ROUTE_REGISTRY[directKey] };
  }

  // Parameter matching (e.g. /api/auth/sessions/:id)
  for (const [key, spec] of Object.entries(ROUTE_REGISTRY)) {
    const [regMethod, regPath] = key.split(" ");
    if (regMethod !== normalizedMethod) continue;

    if (regPath.includes(":")) {
      const regexStr = "^" + regPath.replace(/:[a-zA-Z0-9_]+/g, "([^/]+)") + "$";
      const regex = new RegExp(regexStr);
      if (regex.test(pathname)) {
        return { key, spec };
      }
    }
  }

  return null;
}

/**
 * Creates the central Gateway Enforcement Middleware for all /api routes.
 * Enforces:
 * 1. Deny-by-default route classification
 * 2. General API rate limiter (300 req/min per session/ip)
 * 3. Session loading & validation
 * 4. AUTH_ENFORCED flag gate
 * 5. Role check using central policy
 * 6. CSRF & Origin protection on authenticated state-changing calls
 * 7. Route-specific rate limits
 * 8. Organization daily quotas & Global Gemini kill switch
 */
export function createGatewayEnforcer({ sessionService = null, quotaService = null } = {}) {
  const sessions = sessionService || new SessionService();
  const quotas = quotaService || getQuotaService();

  // General API rate limiter: 300 req/min per session (or IP if unauthenticated)
  const generalApiLimiter = createRateLimiterMiddleware({
    keyGenerator: (req) => `api:general:${req.cookies?.[getConfig().session.cookieName] || req.ip}`,
    maxAttempts: 300,
    windowMs: 60 * 1000,
    errorCode: "general_rate_limit",
    message: "Too many requests to the API. Max 300 requests per minute.",
  });

  return async (req, res, next) => {
    const config = getConfig();
    const pathname = req.originalUrl ? req.originalUrl.split("?")[0] : req.url.split("?")[0];
    const method = req.method;

    // Apply General API rate limiter on all /api requests
    generalApiLimiter(req, res, async (err) => {
      if (err) return next(err);

      // 1. Route Registry Lookup (Deny by default)
      const match = lookupRoute(method, pathname);
      if (!match) {
        // Unknown / unclassified route -> reject immediately with not_found code
        return next(new AppError("not_found", `Endpoint not found: ${method} ${pathname}`, 404));
      }

      const { spec } = match;

      // 2. Load Session if session cookie is present
      const rawToken = req.cookies?.[config.session.cookieName];
      if (rawToken) {
        try {
          const authContext = await sessions.getSessionByRawToken(rawToken);
          req.authContext = authContext;
          if (authContext?.status === "valid") {
            req.session = authContext.session;
            req.user = authContext.user;
            req.organization = authContext.organization;
            req.role = authContext.role;
          }
        } catch (sessionErr) {
          return next(sessionErr);
        }
      }

      // If route is explicitly public, allow through
      if (spec.public) {
        return next();
      }

      // If AUTH_ENFORCED is false, bypass auth requirements (compatibility mode)
      if (!config.authEnforced) {
        return next();
      }

      // 3. Authenticated Route Enforcement (AUTH_ENFORCED=true)
      if (!req.authContext) {
        return next(new AppError("unauthenticated", "Authentication required to access this resource.", 401));
      }
      if (req.authContext.status === "expired") {
        return next(new AppError("session_expired", "Your session has expired. Please log in again.", 401));
      }
      if (req.authContext.status === "revoked" || req.authContext.status === "inactive") {
        return next(new AppError("session_revoked", "Session is no longer valid. Please log in again.", 401));
      }
      if (req.authContext.status !== "valid") {
        return next(new AppError("unauthenticated", "Authentication required.", 401));
      }

      // 4. Role Hierarchy Check
      if (spec.minRole && !hasRoleAtLeast(req.role, spec.minRole)) {
        return next(new AppError("forbidden", `Insufficient permissions. Requires role: ${spec.minRole}`, 403));
      }

      // 5. CSRF & Origin on Authenticated State-Changing Requests
      // Skip auth router sub-paths as auth-router has its own specialized handlers
      if (spec.stateChanging && !pathname.startsWith("/api/auth/")) {
        try {
          originGuard(req, res, (originErr) => {
            if (originErr) return next(originErr);
            csrfGuard(req, res, (csrfErr) => {
              if (csrfErr) return next(csrfErr);
              runRouteSpecifics();
            });
          });
        } catch (guardErr) {
          return next(guardErr);
        }
      } else {
        runRouteSpecifics();
      }

      // 6. Route-Specific Rate Limits & Quotas
      function runRouteSpecifics() {
        if (spec.rateLimit) {
          const limiter = createRateLimiterMiddleware(spec.rateLimit);
          limiter(req, res, (limiterErr) => {
            if (limiterErr) return next(limiterErr);
            applyQuotas();
          });
        } else {
          applyQuotas();
        }
      }

      async function applyQuotas() {
        if (spec.quota) {
          try {
            // Check global kill switch first if applicable
            if (spec.quota.checkGlobalGemini) {
              quotas.checkAndIncrementGlobalGemini();
            }

            // Organization-level daily counter check and increment
            const orgId = req.organization?.id;
            const limit = spec.quota.getLimit(config);
            await quotas.consumeQuota(orgId, spec.quota.action, limit);
            next();
          } catch (quotaErr) {
            next(quotaErr);
          }
        } else {
          next();
        }
      }
    });
  };
}
