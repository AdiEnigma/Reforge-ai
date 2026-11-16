import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  isReconstructionEnabled,
  callReconstructionService,
} from "./reconstruction-adapter.js";

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

test("reconstruction adapter returns null when disabled", async () => {
  process.env.RECONSTRUCTION_ENABLED = "false";
  assert.equal(isReconstructionEnabled(), false);
  assert.equal(await callReconstructionService({ job_id: "j" }), null);
});

test("reconstruction adapter posts to /reconstruct and parses the response", async () => {
  process.env.RECONSTRUCTION_ENABLED = "true";
  let received = null;

  await withServer(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = { url: req.url, payload: JSON.parse(body) };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            job_id: "j1",
            multiview: { status: "unavailable" },
            solver: { status: "success", parameters: {} },
          })
        );
      });
    },
    async (port) => {
      process.env.RECONSTRUCTION_SERVICE_URL = `http://127.0.0.1:${port}`;
      const result = await callReconstructionService({
        job_id: "j1",
        image_paths: ["a.png", "b.png"],
      });
      assert.equal(result.job_id, "j1");
      assert.equal(result.solver.status, "success");
    }
  );

  assert.equal(received.url, "/reconstruct");
  assert.equal(received.payload.image_paths.length, 2);
});

test("reconstruction adapter fails open when the service is unreachable", async () => {
  process.env.RECONSTRUCTION_ENABLED = "true";
  process.env.RECONSTRUCTION_SERVICE_URL = "http://127.0.0.1:1";
  const result = await callReconstructionService({ job_id: "j2" });
  assert.equal(result, null);
});

test("reconstruction adapter fails open on invalid JSON", async () => {
  process.env.RECONSTRUCTION_ENABLED = "true";
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json");
    },
    async (port) => {
      process.env.RECONSTRUCTION_SERVICE_URL = `http://127.0.0.1:${port}`;
      assert.equal(await callReconstructionService({}), null);
    }
  );
});
