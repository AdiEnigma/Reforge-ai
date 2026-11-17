import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

import { getDb, closeDb } from "./src/db/connection.js";
import { runMigrations } from "./src/db/migrator.js";
import { app } from "./index.js";
import { resetConfigForTest, getConfig } from "./src/config.js";
import { hashToken } from "./src/security/passwords.js";
import { ROLES } from "./src/security/policy.js";
import { ROUTE_REGISTRY, lookupRoute } from "./src/security/route-registry.js";
import { getQuotaService } from "./src/services/quota-service.js";

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

// ─── 1. Route Registry Complete Inventory & Deny-by-Default ───────────────────

test("P3 Route Registry: Every route is explicitly classified and unclassified returns 404", async () => {
  assert.ok(ROUTE_REGISTRY["GET /api/health"]);
  assert.ok(ROUTE_REGISTRY["POST /api/analyze-component"]);
  assert.ok(ROUTE_REGISTRY["POST /api/chat"]);
  assert.ok(ROUTE_REGISTRY["POST /api/auth/register"]);
  assert.ok(ROUTE_REGISTRY["POST /api/auth/login"]);
  assert.ok(ROUTE_REGISTRY["GET /api/auth/me"]);

  // Lookup existing
  const found = lookupRoute("GET", "/api/health");
  assert.ok(found);
  assert.equal(found.spec.public, true);

  // Lookup unknown / unclassified
  const unknown = lookupRoute("GET", "/api/non-existent-secret-endpoint");
  assert.equal(unknown, null);

  const resUnknown = await simulateRequest(app, {
    path: "/api/non-existent-secret-endpoint",
    method: "GET",
  });
  assert.equal(resUnknown.statusCode, 404);
  assert.equal(resUnknown.body.error.code, "not_found");
});

// ─── 2. AUTH_ENFORCED Flag Controls ───────────────────────────────────────────

test("P3 Route Enforcement: AUTH_ENFORCED=false allows engineering access unauthenticated", async () => {
  resetConfigForTest({ ...process.env, AUTH_ENFORCED: "false" });

  const res = await simulateRequest(app, {
    path: "/api/reconstruct",
    method: "POST",
    headers: { "content-type": "application/json" },
  }, {});

  assert.equal(res.statusCode, 200);
});

test("P3 Route Enforcement: AUTH_ENFORCED=true rejects protected engineering routes without session (401)", async () => {
  resetConfigForTest({ ...process.env, AUTH_ENFORCED: "true" });

  try {
    const res = await simulateRequest(app, {
      path: "/api/reconstruct",
      method: "POST",
      headers: { "content-type": "application/json" },
    }, {});

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, "unauthenticated");

    // Public /api/health still succeeds
    const resHealth = await simulateRequest(app, {
      path: "/api/health",
      method: "GET",
    });
    assert.equal(resHealth.statusCode, 200);
  } finally {
    resetConfigForTest({ ...process.env, AUTH_ENFORCED: "false" });
  }
});

// ─── 3. Role Hierarchy & CSRF Enforcement when AUTH_ENFORCED=true ─────────────

test("P3 Role & CSRF: Enforces minimum role and rejects missing CSRF on state-changing engineering routes", async () => {
  const db = getDb();
  await runMigrations(db);

  // Setup viewer user
  const orgId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const rawSession = crypto.randomBytes(32).toString("base64url");
  const sessionHash = hashToken(rawSession);
  const now = Date.now();

  await db("organizations").insert({ id: orgId, name: "Viewer Org", slug: `viewer-org-${Date.now()}`, created_at: now, updated_at: now });
  await db("users").insert({
    id: userId, organization_id: orgId, email: `viewer-${Date.now()}@example.com`,
    password_hash: "hash", role: ROLES.VIEWER, is_active: true, created_at: now, updated_at: now,
  });
  await db("memberships").insert({ org_id: orgId, user_id: userId, role: ROLES.VIEWER, status: "active", created_at: now, updated_at: now });
  await db("sessions").insert({
    id: crypto.randomUUID(), token_hash: sessionHash, user_id: userId, active_org_id: orgId,
    created_at: now, last_seen_at: now, idle_expires_at: now + 3600000, absolute_expires_at: now + 86400000,
  });

  resetConfigForTest({ ...process.env, AUTH_ENFORCED: "true" });

  try {
    const cookie = `rf_sid=${rawSession}`;

    // 1. Viewer trying to access POST /api/analyze-component (requires ENGINEER) -> 403 forbidden
    const resForbidden = await simulateRequest(app, {
      path: "/api/analyze-component",
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
    }, { images: [] }, cookie);

    assert.equal(resForbidden.statusCode, 403);
    assert.equal(resForbidden.body.error.code, "forbidden");

    // 2. Upgrade membership to ENGINEER
    await db("memberships").where({ org_id: orgId, user_id: userId }).update({ role: ROLES.ENGINEER });

    // 3. Request without CSRF token on state-changing endpoint -> 403 invalid_csrf_token
    const resNoCsrf = await simulateRequest(app, {
      path: "/api/engineering-simulate",
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
    }, {
      dimensions: { length: 100, outerDiameter: 50, boreDiameter: 25 },
      quantity: 50,
      material: "mild_steel",
    }, cookie);

    assert.equal(resNoCsrf.statusCode, 403);
    assert.equal(resNoCsrf.body.error.code, "invalid_csrf_token");
  } finally {
    resetConfigForTest({ ...process.env, AUTH_ENFORCED: "false" });
  }
});

