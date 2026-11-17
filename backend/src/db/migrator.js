import { getDb } from "./connection.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(kx = null) {
  const db = kx || getDb();
  const [batchNo, log] = await db.migrate.latest({
    directory: path.join(__dirname, "migrations"),
    tableName: "knex_migrations",
  });
  return { batchNo, log };
}

export async function rollbackMigrations(kx = null) {
  const db = kx || getDb();
  const [batchNo, log] = await db.migrate.rollback({
    directory: path.join(__dirname, "migrations"),
    tableName: "knex_migrations",
  });
  return { batchNo, log };
}
