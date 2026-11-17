import test from "node:test";
import assert from "node:assert/strict";
import { validateEnv, resetConfigForTest } from "./src/config.js";
import { formatErrorEnvelope, AppError, requestIdMiddleware, centralErrorHandler } from "./src/errors.js";
import { getDb, configureSqlitePragmas, assertDatabaseConnection, checkForeignKeys, closeDb } from "./src/db/connection.js";
import { runMigrations, rollbackMigrations } from "./src/db/migrator.js";
import { OrganizationRepository } from "./src/repositories/organization-repository.js";
import { ProjectRepository } from "./src/repositories/project-repository.js";
import { PartRepository } from "./src/repositories/part-repository.js";
import { AssetStore } from "./src/storage/asset-store.js";
import { app } from "./index.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";

// ─── 1. Environment & Config Tests ──────────────────────────────────────────

test("validateEnv: defaults AUTH_ENFORCED to false and parses valid config", () => {
  const env = {
    PORT: "9000",
    AUTH_ENFORCED: "false",
    CORS_ALLOWED_ORIGINS: "http://localhost:5173,http://localhost:3000",
  };
  const config = validateEnv(env);
  assert.equal(config.port, 9000);
  assert.equal(config.authEnforced, false);
  assert.equal(config.registrationMode, "open"); // Default in development
  assert.deepEqual(config.corsAllowedOrigins, ["http://localhost:5173", "http://localhost:3000"]);
});

test("validateEnv: rejects invalid port numbers", () => {
  assert.throws(
    () => validateEnv({ PORT: "-1" }),
    /Configuration validation failed/
  );
});

// ─── 2. Request ID & Error Envelope Tests ───────────────────────────────────

test("requestIdMiddleware: assigns valid UUID when none provided", () => {
  const req = { headers: {} };
  let headerSet = {};
  const res = {
    setHeader: (k, v) => { headerSet[k] = v; }
  };
  requestIdMiddleware(req, res, () => {});
  assert.ok(req.requestId);
  assert.match(req.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(headerSet["X-Request-Id"], req.requestId);
});

test("requestIdMiddleware: preserves safe incoming X-Request-Id", () => {
  const req = { headers: { "x-request-id": "client-req-12345" } };
  let headerSet = {};
  const res = {
    setHeader: (k, v) => { headerSet[k] = v; }
  };
  requestIdMiddleware(req, res, () => {});
  assert.equal(req.requestId, "client-req-12345");
  assert.equal(headerSet["X-Request-Id"], "client-req-12345");
});

test("formatErrorEnvelope: returns standard P1 envelope shape without leaking stack", () => {
  const err = new AppError("test_code", "Safe message for user", 400, { field: "test" });
  const envelope = formatErrorEnvelope(err, "req-123");
  assert.deepEqual(envelope, {
    error: {
      code: "test_code",
      message: "Safe message for user",
      requestId: "req-123",
      details: { field: "test" },
    },
  });
});

test("formatErrorEnvelope: masks internal 500 error messages", () => {
  const err = new Error("Database connection password leaked in raw error");
  err.status = 500;
  const envelope = formatErrorEnvelope(err, "req-456");
  assert.equal(envelope.error.code, "internal_error");
  assert.equal(envelope.error.message, "An unexpected internal server error occurred.");
  assert.equal(envelope.error.requestId, "req-456");
});

// ─── 3. Database Connection, PRAGMAs & Migrations ───────────────────────────

test("SQLite connection factory: applies WAL, foreign_keys=ON and passes assertion", async () => {
  const testDb = getDb({ dbPath: ":memory:" });
  try {
    const status = await assertDatabaseConnection(testDb);
    assert.equal(status.ok, true);
    assert.equal(Number(status.foreignKeys), 1);
  } finally {
    await testDb.destroy();
  }
});

test("Migrations: up and down (rollback) work deterministically", async () => {
  const testDb = getDb({ dbPath: ":memory:" });
  try {
    // Up
    const upResult = await runMigrations(testDb);
    assert.ok(upResult.batchNo >= 1);
    assert.ok(upResult.log.length > 0);

    // Check foreign key integrity
    const fkViolations = await checkForeignKeys(testDb);
    assert.equal(fkViolations.length, 0);

    // Verify all 6 tables created
    const hasOrgs = await testDb.schema.hasTable("organizations");
    const hasUsers = await testDb.schema.hasTable("users");
    const hasProjects = await testDb.schema.hasTable("projects");
    const hasParts = await testDb.schema.hasTable("parts");
    const hasVersions = await testDb.schema.hasTable("part_versions");
    const hasAssets = await testDb.schema.hasTable("stored_assets");

    assert.equal(hasOrgs, true);
    assert.equal(hasUsers, true);
    assert.equal(hasProjects, true);
    assert.equal(hasParts, true);
    assert.equal(hasVersions, true);
    assert.equal(hasAssets, true);

    // Down (Rollback)
    const downResult = await rollbackMigrations(testDb);
    assert.ok(downResult.log.length > 0);

    const hasOrgsAfter = await testDb.schema.hasTable("organizations");
    assert.equal(hasOrgsAfter, false);

    // Re-run Up
    const reUpResult = await runMigrations(testDb);
    assert.ok(reUpResult.batchNo >= 1);
  } finally {
    await testDb.destroy();
  }
});

test("Foreign key constraints: rejects orphan records when foreign keys enabled", async () => {
  const testDb = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(testDb);

    // Attempting to insert a project with non-existent organization_id must throw
    await assert.rejects(
      async () => {
        await testDb("projects").insert({
          id: "proj-1",
          organization_id: "non-existent-org",
          name: "Test Project",
        });
      },
      /FOREIGN KEY constraint failed/
    );
  } finally {
    await testDb.destroy();
  }
});

