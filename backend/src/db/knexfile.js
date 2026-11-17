import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = getConfig();

export default {
  client: "better-sqlite3",
  connection: {
    filename: config.dbPath,
  },
  useNullAsDefault: true,
  migrations: {
    directory: path.join(__dirname, "migrations"),
    tableName: "knex_migrations",
  },
};
