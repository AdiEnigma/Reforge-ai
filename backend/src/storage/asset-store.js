import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getConfig } from "../config.js";

/**
 * Controlled binary file store for images, CAD step/stl exports, and drawing artifacts.
 * - Stores binary data on disk (replaceable by S3 adapter later).
 * - Generates secure random UUID / content-addressed storage keys internally.
 * - Strictly prevents path traversal attacks by validating resolved storage paths.
 * - Atomic write via temporary file prevents partially written files on crash/failure.
 */
export class AssetStore {
  constructor(baseDir = null) {
    this.baseDir = baseDir || getConfig().assetStorageDir;
  }

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Validates and resolves a storage key to ensure it stays strictly inside baseDir.
   */
  resolvePath(storageKey) {
    if (typeof storageKey !== "string" || !/^[a-zA-Z0-9_\-\./]+$/.test(storageKey) || storageKey.includes("..")) {
      throw new Error(`Invalid storage key: path traversal rejected (${storageKey})`);
    }

    const resolved = path.resolve(this.baseDir, storageKey);
    const normalizedBase = path.resolve(this.baseDir);

    if (!resolved.startsWith(normalizedBase)) {
      throw new Error(`Security violation: storage key resolves outside base directory`);
    }
    return resolved;
  }

  /**
   * Stores a buffer safely using atomic write.
   * Generates a storage key if not provided: e.g. YYYY-MM/uuid.ext
   */
  async put(buffer, options = {}) {
    await this.init();

    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError("AssetStore.put requires a Buffer instance");
    }

    const ext = options.ext ? `.${options.ext.replace(/^\./, "")}` : "";
    const datePrefix = new Date().toISOString().slice(0, 7); // e.g. "2026-11"
    const randomKey = `${datePrefix}/${crypto.randomUUID()}${ext}`;
    const storageKey = options.key || randomKey;

    const targetPath = this.resolvePath(storageKey);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Atomic write via temp file
    const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, targetPath);

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    return {
      storageKey,
      sizeBytes: buffer.length,
      sha256,
    };
  }

  /**
   * Reads a stored asset by storage key.
   */
  async get(storageKey) {
    const targetPath = this.resolvePath(storageKey);
    return fs.readFile(targetPath);
  }

  /**
   * Checks if an asset exists in storage.
   */
  async exists(storageKey) {
    try {
      const targetPath = this.resolvePath(storageKey);
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes an asset from storage.
   */
  async delete(storageKey) {
    try {
      const targetPath = this.resolvePath(storageKey);
      await fs.unlink(targetPath);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }
}

let defaultAssetStore = null;

export function getAssetStore() {
  if (!defaultAssetStore) {
    defaultAssetStore = new AssetStore();
  }
  return defaultAssetStore;
}
