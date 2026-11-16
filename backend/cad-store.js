/**
 * cad-store.js
 * Server-side staging and allowlist for generated CAD artefacts.
 *
 * Python returns absolute paths on its own filesystem. Those are copied into a
 * per-job directory under backend/var/cad so only vetted files are ever served
 * to clients. Filenames in the public URL are resolved through an in-memory
 * allowlist, never by concatenating user input into a path.
 */
import { randomBytes } from "node:crypto";
import { mkdir, copyFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JOB_TTL_MS =
  (Number(process.env.CAD_JOB_TTL_HOURS) || 24) * 60 * 60 * 1000;
const MAX_STEP_BYTES = 100 * 1024 * 1024;
const MAX_STL_BYTES = 200 * 1024 * 1024;
const MAX_MESH_BYTES = 100 * 1024 * 1024;

const jobs = new Map();
const filesIndex = new Map();

export function cadRoot() {
  return path.resolve(
    process.env.CAD_STORE_DIR || path.join(__dirname, "var", "cad")
  );
}

export function newJobId() {
  return randomBytes(16).toString("hex");
}

function maxBytesFor(kind) {
  if (kind === "step") return MAX_STEP_BYTES;
  if (kind === "stl") return MAX_STL_BYTES;
  return MAX_MESH_BYTES;
}

function publicName(jobId, kind) {
  return kind === "mesh"
    ? `${jobId}-model.mesh.json`
    : `${jobId}-model.${kind}`;
}

async function copyIfUsable(sourcePath, destination, kind) {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) return false;
  let info;
  try {
    info = await stat(sourcePath);
  } catch {
    return false;
  }
  if (!info.isFile() || info.size <= 0 || info.size > maxBytesFor(kind)) {
    return false;
  }
  await copyFile(sourcePath, destination);
  return true;
}

/**
 * Copy the requested artefacts into a fresh job directory and register the
 * resulting public filenames. Missing files are skipped (mesh preview is
 * optional). Returns the public file map, e.g. { step, stl, mesh }.
 */
export async function stageCadOutputs({
  jobId,
  stepPath,
  stlPath,
  meshPath,
  includeStep = true,
  includeStl = true,
  includeMesh = true,
}) {
  const directory = path.join(cadRoot(), jobId);
  await mkdir(directory, { recursive: true });

  const sources = {
    step: includeStep ? stepPath : null,
    stl: includeStl ? stlPath : null,
    mesh: includeMesh ? meshPath : null,
  };

  const files = {};
  for (const [kind, sourcePath] of Object.entries(sources)) {
    if (!sourcePath) continue;
    const name = publicName(jobId, kind);
    const destination = path.join(directory, name);
    try {
      if (await copyIfUsable(sourcePath, destination, kind)) {
        files[kind] = `/api/cad/files/${name}`;
        filesIndex.set(name, { jobId, kind });
      }
    } catch (error) {
      console.warn(`[cad-store] Failed to stage ${kind} artefact:`, error.message);
    }
  }

  jobs.set(jobId, { createdAt: Date.now(), directory, files });
  return files;
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (Date.now() - job.createdAt > JOB_TTL_MS) return null;
  return job;
}

/**
 * Resolve an allowlisted filename to a filesystem path + artefact kind.
 * Returns null when the filename is unknown, the job expired, or the file no
 * longer exists inside the staged job directory.
 */
export function resolveCadFile(filename) {
  const entry = filesIndex.get(filename);
  if (!entry) return null;
  const job = getJob(entry.jobId);
  if (!job) {
    filesIndex.delete(filename);
    return null;
  }
  const resolved = path.resolve(job.directory, filename);
  const relative = path.relative(job.directory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return { path: resolved, kind: entry.kind, jobId: entry.jobId };
}

export async function cleanupExpiredJobs(now = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (now - job.createdAt <= JOB_TTL_MS) continue;
    jobs.delete(jobId);
    for (const name of Object.keys(job.files)) {
      const publicPath = job.files[name];
      const filename = publicPath.split("/").pop();
      if (filename) filesIndex.delete(filename);
    }
    try {
      await rm(job.directory, { recursive: true, force: true });
    } catch (error) {
      console.warn("[cad-store] Failed to remove expired job directory:", error.message);
    }
  }
}

setInterval(() => {
  cleanupExpiredJobs().catch(() => {});
}, 10 * 60 * 1000).unref();
