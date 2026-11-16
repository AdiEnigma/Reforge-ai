import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  stageReconstructionPhotos,
  reconstructionImageRoot,
  MAX_RECONSTRUCTION_PHOTOS,
} from "./reconstruction-photos.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function withImageRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reforge-photo-test-"));
  const previous = process.env.RECONSTRUCTION_IMAGE_ROOT;
  process.env.RECONSTRUCTION_IMAGE_ROOT = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.RECONSTRUCTION_IMAGE_ROOT;
    else process.env.RECONSTRUCTION_IMAGE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("reconstructionImageRoot honors RECONSTRUCTION_IMAGE_ROOT", async () => {
  await withImageRoot(async (root) => {
    assert.equal(reconstructionImageRoot(), path.resolve(root));
  });
});

test("stageReconstructionPhotos returns no paths when no photos are supplied", async () => {
  await withImageRoot(async () => {
    assert.deepEqual(await stageReconstructionPhotos(undefined, "job1"), []);
    assert.deepEqual(await stageReconstructionPhotos([], "job1"), []);
  });
});

test("stageReconstructionPhotos writes photos under the image root", async () => {
  await withImageRoot(async (root) => {
    const photos = [
      { mimeType: "image/png", data: PNG_BASE64 },
      { mimeType: "image/jpg", data: `data:image/jpeg;base64,${PNG_BASE64}` },
    ];
    const paths = await stageReconstructionPhotos(photos, "job_123");

    assert.equal(paths.length, 2);
    for (const filePath of paths) {
      assert.ok(path.isAbsolute(filePath));
      assert.ok(filePath.startsWith(path.resolve(root) + path.sep));
      const info = await stat(filePath);
      assert.ok(info.size > 0);
    }
    assert.ok(paths[0].endsWith(".png"));
    assert.ok(paths[1].endsWith(".jpg"));
  });
});

test("stageReconstructionPhotos rejects unsupported types and oversized batches", async () => {
  await withImageRoot(async () => {
    await assert.rejects(
      () => stageReconstructionPhotos([{ mimeType: "image/gif", data: PNG_BASE64 }], "job1"),
      (error) => error.status === 400
    );
    await assert.rejects(
      () => stageReconstructionPhotos({}, "job1"),
      (error) => error.status === 400
    );
    const tooMany = Array.from({ length: MAX_RECONSTRUCTION_PHOTOS + 1 }, () => ({
      mimeType: "image/png",
      data: PNG_BASE64,
    }));
    await assert.rejects(
      () => stageReconstructionPhotos(tooMany, "job1"),
      (error) => error.status === 413
    );
  });
});
