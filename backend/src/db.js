import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbInstance = null;

/**
 * Returns the configured database file path.
 * Defaults to backend/data/demo-app.db, or uses process.env.DEMO_DB_PATH (e.g. for testing).
 * Never overwrites or touches the committed backend/data/reforge.db.
 */
export function getDbPath() {
  if (process.env.DEMO_DB_PATH) {
    return path.resolve(process.env.DEMO_DB_PATH);
  }
  const defaultDir = path.resolve(__dirname, "../data");
  return path.join(defaultDir, "demo-app.db");
}

/**
 * Returns the storage directory root for workbench files (images, exports).
 */
export function getStorageRoot() {
  if (process.env.WORKBENCH_STORAGE_DIR) {
    return path.resolve(process.env.WORKBENCH_STORAGE_DIR);
  }
  return path.resolve(__dirname, "../data/workbenches");
}

/**
 * Initializes and returns the SQLite database instance.
 * @param {string} [customPath] Optional custom database file path or ':memory:'
 * @returns {import('better-sqlite3').Database}
 */
export function getDb(customPath) {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const targetPath = customPath || getDbPath();

  if (targetPath !== ":memory:") {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(targetPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);

  if (!customPath) {
    dbInstance = db;
  }
  return db;
}

/**
 * Creates the required demo authentication schema.
 * @param {import('better-sqlite3').Database} db
 */
export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      organization_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS workbenches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      name TEXT NOT NULL,
      component_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS workbench_snapshots (
      id TEXT PRIMARY KEY,
      workbench_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT 1,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workbench_id) REFERENCES workbenches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workbench_assets (
      id TEXT PRIMARY KEY,
      workbench_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workbench_id) REFERENCES workbenches(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workbenches_user_id ON workbenches(user_id);
    CREATE INDEX IF NOT EXISTS idx_workbenches_updated_at ON workbenches(updated_at);
    CREATE INDEX IF NOT EXISTS idx_workbench_snapshots_wb_id ON workbench_snapshots(workbench_id);
    CREATE INDEX IF NOT EXISTS idx_workbench_assets_wb_id ON workbench_assets(workbench_id);
  `);
}

/**
 * Closes the active database connection (useful for tests and shutdowns).
 */
export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore already closed errors
    }
    dbInstance = null;
  }
}
