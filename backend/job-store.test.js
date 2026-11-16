import test from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  getJob,
  updateJob,
  serializeJob,
  clearJobs,
  JOB_STATES,
} from "./job-store.js";

test("job states include the WORKFLOW orchestration states", () => {
  for (const state of [
    "queued",
    "analyzing",
    "generating_cad",
    "needs_input",
    "done",
    "failed",
    "unavailable",
  ]) {
    assert.ok(JOB_STATES.includes(state));
  }
});

test("createJob starts queued and serializeJob hides image inputs", () => {
  clearJobs();
  const job = createJob({
    images: [{ data: "a".repeat(200), mimeType: "image/png" }],
    reference: { outerDiameter: 20 },
  });
  assert.match(job.id, /^job_[a-f0-9]{16}$/);
  assert.equal(job.state, "queued");
  assert.equal(job.progress, 0);

  const serialized = serializeJob(job);
  assert.equal(serialized.id, job.id);
  assert.deepEqual(serialized.input, { reference: { outerDiameter: 20 } });
  assert.ok(!JSON.stringify(serialized).includes("aaaaaaaa"));
  assert.equal(serialized.input.images, undefined);
});

test("updateJob patches state and updatedAt", () => {
  clearJobs();
  const job = createJob({ reference: {} });
  const before = job.updatedAt;
  const updated = updateJob(job.id, { state: "done", progress: 1 });
  assert.equal(updated.state, "done");
  assert.equal(updated.progress, 1);
  assert.ok(updated.updatedAt >= before);
  assert.equal(getJob(job.id).state, "done");
});

test("getJob rejects unknown ids", () => {
  clearJobs();
  assert.equal(getJob("job_missing"), null);
  assert.equal(getJob(null), null);
});

test("expired jobs are pruned on access", () => {
  clearJobs();
  process.env.JOB_TTL_SECONDS = "30";
  const job = createJob({ reference: {} });
  job.updatedAt = Date.now() - 31_000;
  assert.equal(getJob(job.id), null);
  delete process.env.JOB_TTL_SECONDS;
});
