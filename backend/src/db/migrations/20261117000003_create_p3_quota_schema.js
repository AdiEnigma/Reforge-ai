/**
 * Migration 003: P3 Daily Quota Counters Schema
 *
 * Tracks per-organization, per-action daily usage in UTC epoch days.
 * Enables atomic UPSERT with atomic increment and limit validation.
 */

export async function up(knex) {
  await knex.schema.createTable("daily_quotas", (table) => {
    table.string("org_id", 64).notNullable().references("id").inTable("organizations").onDelete("CASCADE");
    table.string("action", 64).notNullable(); // 'gemini_analyze', 'gemini_chat', 'export_job'
    table.integer("epoch_day").notNullable(); // Math.floor(Date.now() / 86400000)
    table.integer("count").notNullable().defaultTo(0);
    table.bigInteger("updated_at").notNullable();
    table.primary(["org_id", "action", "epoch_day"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("daily_quotas");
}
