/**
 * Migration 001: Initial P1 Foundation Schema
 * Tables:
 * - organizations (Tenancy boundary)
 * - users (User accounts, org members)
 * - projects (Engineering work container)
 * - parts (Mechanical part definitions)
 * - part_versions (Parametric versions & recipe history)
 * - stored_assets (Binary asset metadata linked to AssetStore)
 */

export async function up(knex) {
  // 1. Organizations
  await knex.schema.createTable("organizations", (table) => {
    table.string("id", 64).primary();
    table.string("name", 255).notNullable();
    table.string("slug", 128).notNullable().unique();
    table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
    table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();
  });

  // 2. Users
  await knex.schema.createTable("users", (table) => {
    table.string("id", 64).primary();
    table.string("organization_id", 64).references("id").inTable("organizations").onDelete("CASCADE");
    table.string("email", 255).notNullable().unique();
    table.string("password_hash", 255);
    table.string("role", 32).notNullable().defaultTo("member"); // 'owner', 'admin', 'member'
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
    table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();
  });

  // 3. Projects
  await knex.schema.createTable("projects", (table) => {
    table.string("id", 64).primary();
    table.string("organization_id", 64).notNullable().references("id").inTable("organizations").onDelete("CASCADE");
    table.string("name", 255).notNullable();
    table.text("description");
    table.string("created_by", 64).references("id").inTable("users").onDelete("SET NULL");
    table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
    table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();
  });

  // 4. Parts
  await knex.schema.createTable("parts", (table) => {
    table.string("id", 64).primary();
    table.string("project_id", 64).notNullable().references("id").inTable("projects").onDelete("CASCADE");
    table.string("name", 255).notNullable();
    table.string("component_type", 64).defaultTo("other");
    table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
    table.timestamp("updated_at").defaultTo(knex.fn.now()).notNullable();
  });

  // 5. Part Versions
  await knex.schema.createTable("part_versions", (table) => {
    table.string("id", 64).primary();
    table.string("part_id", 64).notNullable().references("id").inTable("parts").onDelete("CASCADE");
    table.integer("version_number").notNullable();
    table.json("analysis").notNullable(); // Full normalised recipe & geometry data
    table.json("machinery_state"); // Assembly relationships & companions
    table.string("created_by", 64).references("id").inTable("users").onDelete("SET NULL");
    table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
    table.unique(["part_id", "version_number"]);
  });

  // 6. Stored Assets (Metadata for binary files stored by AssetStore)
  await knex.schema.createTable("stored_assets", (table) => {
    table.string("id", 64).primary();
    table.string("storage_key", 255).notNullable().unique();
    table.string("filename", 255).notNullable();
    table.string("mime_type", 128).notNullable();
    table.integer("size_bytes").notNullable();
    table.string("sha256", 64).notNullable();
    table.string("organization_id", 64).references("id").inTable("organizations").onDelete("CASCADE");
    table.timestamp("created_at").defaultTo(knex.fn.now()).notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("stored_assets");
  await knex.schema.dropTableIfExists("part_versions");
  await knex.schema.dropTableIfExists("parts");
  await knex.schema.dropTableIfExists("projects");
  await knex.schema.dropTableIfExists("users");
  await knex.schema.dropTableIfExists("organizations");
}
