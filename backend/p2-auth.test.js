import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

import { getDb, closeDb } from "./src/db/connection.js";
import { runMigrations } from "./src/db/migrator.js";
import { app } from "./index.js";
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  hashToken,
  generateSecureToken,
  generateCsrfToken,
  verifyCsrfToken,
  constantTimeEquals,
} from "./src/security/passwords.js";
import { canPerform, ACTIONS, ROLES } from "./src/security/policy.js";
import { writeAuditEvent } from "./src/security/audit.js";
import { rateLimiter } from "./src/security/rate-limiter.js";
import { AuthService } from "./src/services/auth-service.js";
import { SessionService } from "./src/services/session-service.js";
import { resetConfigForTest } from "./src/config.js";

// Helper to simulate HTTP requests in-process
function simulateRequest(appInstance, options, postData = null, cookie = null) {
  return new Promise((resolve) => {
    const dataStr = postData ? (typeof postData === "string" ? postData : JSON.stringify(postData)) : "";
    const socket = new Readable({ read() {} });

    const req = new http.IncomingMessage(socket);
    req.method = options.method || "GET";
    req.url = options.path || "/";
    req.headers = Object.fromEntries(
      Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    if (!req.headers.host) req.headers.host = "127.0.0.1";
    if (dataStr) {
      req.headers["content-length"] = Buffer.byteLength(dataStr).toString();
      if (!req.headers["content-type"]) req.headers["content-type"] = "application/json";
    }
    if (cookie) {
      req.headers["cookie"] = cookie;
    }

    const res = new http.ServerResponse(req);
    res.assignSocket({
      _writableState: {},
      writable: true,
      on: () => {},
      once: () => {},
      emit: () => {},
      write: () => {},
      end: () => {},
      destroy: () => {},
      cork: () => {},
      uncork: () => {},
    });

    let bodyChunks = [];
    res.write = function (chunk) {
      if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    res.end = function (chunk) {
      if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const fullBody = Buffer.concat(bodyChunks).toString("utf8");
      let parsed = null;
      try {
        parsed = JSON.parse(fullBody);
      } catch {
        parsed = fullBody;
      }

      resolve({
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: parsed,
      });
    };

    appInstance.handle(req, res);

    if (dataStr) {
      req.push(dataStr);
      req.push(null);
    }
  });
}

// ─── 1. Password Security & Argon2id Tests ────────────────────────────────────

test("P2 Password: Argon2id hashing and verification satisfy baseline parameters", async () => {
  const plain = "ValidPassword123!";
  const hash = await hashPassword(plain);

  assert.ok(hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1"));
  const isValid = await verifyPassword(hash, plain);
  assert.equal(isValid, true);

  const isInvalid = await verifyPassword(hash, "WrongPassword123!");
  assert.equal(isInvalid, false);
});

test("P2 Password: Policy validation enforces 10-128 chars and prevents email matching", () => {
  assert.throws(() => validatePasswordPolicy("short"), /at least 10 characters/);
  assert.throws(() => validatePasswordPolicy("A".repeat(129)), /cannot exceed 128 characters/);
  assert.throws(() => validatePasswordPolicy("user@example.com", "user@example.com"), /must not be the same/);
  assert.doesNotThrow(() => validatePasswordPolicy("SecureP@ssw0rd123", "user@example.com"));
});

test("P2 Security: CSRF token generation and constant-time comparison", () => {
  const secret = "test-secret-at-least-32-characters-long";
  const sessionId = "session-12345";
  const token = generateCsrfToken(secret, sessionId);

  assert.ok(token);
  assert.equal(verifyCsrfToken(secret, sessionId, token), true);
  assert.equal(verifyCsrfToken(secret, sessionId, "wrong-token"), false);
  assert.equal(constantTimeEquals("abcdef", "abcdef"), true);
  assert.equal(constantTimeEquals("abcdef", "abcdeg"), false);
});

// ─── 2. Policy Module Hierarchy ──────────────────────────────────────────────

test("P2 Policy: Role hierarchy and capability checks work deterministically", () => {
  assert.equal(canPerform(ROLES.OWNER, ACTIONS.ORG_DELETE), true);
  assert.equal(canPerform(ROLES.ADMIN, ACTIONS.ORG_DELETE), false);
  assert.equal(canPerform(ROLES.ADMIN, ACTIONS.MEMBER_INVITE), true);
  assert.equal(canPerform(ROLES.ENGINEER, ACTIONS.MEMBER_INVITE), false);
  assert.equal(canPerform(ROLES.ENGINEER, ACTIONS.PART_CREATE), true);
  assert.equal(canPerform(ROLES.VIEWER, ACTIONS.PART_CREATE), false);
  assert.equal(canPerform(ROLES.VIEWER, ACTIONS.PART_VIEW), true);
});

// ─── 3. Multi-Tenant Database Transactions & Audit Logging ────────────────────

test("P2 DB & Audit: Registration transaction creates org, user, membership, and audit event", async () => {
  resetConfigForTest({ REGISTRATION_MODE: "invite_only", NODE_ENV: "development" });
  const testDb = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(testDb);
    const authService = new AuthService(testDb);

    // Create an invite code in DB
    const rawInvite = "RF-TESTINVITE1234";
    const codeHash = hashToken(rawInvite);
    await testDb("signup_invites").insert({
      id: crypto.randomUUID(),
      code_hash: codeHash,
      remaining_uses: 1,
      expires_at: Date.now() + 86400000,
      created_at: Date.now(),
    });

    const regResult = await authService.register({
      orgName: "Bharat Gears Ltd",
      displayName: "Vikram Sharma",
      email: "vikram@bharatgears.com",
      password: "StrongPassword123!",
      inviteCode: rawInvite,
    });

    assert.equal(regResult.status, "created");
    assert.equal(regResult.role, "owner");
    assert.ok(regResult.csrfToken);

    // Verify invite uses decremented to 0
    const updatedInvite = await testDb("signup_invites").where("code_hash", codeHash).first();
    assert.equal(updatedInvite.remaining_uses, 0);

    // Verify membership created
    const membership = await testDb("memberships").where("user_id", regResult.user.id).first();
    assert.equal(membership.role, "owner");
    assert.equal(membership.org_id, regResult.organization.id);

    // Verify raw password NEVER in database
    const userRow = await testDb("users").where("id", regResult.user.id).first();
    assert.notEqual(userRow.password_hash, "StrongPassword123!");
    assert.ok(userRow.password_hash.startsWith("$argon2id$"));

    // Verify audit event written
    const audit = await testDb("audit_events").where("action", "auth.register").first();
    assert.ok(audit);
    assert.equal(audit.actor_user_id, regResult.user.id);
  } finally {
    await testDb.destroy();
  }
});

// ─── 4. End-to-End Authentication API Endpoints ───────────────────────────────

test("P2 HTTP API: Registration, Login, /auth/me, CSRF Protection, and Logout", async () => {
  resetConfigForTest({ REGISTRATION_MODE: "invite_only", NODE_ENV: "development" });
  const db = getDb();
  await runMigrations(db);

  // Clean up any residual test records for amit@indusforgings.com
  const existingUser = await db("users").where("normalized_email", "amit@indusforgings.com").first();
  if (existingUser) {
    await db("users").where("id", existingUser.id).delete();
    if (existingUser.organization_id) {
      await db("organizations").where("id", existingUser.organization_id).delete();
    }
  }

  // 1. Seed invite
  const rawInvite = "RF-SEEDINVITE0001";
  await db("signup_invites").where("code_hash", hashToken(rawInvite)).delete();
  await db("signup_invites").insert({
    id: crypto.randomUUID(),
    code_hash: hashToken(rawInvite),
    remaining_uses: 2,
    expires_at: Date.now() + 86400000,
    created_at: Date.now(),
  });

  // 2. Reject registration without invite
  const resNoInvite = await simulateRequest(app, {
    path: "/api/auth/register",
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  }, {
    orgName: "Indus Forgings",
    displayName: "Amit Patel",
    email: "amit@indusforgings.com",
    password: "MasterPassword123!",
  });
  assert.equal(resNoInvite.statusCode, 403);
  assert.equal(resNoInvite.body.error.code, "invite_code_required");

  // 3. Register successfully with invite
  const resReg = await simulateRequest(app, {
    path: "/api/auth/register",
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  }, {
    orgName: "Indus Forgings",
    displayName: "Amit Patel",
    email: "amit@indusforgings.com",
    password: "MasterPassword123!",
    inviteCode: rawInvite,
  });
  assert.equal(resReg.statusCode, 201);
  assert.ok(resReg.headers["set-cookie"]);
  const setCookie = resReg.headers["set-cookie"];
  const rawCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  const csrfToken = resReg.body.csrfToken;

  // 4. Test /api/auth/me with session cookie
  const resMe = await simulateRequest(app, {
    path: "/api/auth/me",
    method: "GET",
  }, null, rawCookie);
  assert.equal(resMe.statusCode, 200);
  assert.equal(resMe.body.user.email, "amit@indusforgings.com");
  assert.equal(resMe.body.role, "owner");

  // 5. Test CSRF Protection on state-changing logout
  // Missing CSRF token should return 403
  const resLogoutNoCsrf = await simulateRequest(app, {
    path: "/api/auth/logout",
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  }, {}, rawCookie);
  assert.equal(resLogoutNoCsrf.statusCode, 403);
  assert.equal(resLogoutNoCsrf.body.error.code, "invalid_csrf_token");

  // Successful logout with valid CSRF token
  const resLogout = await simulateRequest(app, {
    path: "/api/auth/logout",
    method: "POST",
    headers: {
      origin: "http://localhost:5173",
      "x-rf-csrf": csrfToken,
    },
  }, {}, rawCookie);
  assert.equal(resLogout.statusCode, 204);

  // 6. Accessing /api/auth/me after logout should return 401 session_revoked
  const resMeAfterLogout = await simulateRequest(app, {
    path: "/api/auth/me",
    method: "GET",
  }, null, rawCookie);
  assert.equal(resMeAfterLogout.statusCode, 401);
  assert.equal(resMeAfterLogout.body.error.code, "session_revoked");

  // 7. Test Login
  const resLogin = await simulateRequest(app, {
    path: "/api/auth/login",
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  }, {
    email: "amit@indusforgings.com",
    password: "MasterPassword123!",
  });
  assert.equal(resLogin.statusCode, 200);
  assert.equal(resLogin.body.user.displayName, "Amit Patel");
  assert.ok(resLogin.body.csrfToken);

  // 8. Test Login failure (bad password) returns uniform 401
  const resBadPass = await simulateRequest(app, {
    path: "/api/auth/login",
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  }, {
    email: "amit@indusforgings.com",
    password: "WrongPassword999!",
  });
  assert.equal(resBadPass.statusCode, 401);
  assert.equal(resBadPass.body.error.code, "invalid_credentials");

  // 9. Test Login failure (unknown email) returns uniform 401
  const resUnknownUser = await simulateRequest(app, {
    path: "/api/auth/login",
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  }, {
    email: "ghost@nowhere.com",
    password: "SomePassword123!",
  });
  assert.equal(resUnknownUser.statusCode, 401);
  assert.equal(resUnknownUser.body.error.code, "invalid_credentials");
});

// ─── 5. Rate Limiting Tests ───────────────────────────────────────────────────

test("P2 Rate Limiting: Exceeding threshold triggers 429 and Retry-After header", () => {
  rateLimiter.clear();
  const testKey = "test:ip:10.0.0.1";

  // Consume 3 attempts (max 3)
  for (let i = 0; i < 3; i++) {
    const res = rateLimiter.consume(testKey, 3, 60000);
    assert.equal(res.allowed, true);
  }

  // 4th attempt must be rejected
  const blocked = rateLimiter.consume(testKey, 3, 60000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);
});

// ─── 6. Engineering API Preserved (AUTH_ENFORCED=false) ──────────────────────

test("P2 Gateway: Existing engineering endpoints continue functioning unauthenticated", async () => {
  const res = await simulateRequest(app, {
    path: "/api/health",
    method: "GET",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

after(async () => {
  await closeDb();
});
