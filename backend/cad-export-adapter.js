/**
 * cad-export-adapter.js
 * Runs the CadQuery/OpenCASCADE exporter (python-engine/exports/reconstruction_export.py)
 * so the Export Center downloads real B-Rep solids instead of fabricated text files.
 *
 * The interpreter is resolved from CAD_EXPORT_PYTHON, then the repo's .venv, then PATH.
 * A missing interpreter or CadQuery install surfaces as a 503 with an actionable message.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_ENGINE_DIR = path.resolve(__dirname, "../python-engine");
const EXPORT_SCRIPT = path.join(PYTHON_ENGINE_DIR, "exports", "reconstruction_export.py");
const TIMEOUT_MS = (Number(process.env.CAD_EXPORT_TIMEOUT_SECONDS) || 180) * 1000;

export const CAD_EXPORT_MIME_TYPES = {
  step: "application/step",
  iges: "application/iges",
  stl: "model/stl",
  obj: "model/obj",
};

function interpreterCandidates() {
  const candidates = [];
  const configured = process.env.CAD_EXPORT_PYTHON;
  if (configured) candidates.push(configured);
  candidates.push(path.resolve(__dirname, "../.venv/Scripts/python.exe"));
  candidates.push(path.resolve(__dirname, "../.venv/bin/python"));
  candidates.push("python3");
  candidates.push("python");
  return candidates;
}

/**
 * First usable Python interpreter: absolute paths must exist, bare names are
 * resolved by the OS (and reported as unavailable if spawning fails).
 */
export function resolveCadExportInterpreter() {
  for (const candidate of interpreterCandidates()) {
    const isPath = candidate.includes("/") || candidate.includes("\\");
    if (isPath) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return null;
}

export function isCadExportScriptPresent() {
  return existsSync(EXPORT_SCRIPT);
}

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function runExporter(python, payload) {
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(python, [EXPORT_SCRIPT], {
        cwd: PYTHON_ENGINE_DIR,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(fail(`Could not start the CAD exporter: ${error.message}`, 503));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore — the process may already have exited
      }
      finish(reject, fail("CAD export timed out while building the solid.", 504));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(
          reject,
          fail(
            "CAD export needs Python with CadQuery. Install the python-engine requirements (`pip install -r python-engine/requirements-cad.txt`) " +
              "into the repository .venv, or point CAD_EXPORT_PYTHON at an interpreter that has CadQuery.",
            503
          )
        );
        return;
      }
      finish(reject, fail(`CAD exporter could not run: ${error.message}`, 503));
    });

    child.on("close", () => {
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          parsed = JSON.parse(lines[i]);
          break;
        } catch {
          // keep looking for the JSON manifest line
        }
      }
      if (!parsed) {
        const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").trim();
        finish(
          reject,
          fail(
            detail
              ? `CAD exporter produced no result: ${detail}`
              : "CAD exporter produced no result.",
            500
          )
        );
        return;
      }
      if (!parsed.ok) {
        finish(
          reject,
          fail(parsed.error || "CAD export failed.", parsed.stage === "input" ? 400 : 500)
        );
        return;
      }
      finish(resolve, parsed);
    });

    child.stdin.on("error", () => {
      // the child may exit before reading stdin; the close handler reports it
    });
    child.stdin.end(body);
  });
}

/**
 * Build and export the reconstructed component.
 * Resolves with { path, filename, mimeType, bytes, manifest, cleanup }.
 */
export async function exportCadModel({ analysis, format, baseName }) {
  const mimeType = CAD_EXPORT_MIME_TYPES[format];
  if (!mimeType) {
    throw fail(`Unsupported CAD export format: ${format}`, 400);
  }
  if (!isCadExportScriptPresent()) {
    throw fail(
      "The CAD exporter script is missing (python-engine/exports/reconstruction_export.py).",
      503
    );
  }
  const python = resolveCadExportInterpreter();
  if (!python) {
    throw fail(
      "CAD export needs Python with CadQuery. Set CAD_EXPORT_PYTHON or install the python-engine requirements.",
      503
    );
  }

  const outDir = mkdtempSync(path.join(os.tmpdir(), "reforge-cad-"));
  const cleanup = () => {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      // best effort; the OS cleans the temp directory eventually
    }
  };

  try {
    const manifest = await runExporter(python, { analysis, format, outDir, baseName });
    return {
      path: manifest.path,
      filename: `${manifest.baseName || baseName}.${format}`,
      mimeType,
      bytes: manifest.bytes,
      manifest,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
