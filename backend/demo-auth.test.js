import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import Database from "better-sqlite3";

import { initSchema } from "./src/db.js";
import { seedDemoAccounts, DEMO_ACCOUNTS, isDemoSeedAllowed } from "./src/demo-seed.js";
import {
  loginUser,
  validateSession,
  logoutSession,
  generateNextUsername,
  registerUser,
} from "./src/auth-service.js";
import { createAuthRouter, COOKIE_NAME } from "./src/auth-routes.js";
import express from "express";
import cookieParser from "cookie-parser";

/**
 * Helper to simulate HTTP requests against an Express router/app without opening a socket.
 */
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

    const bodyChunks = [];
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

function createTestContext() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/auth", createAuthRouter(db));
  return { db, app };
}

test("1. Three demo accounts are created correctly with Argon2id hashes", async () => {
  const { db } = createTestContext();
  const res = await seedDemoAccounts(db);

  assert.equal(res.seededCount, 3);
  assert.equal(res.disabled, false);

  const users = db.prepare("SELECT * FROM users ORDER BY username ASC").all();
  assert.equal(users.length, 3);

  const admin = users.find((u) => u.username === "admin-001");
  const user1 = users.find((u) => u.username === "user-01");
  const user2 = users.find((u) => u.username === "user-02");

  assert.ok(admin);
  assert.equal(admin.role, "admin");
  assert.ok(admin.password_hash.startsWith("$argon2id$"));
  assert.ok(admin.organization_id);

  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(admin.organization_id);
  assert.equal(org.name, "Indus Valley");

  assert.ok(user1);
  assert.equal(user1.role, "user");
  assert.equal(user1.organization_id, null);
  assert.ok(user1.password_hash.startsWith("$argon2id$"));

  assert.ok(user2);
  assert.equal(user2.role, "user");
  assert.equal(user2.organization_id, null);
  assert.ok(user2.password_hash.startsWith("$argon2id$"));
});

test("2. Repeated seeding does not duplicate accounts (idempotent)", async () => {
  const { db } = createTestContext();
  const firstSeed = await seedDemoAccounts(db);
  assert.equal(firstSeed.seededCount, 3);

  const secondSeed = await seedDemoAccounts(db);
  assert.equal(secondSeed.seededCount, 0);
  assert.equal(secondSeed.skippedCount, 3);

  const userCount = db.prepare("SELECT count(*) as count FROM users").get().count;
  assert.equal(userCount, 3);
});

test("3. Admin login works via POST /api/auth/login", async () => {
  const { db, app } = createTestContext();
  await seedDemoAccounts(db);

  const res = await simulateRequest(
    app,
    { path: "/api/auth/login", method: "POST" },
    { username: "admin-001", password: "Admin123" }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.username, "admin-001");
  assert.equal(res.body.user.role, "admin");
  assert.equal(res.body.user.organization.name, "Indus Valley");
  assert.equal(res.body.user.password_hash, undefined);

  // Verify HttpOnly cookie was set
  const setCookie = res.headers["set-cookie"];
  assert.ok(setCookie);
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(cookieStr.includes(`${COOKIE_NAME}=`));
  assert.ok(cookieStr.toLowerCase().includes("httponly"));
});

test("4. Individual user login works via POST /api/auth/login", async () => {
  const { db, app } = createTestContext();
  await seedDemoAccounts(db);

  const res = await simulateRequest(
    app,
    { path: "/api/auth/login", method: "POST" },
    { username: "user-01", password: "User123" }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.username, "user-01");
  assert.equal(res.body.user.role, "user");
  assert.equal(res.body.user.organization, null);
});

test("5. Invalid password is rejected (401)", async () => {
  const { db, app } = createTestContext();
  await seedDemoAccounts(db);

  const res = await simulateRequest(
    app,
    { path: "/api/auth/login", method: "POST" },
    { username: "admin-001", password: "WrongPassword123" }
  );

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, undefined);
  assert.ok(res.body.error);
});

test("6. Unknown username is rejected (401)", async () => {
  const { db, app } = createTestContext();
  await seedDemoAccounts(db);

  const res = await simulateRequest(
    app,
    { path: "/api/auth/login", method: "POST" },
    { username: "non-existent-user", password: "SomePassword123" }
  );

  assert.equal(res.statusCode, 401);
  assert.ok(res.body.error);
});

