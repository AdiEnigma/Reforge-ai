import { getDb } from "../db/connection.js";

/**
 * Base Repository providing clean separation of database access from route handlers.
 * Kept intentionally portable for future PostgreSQL compatibility.
 */
export class BaseRepository {
  constructor(tableName, db = null) {
    this.tableName = tableName;
    this._db = db;
  }

  get db() {
    return this._db || getDb();
  }

  get query() {
    return this.db(this.tableName);
  }

  async findById(id) {
    return this.query.where({ id }).first();
  }

  async insert(record) {
    await this.query.insert(record);
    return record;
  }

  async update(id, updates) {
    const patch = { ...updates, updated_at: this.db.fn.now() };
    await this.query.where({ id }).update(patch);
    return this.findById(id);
  }

  async delete(id) {
    return this.query.where({ id }).del();
  }

  async list(filter = {}, limit = 100, offset = 0) {
    return this.query.where(filter).limit(limit).offset(offset);
  }
}