// ─── 4. Repositories Skeleton ────────────────────────────────────────────────

test("Repositories: CRUD operations work through BaseRepository subclasses", async () => {
  const testDb = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(testDb);

    const orgRepo = new OrganizationRepository(testDb);
    const projRepo = new ProjectRepository(testDb);
    const partRepo = new PartRepository(testDb);

    // Insert organization
    await orgRepo.insert({
      id: "org-msme-1",
      name: "Apex Precision Tools",
      slug: "apex-precision",
    });

    const foundOrg = await orgRepo.findBySlug("apex-precision");
    assert.equal(foundOrg.name, "Apex Precision Tools");

    // Insert project
    await projRepo.insert({
      id: "proj-gearbox-1",
      organization_id: "org-msme-1",
      name: "Industrial Gearbox Overhaul",
    });

    const projects = await projRepo.listByOrganization("org-msme-1");
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, "Industrial Gearbox Overhaul");

    // Insert part
    await partRepo.insert({
      id: "part-pinion-1",
      project_id: "proj-gearbox-1",
      name: "Drive Pinion Gear",
      component_type: "gear",
    });

    const parts = await partRepo.listByProject("proj-gearbox-1");
    assert.equal(parts.length, 1);
    assert.equal(parts[0].name, "Drive Pinion Gear");
  } finally {
    await testDb.destroy();
  }
});

// ─── 5. AssetStore Tests ────────────────────────────────────────────────────

test("AssetStore: atomic put, get, and exists work correctly", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reforge-assets-test-"));
  try {
    const store = new AssetStore(tmpDir);
    const content = Buffer.from("CAD-STEP-DATA-SAMPLE-12345");

    const result = await store.put(content, { ext: "step" });
    assert.ok(result.storageKey.endsWith(".step"));
    assert.equal(result.sizeBytes, content.length);
    assert.ok(result.sha256);

    const exists = await store.exists(result.storageKey);
    assert.equal(exists, true);

    const retrieved = await store.get(result.storageKey);
    assert.deepEqual(retrieved, content);

    // Deletion
    const deleted = await store.delete(result.storageKey);
    assert.equal(deleted, true);
    assert.equal(await store.exists(result.storageKey), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("AssetStore: strictly rejects path traversal attempts", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reforge-assets-test-"));
  try {
    const store = new AssetStore(tmpDir);
    assert.throws(
      () => store.resolvePath("../../../etc/passwd"),
      /path traversal rejected/
    );
    assert.throws(
      () => store.resolvePath("foo/../../bar"),
      /path traversal rejected/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── 6. HTTP API In-Process Simulation Tests ────────────────────────────────

function simulateRequest(appInstance, options, postData = null) {
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

test("HTTP: Helmet headers and X-Request-Id are returned on responses", async () => {
  const res = await simulateRequest(app, { path: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers["x-request-id"]);
  assert.ok(res.headers["x-content-type-options"]);
  assert.equal(res.body.ok, true);
});

test("HTTP: Unknown /api route returns structured 404 error envelope", async () => {
  const res = await simulateRequest(app, { path: "/api/unknown-endpoint-test" });
  assert.equal(res.statusCode, 404);
  assert.ok(res.headers["x-request-id"]);
  assert.equal(res.body.error.code, "not_found");
  assert.equal(res.body.error.requestId, res.headers["x-request-id"]);
});

test("HTTP: CORS allows approved origins and rejects unapproved origins with 403 envelope", async () => {
  // Approved Origin
  const resApproved = await simulateRequest(app, {
    path: "/api/health",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(resApproved.statusCode, 200);
  assert.equal(resApproved.headers["access-control-allow-origin"], "http://localhost:5173");

  // Unapproved Origin
  const resRejected = await simulateRequest(app, {
    path: "/api/health",
    headers: { origin: "http://evil-attacker.com" },
  });
  assert.equal(resRejected.statusCode, 403);
  assert.equal(resRejected.body.error.code, "cors_origin_rejected");
});

test("HTTP: Per-route body limits reject oversized payloads on standard endpoints (>1MB)", async () => {
  const oversizedBody = {
    analysis: {
      componentType: "spur_gear",
      largeData: "X".repeat(1.2 * 1024 * 1024),
    },
  };

  const res = await simulateRequest(
    app,
    {
      path: "/api/manufacturing-intelligence",
      method: "POST",
      headers: { "content-type": "application/json" },
    },
    oversizedBody
  );

  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error.code, "payload_too_large");
});

test("HTTP: 8-image analysis payload succeeds within 25MB analysis limit", async () => {
  const images = Array.from({ length: 8 }, () => ({
    data: Buffer.from("reforge-image-pixel-data-sample-".repeat(5000)).toString("base64"),
    mimeType: "image/png",
  }));

  const res = await simulateRequest(
    app,
    {
      path: "/api/analyze-component",
      method: "POST",
      headers: { "content-type": "application/json" },
    },
    { images, reference: { outerDiameter: 120 } }
  );

  assert.notEqual(res.statusCode, 413, "8 images must not trigger 413 Payload Too Large");
  assert.ok(res.headers["x-request-id"]);
});
