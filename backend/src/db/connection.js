import Database from "better-sqlite3";
import knex from "knex";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { getConfig } from "../config.js";

let dbInstance = null;
let knexInstance = null;

/**
 * Configure PRAGMAs on a newly opened better-sqlite3 connection:
 * - journal_mode = WAL
 * - synchronous = NORMAL
 * - busy_timeout = 5000
 * - foreign_keys = ON
 */
export function configureSqlitePragmas(rawDb) {
  rawDb.pragma("journal_mode = WAL");
  rawDb.pragma("synchronous = NORMAL");
  rawDb.pragma("busy_timeout = 5000");
  rawDb.pragma("foreign_keys = ON");

  // Verify foreign keys are enabled
  const result = rawDb.pragma("foreign_keys", { simple: true });
  if (result !== 1) {
    throw new Error("Critical DB integrity failure: PRAGMA foreign_keys is not enabled (expected 1, got " + result + ")");
  }
}

/**
 * Creates or retrieves the singleton Knex instance backed by better-sqlite3.
 * Configured with required PRAGMAs and startup assertions.
 */
export function getDb(customConfig = null) {
  if (knexInstance && !customConfig) {
    return knexInstance;
  }

  const config = customConfig || getConfig();
  const dbPath = config.dbPath;

  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const kx = knex({
    client: "better-sqlite3",
    connection: {
      filename: dbPath,
    },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn, done) => {
        try {
          configureSqlitePragmas(conn);
          done(null, conn);
        } catch (err) {
          done(err, conn);
        }
      },
    },
  });

  if (!customConfig) {
    knexInstance = kx;
  }
  return kx;
}

/**
 * Run startup assertion checking DB connection and foreign key enforcement.
 */
export async function assertDatabaseConnection(kx = null) {
  const db = kx || getDb();
  const fkRow = await db.raw("PRAGMA foreign_keys");
  const fkVal = Array.isArray(fkRow) ? Object.values(fkRow[0])[0] : (fkRow ? Object.values(fkRow)[0] : null);

  if (Number(fkVal) !== 1) {
    throw new Error(`Database connection assertion failed: PRAGMA foreign_keys returned ${fkVal}, expected 1.`);
  }

  const walRow = await db.raw("PRAGMA journal_mode");
  const walVal = Array.isArray(walRow) ? Object.values(walRow[0])[0] : (walRow ? Object.values(walRow)[0] : null);

  return {
    ok: true,
    foreignKeys: fkVal,
    journalMode: walVal,
  };
}

/**
 * Runs PRAGMA foreign_key_check to verify relational integrity.
 */
export async function checkForeignKeys(kx = null) {
  const db = kx || getDb();
  const rows = await db.raw("PRAGMA foreign_key_check");
  return rows || [];
}

/**
 * Closes the database connection (primarily for testing).
 */
export async function closeDb() {
  if (knexInstance) {
    await knexInstance.destroy();
    knexInstance = null;
  }
  dbInstance = null;
}
