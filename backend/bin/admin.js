#!/usr/bin/env node
import crypto from "node:crypto";
import { getDb } from "../src/db/connection.js";
import { hashPassword, hashToken, generateSecureToken } from "../src/security/passwords.js";
import { ROLES, validateRole } from "../src/security/policy.js";
import { SessionService } from "../src/services/session-service.js";
import { writeAuditEvent } from "../src/security/audit.js";

const [,, command, ...args] = process.argv;

async function inviteCreate(uses = 1, days = 7) {
  const db = getDb();
  const rawCode = `RF-${generateSecureToken(16).toUpperCase()}`;
  const codeHash = hashToken(rawCode);
  const now = Date.now();
  const expiresAt = now + days * 24 * 60 * 60 * 1000;

  await db("signup_invites").insert({
    id: crypto.randomUUID(),
    code_hash: codeHash,
    remaining_uses: Number(uses) || 1,
    expires_at: expiresAt,
    created_at: now,
  });

  console.log("\n=======================================================");
  console.log("       REFORGE AI SIGNUP INVITATION CREATED            ");
  console.log("=======================================================");
  console.log(`Invite Code (One-Time Output):  ${rawCode}`);
  console.log(`Remaining Uses:                ${uses}`);
  console.log(`Expires At:                    ${new Date(expiresAt).toISOString()}`);
  console.log("=======================================================\n");
}

async function memberAdd(orgSlug, email, role = "engineer") {
  const db = getDb();
  validateRole(role);

  const org = await db("organizations").where("slug", orgSlug).orWhere("id", orgSlug).first();
  if (!org) {
    throw new Error(`Organization not found for identifier: ${orgSlug}`);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await db("users").where("normalized_email", normalizedEmail).first();
  if (!user) {
    throw new Error(`User not found for email: ${email}. The user must register first.`);
  }

  const now = Date.now();
  await db("memberships")
    .insert({
      org_id: org.id,
      user_id: user.id,
      role,
      status: "active",
      created_at: now,
      updated_at: now,
    })
    .onConflict(["org_id", "user_id"])
    .merge({
      role,
      status: "active",
      updated_at: now,
    });

  await writeAuditEvent({
    orgId: org.id,
    actorUserId: null,
    action: "admin.member_added",
    entityType: "membership",
    entityId: `${org.id}:${user.id}`,
    metadata: { role, email: normalizedEmail },
  });

  console.log(`Successfully added/updated membership for ${email} in org '${org.name}' with role '${role}'.`);
}

async function userResetPassword(email, newPassword) {
  const db = getDb();
  const sessions = new SessionService(db);
  const normalizedEmail = email.trim().toLowerCase();

  const user = await db("users").where("normalized_email", normalizedEmail).first();
  if (!user) {
    throw new Error(`User not found for email: ${email}`);
  }

  const passwordHash = await hashPassword(newPassword);
  const now = Date.now();

  await db.transaction(async (trx) => {
    await trx("users")
      .where("id", user.id)
      .update({
        password_hash: passwordHash,
        failed_login_count: 0,
        updated_at: now,
      });

    // Revoke all sessions
    await sessions.revokeAllUserSessions(user.id, "admin_cli_password_reset", null, trx);

    await writeAuditEvent({
      orgId: user.organization_id,
      action: "admin.password_reset",
      entityType: "user",
      entityId: user.id,
      metadata: { targetEmail: normalizedEmail },
      trx,
    });
  });

  console.log(`Successfully reset password for user ${email}. All active sessions have been revoked.`);
}

async function main() {
  try {
    switch (command) {
      case "invite:create":
        await inviteCreate(args[0] || 1, args[1] || 7);
        break;
      case "member:add":
        if (!args[0] || !args[1]) {
          console.error("Usage: npm run admin -- member:add <orgSlugOrId> <email> [role]");
          process.exit(1);
        }
        await memberAdd(args[0], args[1], args[2] || "engineer");
        break;
      case "user:reset-password":
        if (!args[0] || !args[1]) {
          console.error("Usage: npm run admin -- user:reset-password <email> <newPassword>");
          process.exit(1);
        }
        await userResetPassword(args[0], args[1]);
        break;
      default:
        console.log("ReForge AI Admin CLI. Commands available:\n - invite:create [uses] [validDays]\n - member:add <orgSlugOrId> <email> [role]\n - user:reset-password <email> <newPassword>");
        break;
    }
    process.exit(0);
  } catch (err) {
    console.error("CLI Error:", err.message);
    process.exit(1);
  }
}

main();
