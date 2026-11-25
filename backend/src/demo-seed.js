import crypto from "node:crypto";
import { hashPassword } from "./auth-crypto.js";

/**
 * Predefined Fixed Demo Accounts for Development and Demonstrations.
 * Shared and public for demonstration purposes.
 */
export const DEMO_ACCOUNTS = [
  {
    username: "admin-001",
    displayName: "Admin Demo (Indus Valley)",
    email: "admin-001@reforge.local",
    password: "Admin123",
    role: "admin",
    orgName: "Indus Valley",
  },
  {
    username: "user-01",
    displayName: "Individual User 01",
    email: "user-01@reforge.local",
    password: "User123",
    role: "user",
    orgName: null,
  },
  {
    username: "user-02",
    displayName: "Individual User 02",
    email: "user-02@reforge.local",
    password: "User123",
    role: "user",
    orgName: null,
  },
];

/**
 * Checks whether demo accounts should be seeded.
 * Enabled by default in non-production environments.
 * Strictly disabled when NODE_ENV === 'production' unless explicitly enabled by DEV_DEMO_SEED === 'true' (not recommended in prod).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDemoSeedAllowed(env = process.env) {
  if (env.DISABLE_DEMO_SEED === "true") {
    return false;
  }
  if (env.NODE_ENV === "production" && env.ENABLE_PROD_DEMO_SEED !== "true") {
    return false;
  }
  return true;
}

/**
 * Idempotently seeds the 3 fixed demo accounts into the database and updates their passwords if needed.
 * Safely updates passwords for existing fixed demo accounts so that simplified demo passwords take effect.
 * Does not overwrite passwords for other registered users.
 * Does not duplicate entries on repeated runs.
 * @param {import('better-sqlite3').Database} db
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ seededCount: number, skippedCount: number, updatedCount: number, disabled: boolean }>}
 */
export async function seedDemoAccounts(db, env = process.env) {
  if (!isDemoSeedAllowed(env)) {
    return { seededCount: 0, skippedCount: 0, updatedCount: 0, disabled: true };
  }

  const findUserStmt = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?");
  const findOrgStmt = db.prepare("SELECT id FROM organizations WHERE name = ?");
  const insertOrgStmt = db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)");
  const insertUserStmt = db.prepare(`
    INSERT INTO users (id, username, email, display_name, password_hash, role, organization_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updatePasswordStmt = db.prepare("UPDATE users SET password_hash = ? WHERE username = ?");

  let seededCount = 0;
  let skippedCount = 0;
  let updatedCount = 0;

  for (const account of DEMO_ACCOUNTS) {
    const existing = findUserStmt.get(account.username);
    if (existing) {
      // Safely update password for the fixed demo account to ensure new credentials work
      const pHash = await hashPassword(account.password);
      updatePasswordStmt.run(pHash, account.username);
      updatedCount++;
      skippedCount++;
      continue;
    }

    let orgId = null;
    if (account.orgName) {
      let org = findOrgStmt.get(account.orgName);
      if (!org) {
        orgId = crypto.randomUUID();
        insertOrgStmt.run(orgId, account.orgName, Date.now());
      } else {
        orgId = org.id;
      }
    }

    const userId = crypto.randomUUID();
    const pHash = await hashPassword(account.password);

    insertUserStmt.run(
      userId,
      account.username,
      account.email,
      account.displayName,
      pHash,
      account.role,
      orgId,
      Date.now()
    );

    seededCount++;
  }

  return { seededCount, skippedCount, updatedCount, disabled: false };
}
