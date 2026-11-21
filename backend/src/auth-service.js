import crypto from "node:crypto";
import { hashPassword, verifyPassword, generateSessionToken, hashSessionToken } from "./auth-crypto.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Finds user by username or email.
 * @param {import('better-sqlite3').Database} db
 * @param {string} identifier
 */
export function findUserByIdentifier(db, identifier) {
  if (!identifier || typeof identifier !== "string") return null;
  const clean = identifier.trim().toLowerCase();
  return db.prepare(`
    SELECT u.*, o.name as organization_name
    FROM users u
    LEFT JOIN organizations o ON u.organization_id = o.id
    WHERE LOWER(u.username) = ? OR LOWER(u.email) = ?
  `).get(clean, clean);
}

/**
 * Finds user by user ID.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function findUserById(db, userId) {
  if (!userId) return null;
  return db.prepare(`
    SELECT u.*, o.name as organization_name
    FROM users u
    LEFT JOIN organizations o ON u.organization_id = o.id
    WHERE u.id = ?
  `).get(userId);
}

/**
 * Authenticates user credentials and creates a session token.
 * @param {import('better-sqlite3').Database} db
 * @param {string} identifier
 * @param {string} password
 * @returns {Promise<{ user: object, sessionToken: string }>}
 */
export async function loginUser(db, identifier, password) {
  if (!identifier || !password) {
    const err = new Error("Username/email and password are required.");
    err.status = 400;
    throw err;
  }

  const user = findUserByIdentifier(db, identifier);
  if (!user) {
    const err = new Error("Invalid username/email or password.");
    err.status = 401;
    throw err;
  }

  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    const err = new Error("Invalid username/email or password.");
    err.status = 401;
    throw err;
  }

  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, tokenHash, user.id, expiresAt, now);

  return {
    user: toSafeProfile(user),
    sessionToken: rawToken,
  };
}

/**
 * Validates a raw session token and returns the corresponding authenticated user.
 * @param {import('better-sqlite3').Database} db
 * @param {string} rawToken
 * @returns {object|null}
 */
export function validateSession(db, rawToken) {
  if (!rawToken || typeof rawToken !== "string") return null;

  const tokenHash = hashSessionToken(rawToken);
  const now = Date.now();

  const session = db.prepare(`
    SELECT s.id as session_id, s.expires_at, u.*, o.name as organization_name
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN organizations o ON u.organization_id = o.id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, now);

  if (!session) return null;

  return toSafeProfile(session);
}

/**
 * Invalidates a session by deleting it using the raw token.
 * @param {import('better-sqlite3').Database} db
 * @param {string} rawToken
 */
export function logoutSession(db, rawToken) {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

/**
 * Converts a database user row into a safe profile object (omits hashes and secrets).
 * @param {object} userRow
 */
export function toSafeProfile(userRow) {
  if (!userRow) return null;
  return {
    id: userRow.id,
    username: userRow.username,
    email: userRow.email || null,
    displayName: userRow.display_name,
    role: userRow.role,
    organization: userRow.organization_id
      ? {
          id: userRow.organization_id,
          name: userRow.organization_name || null,
        }
      : null,
  };
}

/**
 * Generates the next collision-safe username for newly registered accounts.
 * Admins: admin-002, admin-003, ... (after default admin-001)
 * Users: user-03, user-04, ... (after default user-01, user-02)
 * @param {import('better-sqlite3').Database} db
 * @param {'admin'|'user'} role
 * @returns {string}
 */
export function generateNextUsername(db, role) {
  if (role === "admin") {
    const existing = db.prepare(`
      SELECT username FROM users WHERE username LIKE 'admin-%'
    `).all();

    let maxNum = 1; // admin-001 is seed
    for (const row of existing) {
      const match = row.username.match(/^admin-(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    }
    const nextNum = maxNum + 1;
    return `admin-${String(nextNum).padStart(3, "0")}`;
  } else {
    const existing = db.prepare(`
      SELECT username FROM users WHERE username LIKE 'user-%'
    `).all();

    let maxNum = 2; // user-01, user-02 are seeds
    for (const row of existing) {
      const match = row.username.match(/^user-(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    }
    const nextNum = maxNum + 1;
    return `user-${String(nextNum).padStart(2, "0")}`;
  }
}

/**
 * Registers a new account (either 'user' or 'admin').
 * - 'user': creates individual user (no organization, role='user')
 * - 'admin': requires orgName, creates organization and owner admin account
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @returns {Promise<{ user: object, sessionToken: string }>}
 */
export async function registerUser(db, { role = "user", displayName, email, password, orgName }) {
  if (!password || typeof password !== "string" || password.length < 6) {
    const err = new Error("Password must be at least 6 characters long.");
    err.status = 400;
    throw err;
  }

  const cleanRole = role === "admin" ? "admin" : "user";
  const cleanDisplayName = (displayName && typeof displayName === "string" ? displayName.trim() : "") ||
    (cleanRole === "admin" ? "Admin" : "User");

  let orgId = null;
  let cleanOrgName = null;

  if (cleanRole === "admin") {
    cleanOrgName = orgName && typeof orgName === "string" ? orgName.trim() : "";
    if (!cleanOrgName) {
      const err = new Error("Organization name is required when registering as an Admin.");
      err.status = 400;
      throw err;
    }

    const existingOrg = db.prepare("SELECT id FROM organizations WHERE LOWER(name) = LOWER(?)").get(cleanOrgName);
    if (existingOrg) {
      orgId = existingOrg.id;
    } else {
      orgId = crypto.randomUUID();
      db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(
        orgId,
        cleanOrgName,
        Date.now()
      );
    }
  }

  // Check email uniqueness if email provided
  const cleanEmail = email && typeof email === "string" ? email.trim().toLowerCase() : null;
  if (cleanEmail) {
    const existingEmail = db.prepare("SELECT id FROM users WHERE LOWER(email) = ?").get(cleanEmail);
    if (existingEmail) {
      const err = new Error("An account with this email already exists.");
      err.status = 409;
      throw err;
    }
  }

  const username = generateNextUsername(db, cleanRole);
  const userId = crypto.randomUUID();
  const pHash = await hashPassword(password);
  const now = Date.now();

  db.prepare(`
    INSERT INTO users (id, username, email, display_name, password_hash, role, organization_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    username,
    cleanEmail || `${username}@reforge.local`,
    cleanDisplayName,
    pHash,
    cleanRole,
    orgId,
    now
  );

  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = now + SESSION_TTL_MS;

  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, tokenHash, userId, expiresAt, now);

  const user = findUserById(db, userId);

  return {
    user: toSafeProfile(user),
    sessionToken: rawToken,
  };
}
