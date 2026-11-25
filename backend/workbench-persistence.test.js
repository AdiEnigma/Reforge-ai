import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import express from "express";
import cookieParser from "cookie-parser";

import { initSchema } from "./src/db.js";
import { seedDemoAccounts } from "./src/demo-seed.js";
import { loginUser, validateSession } from "./src/auth-service.js";
import { COOKIE_NAME } from "./src/auth-routes.js";
import {
  createWorkbench,
  listWorkbenches,
  getWorkbench,
  updateWorkbenchMetadata,
  saveSnapshot,
  saveAsset,
  getAsset,
  listAssets,
  deleteWorkbench,
  getWorkbenchDir,
} from "./src/workbench-service.js";
import { createWorkbenchRouter } from "./src/workbench-routes.js";

/**
 * Creates an in-memory SQLite DB with full schema and seeded demo users.
 */
async function createTestEnv() {
  const db = new Database(":memory:");
  initSchema(db);
  await seedDemoAccounts(db);

  const tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), "reforge-wb-test-"));

  // Log in as admin-001 and user-01
  const adminAuth = await loginUser(db, "admin-001", "Admin123");
  const user1Auth = await loginUser(db, "user-01", "User123");

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use("/api/workbenches", createWorkbenchRouter(db));

  return {
    db,
    tmpStorage,
    adminAuth,
    user1Auth,
    cleanup: () => {
      try {
        db.close();
      } catch {}
      try {
        fs.rmSync(tmpStorage, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("1 & 2. A new workbench is created for the authenticated user and can be retrieved", async () => {
  const { db, adminAuth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, {
      userId: adminAuth.user.id,
      organizationId: adminAuth.user.organization?.id,
      name: "Helical Pinion Gear",
      componentName: "Helical Gear",
    });

    assert.ok(wb.id, "Workbench should have an ID");
    assert.equal(wb.name, "Helical Pinion Gear");
    assert.equal(wb.component_name, "Helical Gear");
    assert.equal(wb.status, "draft");
    assert.equal(wb.user_id, adminAuth.user.id);

    const fetched = getWorkbench(db, adminAuth.user.id, wb.id);
    assert.equal(fetched.workbench.id, wb.id);
    assert.equal(fetched.workbench.name, "Helical Pinion Gear");
    assert.equal(fetched.snapshot, null);
    assert.deepEqual(fetched.assets, []);
  } finally {
    cleanup();
  }
});

test("3. A different user cannot retrieve that workbench (authorization isolation)", async () => {
  const { db, adminAuth, user1Auth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, {
      userId: adminAuth.user.id,
      name: "Admin Private Project",
    });

    assert.throws(
      () => getWorkbench(db, user1Auth.user.id, wb.id),
      (err) => err.status === 404
    );
  } finally {
    cleanup();
  }
});

test("4. A user cannot access or download another user's assets", async () => {
  const { db, adminAuth, user1Auth, tmpStorage, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, {
      userId: adminAuth.user.id,
      name: "Asset Test",
    });

    const fakeImage = Buffer.from("dummy-png-image-bytes");
    const asset = saveAsset(db, adminAuth.user.id, wb.id, {
      category: "uploaded_image",
      originalFilename: "gear_side.png",
      mimeType: "image/png",
      buffer: fakeImage,
    });

    assert.ok(asset.id);

    // Admin can retrieve asset
    const read = getAsset(db, adminAuth.user.id, wb.id, asset.id);
    assert.equal(read.asset.original_filename, "gear_side.png");

    // User1 cannot retrieve admin's asset
    assert.throws(
      () => getAsset(db, user1Auth.user.id, wb.id, asset.id),
      (err) => err.status === 404
    );
  } finally {
    cleanup();
  }
});

test("5. Workbench listing returns only records belonging to the authorized user", async () => {
  const { db, adminAuth, user1Auth, cleanup } = await createTestEnv();
  try {
    createWorkbench(db, { userId: adminAuth.user.id, name: "Admin Project 1" });
    createWorkbench(db, { userId: adminAuth.user.id, name: "Admin Project 2" });
    createWorkbench(db, { userId: user1Auth.user.id, name: "User1 Project 1" });

    const adminList = listWorkbenches(db, adminAuth.user.id);
    const user1List = listWorkbenches(db, user1Auth.user.id);

    assert.equal(adminList.length, 2);
    assert.equal(user1List.length, 1);
    assert.equal(adminList[0].name.startsWith("Admin"), true);
    assert.equal(user1List[0].name, "User1 Project 1");
  } finally {
    cleanup();
  }
});

test("6. Uploaded images are saved to disk, metadata is recorded, and retrieved cleanly", async () => {
  const { db, adminAuth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, { userId: adminAuth.user.id, name: "Upload Test" });
    const buffer = Buffer.from("simulated_image_content_12345");

    const asset = saveAsset(db, adminAuth.user.id, wb.id, {
      category: "uploaded_image",
      originalFilename: "sample_view.jpg",
      mimeType: "image/jpeg",
      buffer,
    });

    assert.equal(asset.originalFilename, "sample_view.jpg");
    assert.equal(asset.mimeType, "image/jpeg");
    assert.equal(asset.fileSize, buffer.length);

    const assetList = listAssets(db, adminAuth.user.id, wb.id);
    assert.equal(assetList.length, 1);
    assert.equal(assetList[0].id, asset.id);

    const { asset: retrieved, filePath } = getAsset(db, adminAuth.user.id, wb.id, asset.id);
    assert.equal(retrieved.id, asset.id);
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readFileSync(filePath).toString(), "simulated_image_content_12345");
  } finally {
    cleanup();
  }
});

