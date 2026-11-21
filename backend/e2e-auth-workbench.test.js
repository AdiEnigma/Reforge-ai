import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { app, db } from "./index.js";

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

test("E2E Authentication, Session Transmission, Workbench Creation and Snapshot Saving", async (t) => {
  await t.test("1. Unauthenticated request to /api/auth/me returns 401", async () => {
    const res = await simulateRequest(app, { path: "/api/auth/me", method: "GET" });
    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /No active session/i);
  });

  await t.test("2. Unauthenticated request to /api/workbenches returns 401", async () => {
    const res = await simulateRequest(app, { path: "/api/workbenches", method: "GET" });
    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /Authentication required/i);
  });

  let sessionCookie = null;
  let adminUserId = null;

  await t.test("3. Login as admin-001 succeeds, issues reforge_session cookie with correct options", async () => {
    const res = await simulateRequest(app, {
      path: "/api/auth/login",
      method: "POST",
      headers: { origin: "http://localhost:5173" },
    }, {
      identifier: "admin-001",
      password: "Admin123",
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.user.username, "admin-001");
    adminUserId = res.body.user.id;

    const cookieHeader = res.headers["set-cookie"];
    assert.ok(cookieHeader, "Must return set-cookie header");
    const raw = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    assert.match(raw, /reforge_session=/);
    assert.match(raw, /Path=\//i);
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);

    sessionCookie = raw.split(";")[0];
  });

  await t.test("4. /api/auth/me succeeds with cookie and returns full profile", async () => {
    const res = await simulateRequest(app, {
      path: "/api/auth/me",
      method: "GET",
      headers: { origin: "http://localhost:5173" },
    }, null, sessionCookie);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.user.username, "admin-001");
    assert.equal(res.body.user.id, adminUserId);
    assert.equal(res.body.user.organization.name, "Indus Valley");
  });

  let createdWorkbenchId = null;

  await t.test("5. POST /api/workbenches creates a workbench owned by admin-001", async () => {
    const res = await simulateRequest(app, {
      path: "/api/workbenches",
      method: "POST",
      headers: { origin: "http://localhost:5173" },
    }, {
      name: "Regression Test Project",
      componentName: "Spur Gear Test",
    }, sessionCookie);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.workbench.id);
    assert.equal(res.body.workbench.user_id, adminUserId);
    createdWorkbenchId = res.body.workbench.id;
  });

  await t.test("6. PUT /api/workbenches/:id/snapshot saves engineering state snapshot", async () => {
    const res = await simulateRequest(app, {
      path: `/api/workbenches/${createdWorkbenchId}/snapshot`,
      method: "PUT",
      headers: { origin: "http://localhost:5173" },
    }, {
      state: {
        componentType: "spur_gear",
        dimensions: { outer_diameter: 120, teeth: 30 },
        analysis: { component_type: "spur_gear", confidence: 0.99 },
      },
    }, sessionCookie);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.snapshot.workbenchId, createdWorkbenchId);
    assert.equal(res.body.snapshot.version, 1);
  });

  await t.test("7. GET /api/workbenches returns saved project in list for owner", async () => {
    const res = await simulateRequest(app, {
      path: "/api/workbenches",
      method: "GET",
      headers: { origin: "http://localhost:5173" },
    }, null, sessionCookie);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.workbenches));
    const found = res.body.workbenches.find((w) => w.id === createdWorkbenchId);
    assert.ok(found, "Saved workbench must appear in owner list");
    assert.equal(found.name, "Regression Test Project");
    assert.equal(found.hasGeometry, true);
  });

  await t.test("8. GET /api/workbenches/:id resumes state and snapshot", async () => {
    const res = await simulateRequest(app, {
      path: `/api/workbenches/${createdWorkbenchId}`,
      method: "GET",
      headers: { origin: "http://localhost:5173" },
    }, null, sessionCookie);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.workbench.id, createdWorkbenchId);
    assert.equal(res.body.snapshot.state.dimensions.teeth, 30);
  });

  await t.test("9. User isolation: user-01 cannot access admin-001 workbench", async () => {
    const loginUserRes = await simulateRequest(app, {
      path: "/api/auth/login",
      method: "POST",
      headers: { origin: "http://localhost:5173" },
    }, {
      identifier: "user-01",
      password: "User123",
    });
    assert.equal(loginUserRes.statusCode, 200);
    const setCookie = loginUserRes.headers["set-cookie"]; const userCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie.split(";")[0];

    // Try to access admin's workbench
    const res = await simulateRequest(app, {
      path: `/api/workbenches/${createdWorkbenchId}`,
      method: "GET",
    }, null, userCookie);

    assert.equal(res.statusCode, 404, "Must return 404 for unauthorized workbench access");
  });

  await t.test("10. Invalid or expired cookie returns 401", async () => {
    const res = await simulateRequest(app, {
      path: "/api/workbenches",
      method: "GET",
    }, null, "reforge_session=fake_invalid_token_12345");

    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /Session expired or invalid/i);
  });
});
