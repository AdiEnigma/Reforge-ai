import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { logAnalysis, analysisLogConfig } from "./analysis-log.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function withLogDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reforge-log-test-"));
  const previous = {
    dir: process.env.ANALYSIS_LOG_DIR,
    enabled: process.env.ANALYSIS_LOG_ENABLED,
    images: process.env.ANALYSIS_LOG_INCLUDE_IMAGES,
  };
  process.env.ANALYSIS_LOG_DIR = dir;
  try {
    return await run(dir);
  } finally {
    process.env.ANALYSIS_LOG_ENABLED = previous.enabled;
    process.env.ANALYSIS_LOG_INCLUDE_IMAGES = previous.images;
    process.env.ANALYSIS_LOG_DIR = previous.dir;
    await rm(dir, { recursive: true, force: true });
  }
}

test("logging is disabled unless explicitly enabled", async () => {
  await withLogDir(async () => {
    process.env.ANALYSIS_LOG_ENABLED = "false";
    const result = await logAnalysis({
      analysis: { dimensions: { outerDiameter: 20 } },
      consent: true,
    });
    assert.equal(result.logged, false);
    assert.equal(result.reason, "disabled");
    assert.equal(analysisLogConfig().enabled, false);
  });
});

test("logging requires explicit consent", async () => {
  await withLogDir(async () => {
    process.env.ANALYSIS_LOG_ENABLED = "true";
    const result = await logAnalysis({
      analysis: { dimensions: { outerDiameter: 20 } },
      consent: false,
    });
    assert.equal(result.logged, false);
    assert.equal(result.reason, "no_consent");
  });
});

test("consented records store dimensions, hashes and no raw photos", async () => {
  await withLogDir(async (dir) => {
    process.env.ANALYSIS_LOG_ENABLED = "true";
    process.env.ANALYSIS_LOG_INCLUDE_IMAGES = "false";

    const result = await logAnalysis({
      images: [{ mimeType: "image/png", data: PNG_BASE64 }],
      reference: { outerDiameter: 20 },
      analysis: {
        componentType: "gear",
        dimensions: { outerDiameter: 20.4, teeth: 24, bogus: "x" },
        dimensionSources: { outerDiameter: "user" },
        anchorDimension: "outerDiameter",
      },
      corrections: { outerDiameter: 20.0, ignored: "x" },
      consent: true,
    });

    assert.equal(result.logged, true);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const text = await readFile(path.join(dir, files[0]), "utf8");
    assert.ok(!text.includes(PNG_BASE64));
    const record = JSON.parse(text.trim());
    assert.equal(record.analysis.dimensions.outerDiameter, 20.4);
    assert.equal(record.analysis.dimensions.bogus, undefined);
    assert.equal(record.userCorrections.outerDiameter, 20.0);
    assert.equal(record.userCorrections.ignored, undefined);
    assert.equal(record.images[0].mimeType, "image/png");
    assert.match(record.images[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(record.consent, true);
  });
});

test("retention pruning removes expired daily log files", async () => {
  await withLogDir(async (dir) => {
    process.env.ANALYSIS_LOG_ENABLED = "true";
    process.env.ANALYSIS_LOG_RETENTION_DAYS = "30";
    const oldFile = path.join(dir, "2000-01-01.jsonl");
    await writeFile(oldFile, "{}\n", "utf8");
    const old = new Date("2000-01-02T00:00:00Z");
    await utimes(oldFile, old, old);

    await logAnalysis({ analysis: { dimensions: {} }, consent: true });

    const files = await readdir(dir);
    assert.ok(!files.includes("2000-01-01.jsonl"));
    assert.ok(files.some((name) => name.endsWith(".jsonl")));
    delete process.env.ANALYSIS_LOG_RETENTION_DAYS;
  });
});
