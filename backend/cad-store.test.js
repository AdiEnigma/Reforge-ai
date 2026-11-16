import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  stageCadOutputs,
  resolveCadFile,
  newJobId,
  cadRoot,
} from "./cad-store.js";

async function withTempStore(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "reforge-cad-store-"));
  const previous = process.env.CAD_STORE_DIR;
  process.env.CAD_STORE_DIR = directory;
  try {
    return await run(directory);
  } finally {
    if (previous === undefined) delete process.env.CAD_STORE_DIR;
    else process.env.CAD_STORE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeSource(directory, name, contents) {
  const filePath = path.join(directory, name);
  await writeFile(filePath, contents);
  return filePath;
}

test("stageCadOutputs copies allowlisted artefacts into the job directory", async () => {
  await withTempStore(async (directory) => {
    const sourceDir = await mkdtemp(path.join(directory, "src-"));
    const stepPath = await writeSource(sourceDir, "a.step", "STEP");
    const stlPath = await writeSource(sourceDir, "a.stl", "STL");
    const meshPath = await writeSource(sourceDir, "a.mesh.json", "{}");

    const jobId = newJobId();
    const files = await stageCadOutputs({ jobId, stepPath, stlPath, meshPath });

    assert.equal(files.step, `/api/cad/files/${jobId}-model.step`);
    assert.equal(files.stl, `/api/cad/files/${jobId}-model.stl`);
    assert.equal(files.mesh, `/api/cad/files/${jobId}-model.mesh.json`);
    await stat(path.join(cadRoot(), jobId, `${jobId}-model.step`));

    const resolved = resolveCadFile(`${jobId}-model.stl`);
    assert.equal(resolved.kind, "stl");
    assert.equal(resolved.jobId, jobId);
  });
});

test("stageCadOutputs skips step/stl when export is blocked", async () => {
  await withTempStore(async (directory) => {
    const sourceDir = await mkdtemp(path.join(directory, "src-"));
    const stepPath = await writeSource(sourceDir, "a.step", "STEP");
    const meshPath = await writeSource(sourceDir, "a.mesh.json", "{}");

    const jobId = newJobId();
    const files = await stageCadOutputs({
      jobId,
      stepPath,
      meshPath,
      includeStep: false,
      includeStl: false,
    });

    assert.equal(files.step, undefined);
    assert.equal(files.stl, undefined);
    assert.ok(files.mesh);
    assert.equal(resolveCadFile(`${jobId}-model.step`), null);
  });
});

test("resolveCadFile rejects unknown and unsafe filenames", async () => {
  await withTempStore(async () => {
    assert.equal(resolveCadFile("deadbeef-model.step"), null);
    assert.equal(resolveCadFile("../escape.step"), null);
  });
});

test("stageCadOutputs ignores missing or relative source paths", async () => {
  await withTempStore(async () => {
    const jobId = newJobId();
    const files = await stageCadOutputs({
      jobId,
      stepPath: "relative.step",
      stlPath: path.join(tmpdir(), "does-not-exist.stl"),
      meshPath: null,
    });
    assert.deepEqual(files, {});
  });
});
