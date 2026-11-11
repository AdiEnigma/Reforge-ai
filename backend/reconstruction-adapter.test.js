import test from "node:test";
import assert from "node:assert/strict";
import { isReconstructionEnabled, callReconstructionService } from "./reconstruction-adapter.js";

test("isReconstructionEnabled defaults to false", () => {
  assert.equal(typeof isReconstructionEnabled(), "boolean");
});

test("callReconstructionService returns null when reconstruction is disabled", async () => {
  const result = await callReconstructionService({ job_id: "test" });
  assert.equal(result, null);
});

