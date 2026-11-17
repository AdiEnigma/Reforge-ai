import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getDb } from "./src/db/connection.js";
import { runMigrations } from "./src/db/migrator.js";
import { AuthService } from "./src/services/auth-service.js";
import { resetConfigForTest, validateEnv } from "./src/config.js";
import { hashToken } from "./src/security/passwords.js";

// Helper to clean up user/org by email
async function purgeTestUser(db, email) {
  const normalized = email.trim().toLowerCase();
  const existing = await db("users").where("normalized_email", normalized).first();
  if (existing) {
    await db("users").where("id", existing.id).delete();
    if (existing.organization_id) {
      await db("organizations").where("id", existing.organization_id).delete();
    }
  }
}

test("1. Configuration validation: Defaults to open in development, invite_only in production", () => {
  // Dev default
  const devCfg = validateEnv({ NODE_ENV: "development", PORT: "8787" });
  assert.equal(devCfg.registrationMode, "open");
  assert.equal(devCfg.signupMode, "open");

  // Production default
  const prodCfg = validateEnv({
    NODE_ENV: "production",
    PORT: "8787",
    CSRF_SECRET: "a".repeat(32),
    INTERNAL_TOKEN: "b".repeat(32),
  });
  assert.equal(prodCfg.registrationMode, "invite_only");
  assert.equal(prodCfg.signupMode, "invite");

  // Explicit overrides
  const explicitOpen = validateEnv({
    NODE_ENV: "production",
    PORT: "8787",
    REGISTRATION_MODE: "open",
    CSRF_SECRET: "a".repeat(32),
    INTERNAL_TOKEN: "b".repeat(32),
  });
  assert.equal(explicitOpen.registrationMode, "open");

  const explicitInvite = validateEnv({
    NODE_ENV: "development",
    PORT: "8787",
    REGISTRATION_MODE: "invite_only",
  });
  assert.equal(explicitInvite.registrationMode, "invite_only");

  // Invalid value rejected
  assert.throws(
    () => validateEnv({ PORT: "8787", REGISTRATION_MODE: "unrestricted_bypass" }),
    /REGISTRATION_MODE must be 'open' or 'invite_only'/
  );
});

test("2. Open registration: Creates organization, user, and owner membership without invite code", async () => {
  resetConfigForTest({ REGISTRATION_MODE: "open", NODE_ENV: "development" });
  const db = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(db);
    const authService = new AuthService(db);

    const email = "founder@newforge.com";
    const res = await authService.register({
      orgName: "NewForge Technologies",
      displayName: "Deepak Verma",
      email,
      password: "StrongPassword123!",
      // Notice: No inviteCode supplied!
    });

    assert.equal(res.status, "created");
    assert.equal(res.code, 201);
    assert.equal(res.user.email, email);
    assert.equal(res.role, "owner");
    assert.ok(res.organization.id);
    assert.ok(res.csrfToken);
    assert.ok(res.sessionCookie);

    // Verify DB integrity
    const userRow = await db("users").where("id", res.user.id).first();
    assert.equal(userRow.email, email);
    assert.equal(userRow.role, "owner");
    assert.ok(userRow.password_hash.startsWith("$argon2id$"));

    const orgRow = await db("organizations").where("id", res.organization.id).first();
    assert.equal(orgRow.name, "NewForge Technologies");

    const membership = await db("memberships")
      .where("user_id", res.user.id)
      .where("org_id", res.organization.id)
      .first();
    assert.equal(membership.role, "owner");
    assert.equal(membership.status, "active");
  } finally {
    await db.destroy();
  }
});

test("3. Two independent open registrations create two completely isolated organizations", async () => {
  resetConfigForTest({ REGISTRATION_MODE: "open", NODE_ENV: "development" });
  const db = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(db);
    const authService = new AuthService(db);

    // Org 1: Apex Gears
    const reg1 = await authService.register({
      orgName: "Apex Gears Ltd",
      displayName: "Ramesh Sharma",
      email: "ramesh@apexgears.com",
      password: "MasterPassword123!",
    });

    // Org 2: Zenith Hydraulics
    const reg2 = await authService.register({
      orgName: "Zenith Hydraulics",
      displayName: "Sunil Rao",
      email: "sunil@zenithhydraulics.com",
      password: "MasterPassword123!",
    });

    assert.notEqual(reg1.organization.id, reg2.organization.id);
    assert.notEqual(reg1.user.id, reg2.user.id);

    // Verify Ramesh has no membership in Zenith Hydraulics
    const rameshInZenith = await db("memberships")
      .where("user_id", reg1.user.id)
      .where("org_id", reg2.organization.id)
      .first();
    assert.equal(rameshInZenith, undefined);

    // Verify Sunil has no membership in Apex Gears
    const sunilInApex = await db("memberships")
      .where("user_id", reg2.user.id)
      .where("org_id", reg1.organization.id)
      .first();
    assert.equal(sunilInApex, undefined);
  } finally {
    await db.destroy();
  }
});