test("7, 8 & 9. Dimensions, AI analysis, and geometry parameters survive save and reload", async () => {
  const { db, adminAuth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, { userId: adminAuth.user.id, name: "Spur Gear Reconstruct" });

    const sampleEngineeringState = {
      reference: {
        teeth: 24,
        module: 2.5,
        outerDiameter: 65,
        bore: 15,
      },
      analysis: {
        componentName: "Industrial Spur Gear",
        componentType: "spur_gear",
        confidence: 0.96,
        dimensions: {
          outerDiameter: { value: 65, unit: "mm" },
          teeth: { value: 24, unit: "count" },
          module: { value: 2.5, unit: "mm" },
          faceWidth: { value: 20, unit: "mm" },
        },
        geometryRecipe: {
          type: "gear",
          gearType: "spur",
          teeth: 24,
          module: 2.5,
          faceWidth: 20,
          boreDiameter: 15,
        },
      },
      machineryState: {
        primaryGear: {
          name: "Industrial Spur Gear",
          role: "PRIMARY",
          reference: { teeth: 24, module: 2.5 },
        },
      },
      stage: "ready",
    };

    const snapResult = saveSnapshot(db, adminAuth.user.id, wb.id, sampleEngineeringState);
    assert.equal(snapResult.version, 1);

    // Fetch workbench again
    const reloaded = getWorkbench(db, adminAuth.user.id, wb.id);
    assert.equal(reloaded.workbench.status, "completed");
    assert.equal(reloaded.workbench.componentName, "Industrial Spur Gear");
    assert.ok(reloaded.snapshot);
    assert.equal(reloaded.snapshot.version, 1);

    const restoredState = reloaded.snapshot.state;
    assert.deepEqual(restoredState.reference, sampleEngineeringState.reference);
    assert.deepEqual(restoredState.analysis.dimensions, sampleEngineeringState.analysis.dimensions);
    assert.deepEqual(restoredState.analysis.geometryRecipe, sampleEngineeringState.analysis.geometryRecipe);
  } finally {
    cleanup();
  }
});

test("10. CAD export files remain downloadable and queryable", async () => {
  const { db, adminAuth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, { userId: adminAuth.user.id, name: "CAD Export Project" });
    const stepContent = Buffer.from("ISO-10303-21; HEADER; ... ENDSEC; END-ISO-10303-21;");

    const asset = saveAsset(db, adminAuth.user.id, wb.id, {
      category: "cad_step",
      originalFilename: "spur_gear_solid.step",
      mimeType: "application/step",
      buffer: stepContent,
    });

    const fetched = getWorkbench(db, adminAuth.user.id, wb.id);
    assert.equal(fetched.assets.length, 1);
    assert.equal(fetched.assets[0].category, "cad_step");

    const { filePath } = getAsset(db, adminAuth.user.id, wb.id, asset.id);
    const diskContent = fs.readFileSync(filePath);
    assert.equal(diskContent.toString(), stepContent.toString());
  } finally {
    cleanup();
  }
});

test("11. Autosave updates existing workbench version instead of creating duplicates", async () => {
  const { db, adminAuth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, { userId: adminAuth.user.id, name: "Autosave Flow" });

    // State 1: Upload images
    saveSnapshot(db, adminAuth.user.id, wb.id, {
      stage: "idle",
      machineryState: { primaryGear: { images: [{ id: "img-1", name: "view1.png" }] } },
    });

    // State 2: Analysis ready
    saveSnapshot(db, adminAuth.user.id, wb.id, {
      stage: "ready",
      analysis: { componentName: "Pinion Shaft", componentType: "shaft" },
    });

    // Verify only 1 workbench exists
    const list = listWorkbenches(db, adminAuth.user.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, wb.id);
    assert.equal(list[0].latestVersion, 2);

    // Latest snapshot has state 2
    const current = getWorkbench(db, adminAuth.user.id, wb.id);
    assert.equal(current.snapshot.version, 2);
    assert.equal(current.snapshot.state.analysis.componentName, "Pinion Shaft");
  } finally {
    cleanup();
  }
});

test("12. Failed saves or invalid state payloads do not corrupt the last valid snapshot", async () => {
  const { db, adminAuth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, { userId: adminAuth.user.id, name: "Integrity Project" });

    saveSnapshot(db, adminAuth.user.id, wb.id, {
      validKey: "validValue",
    });

    assert.throws(() => {
      saveSnapshot(db, adminAuth.user.id, wb.id, null);
    });

    const current = getWorkbench(db, adminAuth.user.id, wb.id);
    assert.equal(current.snapshot.version, 1);
    assert.equal(current.snapshot.state.validKey, "validValue");
  } finally {
    cleanup();
  }
});

