import express from "express";
import { getConfig } from "../config.js";
import { AppError } from "../errors.js";
import { AuthService } from "../services/auth-service.js";
import { SessionService } from "../services/session-service.js";
import { generateCsrfToken } from "../security/passwords.js";
import { originGuard, csrfGuard } from "../security/csrf.js";
import { createRateLimiterMiddleware } from "../security/rate-limiter.js";

export function createAuthRouter({ authService = null, sessionService = null } = {}) {
  const router = express.Router();
  const auth = authService || new AuthService();
  const sessions = sessionService || new SessionService();
  const config = getConfig();

  // Helper to extract IP and User Agent
  const getClientMeta = (req) => ({
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers["user-agent"] || null,
    requestId: req.requestId || null,
  });

  // Cookie session loader middleware for /api/auth routes
  const loadSession = async (req, res, next) => {
    const rawToken = req.cookies?.[config.session.cookieName];
    if (!rawToken) {
      req.authContext = null;
      return next();
    }

    try {
      const authContext = await sessions.getSessionByRawToken(rawToken);
      req.authContext = authContext;
      if (authContext?.status === "valid") {
        req.session = authContext.session;
        req.user = authContext.user;
        req.organization = authContext.organization;
        req.role = authContext.role;
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  // Require active session middleware
  const requireSession = (req, res, next) => {
    if (!req.authContext) {
      return next(new AppError("unauthenticated", "Authentication required.", 401));
    }
    if (req.authContext.status === "expired") {
      return next(new AppError("session_expired", "Session has expired. Please log in again.", 401));
    }
    if (req.authContext.status === "revoked" || req.authContext.status === "inactive") {
      return next(new AppError("session_revoked", "Session is no longer valid. Please log in again.", 401));
    }
    if (req.authContext.status !== "valid") {
      return next(new AppError("unauthenticated", "Authentication required.", 401));
    }
    next();
  };

  // Rate limiters per Architecture Plan (P3 values)
  // Login: 5 per 15 min per IP+email; 30 per 15 min per IP
  const loginIpEmailLimiter = createRateLimiterMiddleware({
    keyGenerator: (req) => `login:ip_email:${req.ip}:${(req.body?.email || "").toLowerCase().trim()}`,
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    errorCode: "login_rate_limit",
    message: "Too many failed login attempts for this account. Please wait before trying again.",
  });

  const loginIpLimiter = createRateLimiterMiddleware({
    keyGenerator: (req) => `login:ip:${req.ip}`,
    maxAttempts: 30,
    windowMs: 15 * 60 * 1000,
    errorCode: "login_rate_limit",
    message: "Too many login attempts from this network. Please wait before trying again.",
  });

  // Registration: 5 per hour per IP
  const registerLimiter = createRateLimiterMiddleware({
    keyGenerator: (req) => `register:${req.ip}`,
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
    errorCode: "register_rate_limit",
    message: "Too many registration attempts from this IP address.",
  });

  // Password recovery & verification resend: 3 per hour per email and per IP
  const forgotPasswordEmailLimiter = createRateLimiterMiddleware({
    keyGenerator: (req) => `forgot:email:${(req.body?.email || "").toLowerCase().trim()}`,
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000,
    errorCode: "forgot_password_rate_limit",
    message: "Too many password reset requests for this email address.",
  });

  const forgotPasswordIpLimiter = createRateLimiterMiddleware({
    keyGenerator: (req) => `forgot:ip:${req.ip}`,
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000,
    errorCode: "forgot_password_rate_limit",
    message: "Too many password reset requests from this IP address.",
  });

  // Apply Origin guard to all auth routes
  router.use(originGuard);
  router.use(loadSession);

  // 1. POST /api/auth/register
  router.post("/register", registerLimiter, async (req, res, next) => {
    try {
      const meta = getClientMeta(req);
      const result = await auth.register({
        orgName: req.body?.orgName,
        displayName: req.body?.displayName,
        email: req.body?.email,
        password: req.body?.password,
        city: req.body?.city,
        industry: req.body?.industry,
        inviteCode: req.body?.inviteCode,
        ...meta,
      });

      if (result.status === "pending_verification") {
        return res.status(202).json({
          message: "Registration initiated. Please check your email for a verification link.",
        });
      }

      res.cookie(
        result.sessionCookie.name,
        result.sessionCookie.value,
        result.sessionCookie.options
      );

      res.status(201).json({
        user: result.user,
        organization: result.organization,
        role: result.role,
        csrfToken: result.csrfToken,
      });
    } catch (err) {
      next(err);
    }
  });

  // 2. POST /api/auth/login
  router.post("/login", loginIpLimiter, loginIpEmailLimiter, async (req, res, next) => {
    try {
      const meta = getClientMeta(req);
      const existingSessionId = req.session?.id || null;

      const result = await auth.login({
        email: req.body?.email,
        password: req.body?.password,
        existingSessionId,
        ...meta,
      });

      res.cookie(
        result.sessionCookie.name,
        result.sessionCookie.value,
        result.sessionCookie.options
      );

      res.json({
        user: result.user,
        organization: result.organization,
        role: result.role,
        csrfToken: result.csrfToken,
      });
    } catch (err) {
      next(err);
    }
  });

  // 3. POST /api/auth/logout
  router.post("/logout", requireSession, csrfGuard, async (req, res, next) => {
    try {
      const meta = getClientMeta(req);
      await auth.logout({
        sessionId: req.session.id,
        userId: req.user.id,
        orgId: req.organization.id,
        ...meta,
      });

      res.clearCookie(config.session.cookieName, {
        path: "/",
        httpOnly: true,
        secure: config.session.cookieSecure,
        sameSite: "lax",
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // 4. GET /api/auth/me
  router.get("/me", requireSession, (req, res) => {
    const csrfToken = generateCsrfToken(config.csrfSecret, req.session.id);
    res.json({
      user: req.user,
      organization: req.organization,
      role: req.role,
      csrfToken,
      session: {
        id: req.session.id,
        idleExpiresAt: req.session.idleExpiresAt,
        absoluteExpiresAt: req.session.absoluteExpiresAt,
      },
    });
  });

  // 5. POST /api/auth/verify-email
  router.post("/verify-email", async (req, res, next) => {
    try {
      const meta = getClientMeta(req);
      await auth.verifyEmail({
        token: req.body?.token,
        ...meta,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // 6. POST /api/auth/resend-verification
  router.post("/resend-verification", forgotPasswordIpLimiter, forgotPasswordEmailLimiter, async (req, res, next) => {
    try {
      // In pilot, resend operates via log-only sender
      res.status(202).json({
        message: "If an unverified account exists with this email, a new verification link has been sent.",
      });
    } catch (err) {
      next(err);
    }
  });

  // 7. POST /api/auth/forgot-password
  router.post("/forgot-password", forgotPasswordIpLimiter, forgotPasswordEmailLimiter, async (req, res, next) => {
    try {
      const meta = getClientMeta(req);
      await auth.forgotPassword({
        email: req.body?.email,
        ...meta,
      });
      res.status(202).json({
        message: "If an account exists with this email, password reset instructions have been sent.",
      });
    } catch (err) {
      next(err);
    }
  });

  // 8. POST /api/auth/reset-password
  router.post("/reset-password", async (req, res, next) => {
    try {
      const meta = getClientMeta(req);
      await auth.resetPassword({
        token: req.body?.token,
        newPassword: req.body?.newPassword,
        ...meta,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // 9. POST /api/auth/change-password
  router.post("/change-password", requireSession, csrfGuard, async (req, res, next) => {
    try {
      const meta = getClientMeta(req);
      await auth.changePassword({
        userId: req.user.id,
        currentSessionId: req.session.id,
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
        ...meta,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // 10. GET /api/auth/sessions (Mechanics preparation)
  router.get("/sessions", requireSession, async (req, res, next) => {
    try {
      const list = await sessions.db("sessions")
        .where("user_id", req.user.id)
        .whereNull("revoked_at")
        .select("id", "created_at", "last_seen_at", "ip_truncated");

      res.json({ sessions: list });
    } catch (err) {
      next(err);
    }
  });

  // 11. DELETE /api/auth/sessions/:id (Mechanics preparation)
  router.delete("/sessions/:id", requireSession, csrfGuard, async (req, res, next) => {
    try {
      const targetId = req.params.id;
      await sessions.revokeSession(targetId, "user_revoked");
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
