/**
 * Contract tests: Node CAD adapter <-> Python /cad/generate[-advanced].
 * These assert the wire shape the Python service expects and the fail-open
 * behaviour relied on by the orchestration layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callCadService, chooseCadRoute } from "./cad-adapter.js";

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

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

test("legacy contract: recipe and dimensions reach /cad/generate", async () => {
  process.env.CAD_ENABLED = "true";
  let received = null;

  await withServer(
    async (req, res) => {
      received = { url: req.url, payload: await readJson(req) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "success",
          step_path: "a.step",
          stl_path: "a.stl",
          mesh_path: "a.mesh.json",
          validation_report: { valid: true, metrics: { actual_bbox: {} } },
          feature_tree: { style: "revolved" },
        })
      );
    },
    async (port) => {
      process.env.CAD_SERVICE_URL = `http://127.0.0.1:${port}`;
      const route = chooseCadRoute({ style: "gear" });
      const result = await callCadService(
        {
          job_id: "contract_legacy",
          recipe: { style: "gear", teeth: 24 },
          user_dimensions: { outerDiameter: 60 },
          solver_output: null,
          opencv_observations: { circles: [{ cx: 10, cy: 10, r: 5 }] },
        },
        route
      );
      assert.equal(result.ok, true);
      assert.equal(result.body.mesh_path, "a.mesh.json");
      assert.equal(route.path, "/cad/generate");
    }
  );

  assert.equal(received.url, "/cad/generate");
  assert.equal(received.payload.job_id, "contract_legacy");
  assert.equal(received.payload.recipe.style, "gear");
  assert.equal(received.payload.user_dimensions.outerDiameter, 60);
  assert.equal(received.payload.opencv_observations.circles.length, 1);
});

test("advanced contract: feature response and mesh path round-trip", async () => {
  process.env.CAD_ENABLED = "true";
  let received = null;

  await withServer(
    async (req, res) => {
      received = { url: req.url, payload: await readJson(req) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "success",
          mode: "feature",
          step_path: "b.step",
          stl_path: "b.stl",
          mesh_path: "b.mesh.json",
          feature_history: { features: [] },
          validation_report: { valid: true, fit_score: 0.93 },
        })
      );
    },
    async (port) => {
      process.env.CAD_SERVICE_URL = `http://127.0.0.1:${port}`;
      process.env.CAD_ADVANCED_ENABLED = "true";
      try {
        const route = chooseCadRoute({ style: "revolved" });
        const result = await callCadService(
          {
            job_id: "contract_advanced",
            recipe: { style: "revolved", revolvedProfile: [] },
            user_dimensions: { height: 20 },
            strict: false,
          },
          route
        );
        assert.equal(result.ok, true);
        assert.equal(result.body.mesh_path, "b.mesh.json");
        assert.equal(result.body.feature_history.features.length, 0);
        assert.equal(route.path, "/cad/generate-advanced");
      } finally {
        delete process.env.CAD_ADVANCED_ENABLED;
      }
    }
  );

  assert.equal(received.url, "/cad/generate-advanced");
  assert.equal(received.payload.strict, false);
  assert.equal(received.payload.user_dimensions.height, 20);
});

test("fail-open: disabled CAD never throws", async () => {
  process.env.CAD_ENABLED = "false";
  const result = await callCadService({ job_id: "x", recipe: { style: "gear" } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.body, null);
});

test("fail-open: validation errors surface without throwing", async () => {
  process.env.CAD_ENABLED = "true";
  await withServer(
    (_req, res) => {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "needs_input", missing: ["outerDiameter"] }));
    },
    async (port) => {
      process.env.CAD_SERVICE_URL = `http://127.0.0.1:${port}`;
      const result = await callCadService({ recipe: { style: "gear" } });
      assert.equal(result.ok, false);
      assert.equal(result.status, 422);
      assert.deepEqual(result.body.missing, ["outerDiameter"]);
    }
  );
});