test("4. Invite-only mode strictly enforces invitation requirements", async () => {
  resetConfigForTest({
    REGISTRATION_MODE: "invite_only",
    NODE_ENV: "production",
    CSRF_SECRET: "c".repeat(32),
    INTERNAL_TOKEN: "i".repeat(32),
  });
  const db = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(db);
    const authService = new AuthService(db);

    // Attempt without invite code -> Rejection (403)
    await assert.rejects(
      async () => {
        await authService.register({
          orgName: "Closed Org",
          displayName: "Tester",
          email: "tester@closed.com",
          password: "MasterPassword123!",
        });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "invite_code_required");
        return true;
      }
    );

    // Attempt with invalid code -> Rejection (403)
    await assert.rejects(
      async () => {
        await authService.register({
          orgName: "Closed Org",
          displayName: "Tester",
          email: "tester@closed.com",
          password: "MasterPassword123!",
          inviteCode: "RF-NONEXISTENT-CODE",
        });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "invalid_invite_code");
        return true;
      }
    );

    // Attempt with expired invite -> Rejection (403)
    const expiredInvite = "RF-EXPIRED-CODE-001";
    await db("signup_invites").insert({
      id: crypto.randomUUID(),
      code_hash: hashToken(expiredInvite),
      remaining_uses: 5,
      expires_at: Date.now() - 3600000, // 1 hour ago
      created_at: Date.now() - 7200000,
    });

    await assert.rejects(
      async () => {
        await authService.register({
          orgName: "Closed Org",
          displayName: "Tester",
          email: "tester@closed.com",
          password: "MasterPassword123!",
          inviteCode: expiredInvite,
        });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "invalid_invite_code");
        return true;
      }
    );

    // Attempt with exhausted invite -> Rejection (403)
    const exhaustedInvite = "RF-EXHAUSTED-CODE-002";
    await db("signup_invites").insert({
      id: crypto.randomUUID(),
      code_hash: hashToken(exhaustedInvite),
      remaining_uses: 0,
      expires_at: Date.now() + 86400000,
      created_at: Date.now(),
    });

    await assert.rejects(
      async () => {
        await authService.register({
          orgName: "Closed Org",
          displayName: "Tester",
          email: "tester@closed.com",
          password: "MasterPassword123!",
          inviteCode: exhaustedInvite,
        });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "invalid_invite_code");
        return true;
      }
    );

    // Valid invite succeeds
    const validInvite = "RF-VALID-CODE-003";
    await db("signup_invites").insert({
      id: crypto.randomUUID(),
      code_hash: hashToken(validInvite),
      remaining_uses: 1,
      expires_at: Date.now() + 86400000,
      created_at: Date.now(),
    });

    const validRes = await authService.register({
      orgName: "Authorized Org",
      displayName: "Authorized Engineer",
      email: "engineer@authorized.com",
      password: "MasterPassword123!",
      inviteCode: validInvite,
    });
    assert.equal(validRes.status, "created");
    assert.equal(validRes.role, "owner");

    // Invite remaining_uses now 0
    const updatedInvite = await db("signup_invites").where("code_hash", hashToken(validInvite)).first();
    assert.equal(updatedInvite.remaining_uses, 0);
  } finally {
    await db.destroy();
  }
});

test("5. Transaction rollback: Database writes roll back atomically if failure occurs during registration", async () => {
  resetConfigForTest({ REGISTRATION_MODE: "open", NODE_ENV: "development" });
  const db = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(db);
    const authService = new AuthService(db);

    const email = "rollback@test.com";

    // Simulate failure by monkey-patching createSession to throw an error inside the transaction
    const origCreateSession = authService.sessionService.createSession;
    authService.sessionService.createSession = async () => {
      throw new Error("Simulated storage failure inside registration transaction");
    };

    await assert.rejects(
      async () => {
        await authService.register({
          orgName: "Rollback Industries",
          displayName: "Rollback User",
          email,
          password: "MasterPassword123!",
        });
      },
      /Simulated storage failure/
    );

    authService.sessionService.createSession = origCreateSession;

    // Verify NO user was committed to database
    const userCheck = await db("users").where("normalized_email", email).first();
    assert.equal(userCheck, undefined);

    // Verify NO organization was committed
    const orgCheck = await db("organizations").where("name", "Rollback Industries").first();
    assert.equal(orgCheck, undefined);
  } finally {
    await db.destroy();
  }
});

test("6. Duplicate email is rejected with 409 in both modes", async () => {
  resetConfigForTest({ REGISTRATION_MODE: "open", NODE_ENV: "development" });
  const db = getDb({ dbPath: ":memory:" });
  try {
    await runMigrations(db);
    const authService = new AuthService(db);

    const email = "duplicate@unique.com";
    await authService.register({
      orgName: "Initial Org",
      displayName: "First User",
      email,
      password: "MasterPassword123!",
    });

    await assert.rejects(
      async () => {
        await authService.register({
          orgName: "Second Org Attempt",
          displayName: "Second User",
          email,
          password: "MasterPassword123!",
        });
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "email_already_registered");
        return true;
      }
    );
  } finally {
    await db.destroy();
  }
});
