import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callCadService, isCadEnabled, chooseCadRoute } from "./cad-adapter.js";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("callCadService posts to /cad/generate and returns parsed body", async () => {
  process.env.CAD_ENABLED = "true";
  let received = null;

  await withServer(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = { url: req.url, method: req.method, payload: JSON.parse(body) };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", step_path: "a.step" }));
      });
    },
    async (port) => {
      process.env.CAD_SERVICE_URL = `http://127.0.0.1:${port}`;
      const result = await callCadService({ job_id: "job1", recipe: { style: "gear" } });
      assert.equal(result.ok, true);
      assert.equal(result.status, 200);
      assert.equal(result.body.step_path, "a.step");
    }
  );

  assert.equal(received.url, "/cad/generate");
  assert.equal(received.method, "POST");
  assert.equal(received.payload.job_id, "job1");
});

test("callCadService surfaces validation errors without throwing", async () => {
  process.env.CAD_ENABLED = "true";
  await withServer(
    (_req, res) => {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ status: "error", stage: "recipe_validation", error: "bad recipe" })
      );
    },
    async (port) => {
      process.env.CAD_SERVICE_URL = `http://127.0.0.1:${port}`;
      const result = await callCadService({});
      assert.equal(result.ok, false);
      assert.equal(result.status, 422);
      assert.equal(result.body.stage, "recipe_validation");
    }
  );
});

test("callCadService reports unreachable service", async () => {
  process.env.CAD_ENABLED = "true";
  process.env.CAD_SERVICE_URL = "http://127.0.0.1:1";
  const result = await callCadService({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test("isCadEnabled reads CAD_ENABLED per call", () => {
  process.env.CAD_ENABLED = "false";
  assert.equal(isCadEnabled(), false);
  process.env.CAD_ENABLED = "true";
  assert.equal(isCadEnabled(), true);
});

test("chooseCadRoute defaults to legacy for every style", () => {
  delete process.env.CAD_ADVANCED_ENABLED;
  for (const style of ["revolved", "extruded", "combination", "gear"]) {
    assert.deepEqual(chooseCadRoute({ style }), {
      path: "/cad/generate",
      mode: "legacy",
    });
  }
});

test("chooseCadRoute sends non-gear styles to advanced when enabled", () => {
  process.env.CAD_ADVANCED_ENABLED = "true";
  try {
    for (const style of ["revolved", "extruded", "combination"]) {
      assert.deepEqual(chooseCadRoute({ style }), {
        path: "/cad/generate-advanced",
        mode: "advanced",
      });
    }
    assert.equal(chooseCadRoute({ style: "gear" }).mode, "legacy");
    assert.equal(chooseCadRoute(null).mode, "legacy");
  } finally {
    delete process.env.CAD_ADVANCED_ENABLED;
  }
});

test("callCadService honors an explicit advanced route", async () => {
  process.env.CAD_ENABLED = "true";
  let received = null;

  await withServer(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = { url: req.url, payload: JSON.parse(body) };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", mesh_path: "a.mesh.json" }));
      });
    },
    async (port) => {
      process.env.CAD_SERVICE_URL = `http://127.0.0.1:${port}`;
      const result = await callCadService(
        {
          job_id: "job2",
          recipe: { style: "revolved" },
          user_dimensions: { outerDiameter: 20 },
        },
        { path: "/cad/generate-advanced", mode: "advanced" }
      );
      assert.equal(result.ok, true);
      assert.equal(result.body.mesh_path, "a.mesh.json");
    }
  );

  assert.equal(received.url, "/cad/generate-advanced");
  assert.equal(received.payload.user_dimensions.outerDiameter, 20);
});