test("7. /api/auth/me restores the session from cookie", async () => {
  const { db, app } = createTestContext();
  await seedDemoAccounts(db);

  // Login as user-02
  const loginRes = await simulateRequest(
    app,
    { path: "/api/auth/login", method: "POST" },
    { username: "user-02", password: "User123" }
  );
  assert.equal(loginRes.statusCode, 200);

  const setCookie = loginRes.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : setCookie.split(";")[0];

  // Call /api/auth/me with cookie
  const meRes = await simulateRequest(
    app,
    { path: "/api/auth/me", method: "GET" },
    null,
    cookieHeader
  );

  assert.equal(meRes.statusCode, 200);
  assert.equal(meRes.body.ok, true);
  assert.equal(meRes.body.user.username, "user-02");
  assert.equal(meRes.body.user.role, "user");
  assert.equal(meRes.body.user.organization, null);
});

test("8. Logout invalidates the session and clears cookie", async () => {
  const { db, app } = createTestContext();
  await seedDemoAccounts(db);

  const loginRes = await simulateRequest(
    app,
    { path: "/api/auth/login", method: "POST" },
    { username: "admin-001", password: "Admin123" }
  );
  const setCookie = loginRes.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0].split(";")[0] : setCookie.split(";")[0];

  // Logout
  const logoutRes = await simulateRequest(
    app,
    { path: "/api/auth/logout", method: "POST" },
    null,
    cookieHeader
  );
  assert.equal(logoutRes.statusCode, 200);
  assert.equal(logoutRes.body.ok, true);

  // Verify session removed from database
  const sessionCount = db.prepare("SELECT count(*) as count FROM sessions").get().count;
  assert.equal(sessionCount, 0);

  // Follow-up /api/auth/me returns 401
  const meRes = await simulateRequest(
    app,
    { path: "/api/auth/me", method: "GET" },
    null,
    cookieHeader
  );
  assert.equal(meRes.statusCode, 401);
});

test("9. Individual users do not have admin privileges", async () => {
  const { db } = createTestContext();
  await seedDemoAccounts(db);

  const u1 = db.prepare("SELECT * FROM users WHERE username = 'user-01'").get();
  const u2 = db.prepare("SELECT * FROM users WHERE username = 'user-02'").get();

  assert.equal(u1.role, "user");
  assert.notEqual(u1.role, "admin");
  assert.equal(u1.organization_id, null);

  assert.equal(u2.role, "user");
  assert.notEqual(u2.role, "admin");
  assert.equal(u2.organization_id, null);
});

test("10. Demo seeding is disabled in production", async () => {
  const { db } = createTestContext();

  const isAllowed = isDemoSeedAllowed({ NODE_ENV: "production" });
  assert.equal(isAllowed, false);

  const seedRes = await seedDemoAccounts(db, { NODE_ENV: "production" });
  assert.equal(seedRes.disabled, true);
  assert.equal(seedRes.seededCount, 0);

  const count = db.prepare("SELECT count(*) as count FROM users").get().count;
  assert.equal(count, 0);
});

test("11. Registration username generation and registration works", async () => {
  const { db, app } = createTestContext();
  await seedDemoAccounts(db);

  // Check next username generation
  const nextUser = generateNextUsername(db, "user");
  assert.equal(nextUser, "user-03");

  const nextAdmin = generateNextUsername(db, "admin");
  assert.equal(nextAdmin, "admin-002");

  // Register new individual user
  const regUserRes = await simulateRequest(
    app,
    { path: "/api/auth/register", method: "POST" },
    {
      role: "user",
      displayName: "Jane Doe",
      email: "jane@example.com",
      password: "SecretPassword123!",
    }
  );

  assert.equal(regUserRes.statusCode, 201);
  assert.equal(regUserRes.body.user.username, "user-03");
  assert.equal(regUserRes.body.user.role, "user");
  assert.equal(regUserRes.body.user.displayName, "Jane Doe");
  assert.equal(regUserRes.body.user.organization, null);

  // Register new admin with organization
  const regAdminRes = await simulateRequest(
    app,
    { path: "/api/auth/register", method: "POST" },
    {
      role: "admin",
      displayName: "John Admin",
      email: "john@example.com",
      password: "AdminPassword123!",
      orgName: "Bharat Precision Works",
    }
  );

  assert.equal(regAdminRes.statusCode, 201);
  assert.equal(regAdminRes.body.user.username, "admin-002");
  assert.equal(regAdminRes.body.user.role, "admin");
  assert.equal(regAdminRes.body.user.organization.name, "Bharat Precision Works");

  // Next admin should be admin-003, next user should be user-04
  assert.equal(generateNextUsername(db, "admin"), "admin-003");
  assert.equal(generateNextUsername(db, "user"), "user-04");
});
