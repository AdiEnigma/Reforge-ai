/**
 * Migration 002: P2 Authentication & Multi-Tenant Schema
 *
 * Tables:
 * - memberships (Composite PK org_id, user_id; role: owner, admin, engineer, viewer)
 * - sessions (Opaque server-side sessions with SHA-256 hashed tokens)
 * - auth_tokens (Purpose: verify_email, reset_password, invite; SHA-256 hashed)
 * - signup_invites (Hashed invite codes with usage tracking)
 * - audit_events (Immutable append-only security & auth audit log)
 *
 * Safe forward updates to users table:
 * - normalized_email, display_email, display_name, email_verified_at,
 *   failed_login_count, last_login_at
 */

export async function up(knex) {
  // 1. Upgrade users table with P2 fields
  await knex.schema.alterTable("users", (table) => {
    table.string("normalized_email", 255);
    table.string("display_email", 255);
    table.string("display_name", 255);
    table.bigInteger("email_verified_at");
    table.integer("failed_login_count").defaultTo(0).notNullable();
    table.bigInteger("last_login_at");
  });

  // Populate normalized_email from email for existing records
  await knex("users").update({
    normalized_email: knex.ref("email"),
    display_email: knex.ref("email"),
    display_name: knex.ref("email"),
  });

  // 2. Memberships table
  await knex.schema.createTable("memberships", (table) => {
    table.string("org_id", 64).notNullable().references("id").inTable("organizations").onDelete("CASCADE");
    table.string("user_id", 64).notNullable().references("id").inTable("users").onDelete("CASCADE");
    table.string("role", 32).notNullable(); // 'owner', 'admin', 'engineer', 'viewer'
    table.string("status", 32).notNullable().defaultTo("active"); // 'active', 'suspended', 'invited'
    table.bigInteger("created_at").notNullable();
    table.bigInteger("updated_at").notNullable();
    table.primary(["org_id", "user_id"]);
  });

  // 3. Sessions table
  await knex.schema.createTable("sessions", (table) => {
    table.string("id", 64).primary();
    table.string("token_hash", 64).notNullable().unique();
    table.string("user_id", 64).notNullable().references("id").inTable("users").onDelete("CASCADE");
    table.string("active_org_id", 64).notNullable().references("id").inTable("organizations").onDelete("CASCADE");
    table.bigInteger("created_at").notNullable();
    table.bigInteger("last_seen_at").notNullable();
    table.bigInteger("idle_expires_at").notNullable();
    table.bigInteger("absolute_expires_at").notNullable();
    table.bigInteger("revoked_at");
    table.string("revoked_reason", 64);
    table.string("ip_truncated", 64);
    table.string("user_agent_hash", 64);
    table.foreign(["active_org_id", "user_id"]).references(["org_id", "user_id"]).inTable("memberships").onDelete("CASCADE");
  });

  // 4. Authentication tokens (verify_email, reset_password, invite)
  await knex.schema.createTable("auth_tokens", (table) => {
    table.string("id", 64).primary();
    table.string("token_hash", 64).notNullable().unique();
    table.string("purpose", 32).notNullable(); // 'verify_email', 'reset_password', 'invite'
    table.string("user_id", 64).references("id").inTable("users").onDelete("CASCADE");
    table.string("org_id", 64).references("id").inTable("organizations").onDelete("CASCADE");
    table.string("role", 32);
    table.bigInteger("expires_at").notNullable();
    table.bigInteger("used_at");
    table.bigInteger("created_at").notNullable();
  });

  // 5. Signup invites
  await knex.schema.createTable("signup_invites", (table) => {
    table.string("id", 64).primary();
    table.string("code_hash", 64).notNullable().unique();
    table.integer("remaining_uses").notNullable().defaultTo(1);
    table.bigInteger("expires_at").notNullable();
    table.bigInteger("created_at").notNullable();
  });

  // 6. Audit events (Append-only)
  await knex.schema.createTable("audit_events", (table) => {
    table.string("id", 64).primary();
    table.string("org_id", 64).references("id").inTable("organizations").onDelete("SET NULL");
    table.string("actor_user_id", 64).references("id").inTable("users").onDelete("SET NULL");
    table.string("action", 64).notNullable();
    table.string("entity_type", 64);
    table.string("entity_id", 64);
    table.string("request_id", 64);
    table.string("ip_truncated", 64);
    table.string("user_agent_hash", 64);
    table.json("metadata");
    table.bigInteger("created_at").notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("audit_events");
  await knex.schema.dropTableIfExists("signup_invites");
  await knex.schema.dropTableIfExists("auth_tokens");
  await knex.schema.dropTableIfExists("sessions");
  await knex.schema.dropTableIfExists("memberships");
  await knex.schema.alterTable("users", (table) => {
    table.dropColumn("normalized_email");
    table.dropColumn("display_email");
    table.dropColumn("display_name");
    table.dropColumn("email_verified_at");
    table.dropColumn("failed_login_count");
    table.dropColumn("last_login_at");
  });
}
