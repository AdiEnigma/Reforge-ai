import express from "express";
import { loginUser, validateSession, logoutSession, registerUser } from "./auth-service.js";

export const COOKIE_NAME = "reforge_session";

/**
 * Cookie options helper.
 * Uses HttpOnly, SameSite=lax for standard browser navigation, and Secure in production.
 */
export function getCookieOptions(env = process.env) {
  const isProd = env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    path: "/",
  };
}

/**
 * Creates authentication router.
 * @param {import('better-sqlite3').Database} db
 * @returns {express.Router}
 */
export function createAuthRouter(db) {
  const router = express.Router();

  /**
   * POST /api/auth/login
   * Body: { username, password } or { identifier, password }
   */
  router.post("/login", async (req, res) => {
    try {
      const identifier = req.body?.username || req.body?.identifier || req.body?.email;
      const password = req.body?.password;

      if (!identifier || !password) {
        return res.status(400).json({ error: "Username/email and password are required." });
      }

      const { user, sessionToken } = await loginUser(db, identifier, password);

      res.cookie(COOKIE_NAME, sessionToken, getCookieOptions());
      return res.json({
        ok: true,
        user,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Login failed." });
    }
  });

  /**
   * GET /api/auth/me
   * Validates active session cookie and returns current user's profile.
   */
  router.get("/me", (req, res) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (!token) {
        return res.status(401).json({ error: "No active session." });
      }

      const user = validateSession(db, token);
      if (!user) {
        res.clearCookie(COOKIE_NAME, { path: "/" });
        return res.status(401).json({ error: "Session expired or invalid." });
      }

      return res.json({
        ok: true,
        user,
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to validate session." });
    }
  });

  /**
   * POST /api/auth/logout
   * Invalidates the active session and clears the cookie.
   */
  router.post("/logout", (req, res) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (token) {
        logoutSession(db, token);
      }
      res.clearCookie(COOKIE_NAME, { path: "/" });
      return res.json({ ok: true, message: "Logged out successfully." });
    } catch (err) {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      return res.status(500).json({ error: "Logout failed." });
    }
  });

  /**
   * POST /api/auth/register
   * Body: { role: 'user'|'admin', displayName, email, password, orgName }
   */
  router.post("/register", async (req, res) => {
    try {
      const { role, displayName, email, password, orgName } = req.body || {};

      const { user, sessionToken } = await registerUser(db, {
        role,
        displayName,
        email,
        password,
        orgName,
      });

      res.cookie(COOKIE_NAME, sessionToken, getCookieOptions());
      return res.status(201).json({
        ok: true,
        user,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || "Registration failed." });
    }
  });

  return router;
}