test("13. Deleting a workbench cleans up database records and filesystem directory", async () => {
  const { db, adminAuth, cleanup } = await createTestEnv();
  try {
    const wb = createWorkbench(db, { userId: adminAuth.user.id, name: "To Delete" });
    saveAsset(db, adminAuth.user.id, wb.id, {
      category: "uploaded_image",
      originalFilename: "temp.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("image_to_delete"),
    });

    const dir = getWorkbenchDir(adminAuth.user.id, wb.id);
    assert.ok(fs.existsSync(dir));

    deleteWorkbench(db, adminAuth.user.id, wb.id);

    const list = listWorkbenches(db, adminAuth.user.id);
    assert.equal(list.length, 0);
    assert.ok(!fs.existsSync(dir), "Directory should be cleaned up from filesystem");
  } finally {
    cleanup();
  }
});

import http from "node:http";
import { Readable } from "node:stream";

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
    } else {
      req.push(null);
    }
  });
}

test("14-17. Full HTTP End-to-End Workbench API Lifecycle (Create, Upload Images, Save Snapshot, Resume, Access Control)", async () => {
  const { db, adminAuth, user1Auth, cleanup } = await createTestEnv();
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use("/api/workbenches", createWorkbenchRouter(db));

  try {
    const adminCookie = `${COOKIE_NAME}=${adminAuth.sessionToken}`;
    const user1Cookie = `${COOKIE_NAME}=${user1Auth.sessionToken}`;

    // 1. Unauthenticated request rejected
    const unauthRes = await simulateRequest(app, {
      path: "/api/workbenches",
      method: "GET",
    });
    assert.equal(unauthRes.statusCode, 401);

    // 2. Admin creates a new workbench
    const createRes = await simulateRequest(
      app,
      { path: "/api/workbenches", method: "POST" },
      { name: "Flange Synthesis 2026", componentName: "Mounting Flange" },
      adminCookie
    );
    assert.equal(createRes.statusCode, 201);
    assert.ok(createRes.body.workbench.id);
    const wbId = createRes.body.workbench.id;

    // 3. Admin uploads 2 images
    const img1Res = await simulateRequest(
      app,
      { path: `/api/workbenches/${wbId}/images`, method: "POST" },
      { name: "flange_top.png", mimeType: "image/png", data: Buffer.from("png_top_bytes").toString("base64") },
      adminCookie
    );
    assert.equal(img1Res.statusCode, 201);
    assert.ok(img1Res.body.asset.id);

    const img2Res = await simulateRequest(
      app,
      { path: `/api/workbenches/${wbId}/images`, method: "POST" },
      { name: "flange_side.png", mimeType: "image/png", data: Buffer.from("png_side_bytes").toString("base64") },
      adminCookie
    );
    assert.equal(img2Res.statusCode, 201);

    // 4. Admin saves engineering snapshot (analysis + dimensions)
    const snapRes = await simulateRequest(
      app,
      { path: `/api/workbenches/${wbId}/snapshot`, method: "PUT" },
      {
        state: {
          reference: { outerDiameter: 120, bore: 35, boltCount: 6 },
          analysis: {
            componentName: "Mounting Flange",
            componentType: "flange",
            dimensions: { outerDiameter: { value: 120, unit: "mm" } },
          },
          stage: "ready",
        },
      },
      adminCookie
    );
    assert.equal(snapRes.statusCode, 200);
    assert.equal(snapRes.body.snapshot.version, 1);

    // 5. Admin lists workbenches -> 1 workbench with imageCount 2 and hasAnalysis true
    const listRes = await simulateRequest(
      app,
      { path: "/api/workbenches", method: "GET" },
      null,
      adminCookie
    );
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.workbenches.length, 1);
    assert.equal(listRes.body.workbenches[0].imageCount, 2);
    assert.equal(listRes.body.workbenches[0].hasAnalysis, true);

    // 6. Admin resumes/retrieves workbench -> all state restored cleanly
    const resumeRes = await simulateRequest(
      app,
      { path: `/api/workbenches/${wbId}`, method: "GET" },
      null,
      adminCookie
    );
    assert.equal(resumeRes.statusCode, 200);
    assert.equal(resumeRes.body.workbench.componentName, "Mounting Flange");
    assert.equal(resumeRes.body.snapshot.state.analysis.componentType, "flange");
    assert.equal(resumeRes.body.assets.length, 2);

    // 7. User1 attempts to access admin workbench -> 404 forbidden
    const rogueRes = await simulateRequest(
      app,
      { path: `/api/workbenches/${wbId}`, method: "GET" },
      null,
      user1Cookie
    );
    assert.equal(rogueRes.statusCode, 404);

    // 8. User1 workbench list is empty
    const user1ListRes = await simulateRequest(
      app,
      { path: "/api/workbenches", method: "GET" },
      null,
      user1Cookie
    );
    assert.equal(user1ListRes.statusCode, 200);
    assert.equal(user1ListRes.body.workbenches.length, 0);
  } finally {
    cleanup();
  }
});