// ─── 4. Daily Organization Quota Counters & Global Kill Switch ────────────────

test("P3 Quotas: Organization daily quota and global Gemini kill switch enforce limits atomically", async () => {
  const db = getDb();
  await runMigrations(db);
  const quotaService = getQuotaService(db);
  const orgId = crypto.randomUUID();
  const now = Date.now();

  await db("organizations").insert({
    id: orgId,
    name: "Quota Test Org",
    slug: `quota-org-${now}`,
    created_at: now,
    updated_at: now,
  });

  // Test consumption up to limit 2
  const r1 = await quotaService.consumeQuota(orgId, "gemini_analyze", 2);
  assert.equal(r1.used, 1);
  assert.equal(r1.remaining, 1);

  const r2 = await quotaService.consumeQuota(orgId, "gemini_analyze", 2);
  assert.equal(r2.used, 2);
  assert.equal(r2.remaining, 0);

  // 3rd request must throw 429 quota_exceeded
  await assert.rejects(
    async () => {
      await quotaService.consumeQuota(orgId, "gemini_analyze", 2);
    },
    (err) => err.status === 429 && err.code === "quota_exceeded"
  );

  // Global kill switch test
  quotaService.resetGlobalCounters();
  quotaService.checkAndIncrementGlobalGemini(2); // Call 1
  quotaService.checkAndIncrementGlobalGemini(2); // Call 2

  // Call 3 exceeds global limit -> throws 503 capacity_exceeded
  assert.throws(
    () => quotaService.checkAndIncrementGlobalGemini(2),
    (err) => err.status === 503 && err.code === "capacity_exceeded"
  );
});

// ─── 5. Tenant Isolation Verification ─────────────────────────────────────────

test("P3 Tenant Isolation: Organization context strictly derived from session, not client input", async () => {
  const db = getDb();
  await runMigrations(db);

  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const userA = crypto.randomUUID();
  const rawSessionA = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();

  await db("organizations").insert({ id: orgA, name: "Org Alpha", slug: `alpha-${Date.now()}`, created_at: now, updated_at: now });
  await db("organizations").insert({ id: orgB, name: "Org Beta", slug: `beta-${Date.now()}`, created_at: now, updated_at: now });
  await db("users").insert({ id: userA, organization_id: orgA, email: `a-${Date.now()}@alpha.com`, password_hash: "hash", role: ROLES.ENGINEER, is_active: true, created_at: now, updated_at: now });
  await db("memberships").insert({ org_id: orgA, user_id: userA, role: ROLES.ENGINEER, status: "active", created_at: now, updated_at: now });
  await db("sessions").insert({
    id: crypto.randomUUID(), token_hash: hashToken(rawSessionA), user_id: userA, active_org_id: orgA,
    created_at: now, last_seen_at: now, idle_expires_at: now + 3600000, absolute_expires_at: now + 86400000,
  });

  resetConfigForTest({ ...process.env, AUTH_ENFORCED: "true" });

  try {
    // Calling /api/auth/me returns orgA, even if caller sends forged headers or bodies attempting to claim orgB
    const res = await simulateRequest(app, {
      path: "/api/auth/me",
      method: "GET",
      headers: {
        "x-org-id": orgB,
      },
    }, null, `rf_sid=${rawSessionA}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.organization.id, orgA);
    assert.notEqual(res.body.organization.id, orgB);
  } finally {
    resetConfigForTest({ ...process.env, AUTH_ENFORCED: "false" });
  }
});

after(async () => {
  await closeDb();
});
