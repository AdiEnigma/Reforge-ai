/**
 * reconstruction-photos.js
 * Validates and stages inline (base64) photos so the Python reconstruction
 * service can read them from disk. The reconstruction service only accepts
 * server-side paths, never raw base64.
 */
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const MAX_RECONSTRUCTION_PHOTOS = 8;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const EXTENSION_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function reconstructionImageRoot() {
  const configured = process.env.RECONSTRUCTION_IMAGE_ROOT;
  return path.resolve(configured || path.join(os.tmpdir(), "reforge-recon-images"));
}

function decodePhoto(photo, index) {
  if (!photo || typeof photo !== "object" || typeof photo.data !== "string") {
    throw httpError(`Photo ${index} must be an object with base64 'data'.`, 400);
  }
  const mimeType = String(photo.mimeType || "").toLowerCase();
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) {
    throw httpError(
      `Photo ${index} has unsupported type '${mimeType || "unknown"}'. Use PNG, JPEG, WEBP or BMP.`,
      400
    );
  }
  const base64 = photo.data.replace(/^data:[^;]+;base64,/, "");
  if (!base64) throw httpError(`Photo ${index} is empty.`, 400);
  if (base64.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8) {
    throw httpError(`Photo ${index} exceeds the 8 MB limit.`, 413);
  }
  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    throw httpError(`Photo ${index} is not valid base64 data.`, 400);
  }
  if (!buffer.length) throw httpError(`Photo ${index} is empty.`, 400);
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw httpError(`Photo ${index} exceeds the 8 MB limit.`, 413);
  }
  return { buffer, extension };
}

/**
 * Decode inline photos and write them under RECONSTRUCTION_IMAGE_ROOT.
 * Returns absolute file paths (empty when no photos are supplied).
 */
export async function stageReconstructionPhotos(photos, jobId) {
  if (photos == null) return [];
  if (!Array.isArray(photos)) {
    throw httpError("'photos' must be an array.", 400);
  }
  if (photos.length > MAX_RECONSTRUCTION_PHOTOS) {
    throw httpError(`At most ${MAX_RECONSTRUCTION_PHOTOS} photos are supported.`, 413);
  }
  if (!photos.length) return [];

  const decoded = photos.map((photo, index) => decodePhoto(photo, index));
  const totalBytes = decoded.reduce((sum, item) => sum + item.buffer.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw httpError("Combined photo payload exceeds 40 MB.", 413);
  }

  const safeJob = /^[A-Za-z0-9_-]{1,64}$/.test(String(jobId || ""))
    ? String(jobId)
    : `recon_${Date.now()}`;
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const directory = path.join(reconstructionImageRoot(), safeJob, unique);
  await mkdir(directory, { recursive: true });

  const paths = [];
  for (let index = 0; index < decoded.length; index += 1) {
    const filePath = path.join(directory, `${index}.${decoded[index].extension}`);
    await writeFile(filePath, decoded[index].buffer, { flag: "wx" });
    paths.push(filePath);
  }
  return paths;
}
