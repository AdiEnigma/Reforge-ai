/**
 * job-store.js
 * In-memory job registry for the analyze -> CAD orchestration layer.
 *
 * Jobs expire after JOB_TTL_SECONDS (default 30 min) and the registry is
 * capped at JOB_MAX_ENTRIES (default 50). This is a single-process, local-dev
 * job layer; swap the Map for a durable store when deploying multi-instance.
 */
import { randomBytes } from "node:crypto";

const jobs = new Map();

export const JOB_STATES = Object.freeze([
  "queued",
  "analyzing",
  "generating_cad",
  "needs_input",
  "done",
  "failed",
  "unavailable",
]);

function ttlMs() {
  const seconds = Number(process.env.JOB_TTL_SECONDS) || 1800;
  return Math.max(seconds, 30) * 1000;
}

function maxEntries() {
  const value = Number(process.env.JOB_MAX_ENTRIES) || 50;
  return Math.max(1, Math.min(value, 1000));
}

function prune(now = Date.now()) {
  const cutoff = now - ttlMs();
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
  while (jobs.size > maxEntries()) {
    // Map preserves insertion order; drop the oldest first.
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

export function createJob(input = {}) {
  prune();
  const id = `job_${randomBytes(8).toString("hex")}`;
  const timestamp = Date.now();
  const job = {
    id,
    state: "queued",
    status: "queued",
    progress: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    input,
    analysis: null,
    warnings: [],
    needsInput: null,
    result: null,
    error: null,
    stage: null,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  if (typeof id !== "string") return null;
  prune();
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job || !patch || typeof patch !== "object") return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

/** Strip large inputs before returning a job over the API. */
export function serializeJob(job) {
  if (!job) return null;
  const { input, ...rest } = job;
  return { ...rest, input: input ? { reference: input.reference || {} } : null };
}

export function clearJobs() {
  jobs.clear();
}
