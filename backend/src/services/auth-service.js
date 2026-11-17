import crypto from "node:crypto";
import { getDb } from "../db/connection.js";
import { getConfig } from "../config.js";
import { AppError } from "../errors.js";
import {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
  validatePasswordPolicy,
  hashToken,
  generateSecureToken,
  generateCsrfToken,
} from "../security/passwords.js";
import { SessionService } from "./session-service.js";
import { writeAuditEvent } from "../security/audit.js";
import { getEmailSender } from "./email-sender.js";
import { ROLES } from "../security/policy.js";

/**
 * Authentication Service
 * Implements registration, login, logout, password recovery, verification.
 */
export class AuthService {
  constructor(db = null, sessionService = null, emailSender = null) {
    this.db = db || getDb();
    this.sessionService = sessionService || new SessionService(this.db);
    this.emailSender = emailSender || getEmailSender();
  }

  /**
   * Register a new user and organization.
   */
  async register({
    orgName,
    displayName,
    email,
    password,
    city = null,
    industry = null,
    inviteCode = null,
    ip = null,
    userAgent = null,
    requestId = null,
  }) {
    const config = getConfig();

    if (!email || typeof email !== "string" || !email.includes("@")) {
      throw new AppError("validation_error", "A valid email address is required.", 400);
    }
    if (!password) {
      throw new AppError("validation_error", "Password is required.", 400);
    }
    if (!displayName || typeof displayName !== "string") {
      throw new AppError("validation_error", "Display name is required.", 400);
    }
    if (!orgName || typeof orgName !== "string") {
      throw new AppError("validation_error", "Organization name is required.", 400);
    }

    validatePasswordPolicy(password, email);
    const normalizedEmail = email.trim().toLowerCase();

    // Check invite code if signup mode is invite
    if (config.signupMode === "invite") {
      if (!inviteCode || typeof inviteCode !== "string") {
        throw new AppError("invite_code_required", "Registration requires a valid invitation code.", 403);
      }

      const codeHash = hashToken(inviteCode.trim());
      const now = Date.now();
      const invite = await this.db("signup_invites")
        .where("code_hash", codeHash)
        .where("expires_at", ">", now)
        .where("remaining_uses", ">", 0)
        .first();

      if (!invite) {
        throw new AppError("invalid_invite_code", "The invitation code is invalid, expired, or fully used.", 403);
      }
    }

    // Check if email already exists
    const existingUser = await this.db("users").where("normalized_email", normalizedEmail).first();
    if (existingUser) {
      if (config.signupMode === "open") {
        // Open mode: Return 202 without revealing if account exists
        return { status: "pending_verification", code: 202 };
      }
      throw new AppError("email_already_registered", "An account with this email address already exists.", 409);
    }

    const userId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const orgSlug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "org";
    const now = Date.now();
    const passwordHash = await hashPassword(password);

    // In invite mode: user is verified immediately. In open mode: unverified.
    const isVerified = config.signupMode === "invite";
    const verifiedAt = isVerified ? now : null;

    let sessionResult = null;

    await this.db.transaction(async (trx) => {
      // 1. Consume invite use if applicable
      if (config.signupMode === "invite" && inviteCode) {
        const codeHash = hashToken(inviteCode.trim());
        await trx("signup_invites")
          .where("code_hash", codeHash)
          .decrement("remaining_uses", 1);
      }

      // 2. Create Organization
      await trx("organizations").insert({
        id: orgId,
        name: orgName,
        slug: `${orgSlug}-${Date.now().toString().slice(-4)}`,
        created_at: now,
        updated_at: now,
      });

      // 3. Create User
      await trx("users").insert({
        id: userId,
        organization_id: orgId,
        email: email.trim(),
        normalized_email: normalizedEmail,
        display_email: email.trim(),
        display_name: displayName.trim(),
        password_hash: passwordHash,
        role: ROLES.OWNER,
        is_active: true,
        email_verified_at: verifiedAt,
        failed_login_count: 0,
        last_login_at: now,
        created_at: now,
        updated_at: now,
      });

      // 4. Create Owner Membership
      await trx("memberships").insert({
        org_id: orgId,
        user_id: userId,
        role: ROLES.OWNER,
        status: "active",
        created_at: now,
        updated_at: now,
      });

      // 5. If verified (invite mode), establish session
      if (isVerified) {
        sessionResult = await this.sessionService.createSession({
          userId,
          activeOrgId: orgId,
          ip,
          userAgent,
          trx,
        });
      } else {
        // Create verification token
        const rawToken = generateSecureToken(32);
        const tokenHash = hashToken(rawToken);
        await trx("auth_tokens").insert({
          id: crypto.randomUUID(),
          token_hash: tokenHash,
          purpose: "verify_email",
          user_id: userId,
          org_id: orgId,
          role: ROLES.OWNER,
          expires_at: now + 24 * 60 * 60 * 1000,
          used_at: null,
          created_at: now,
        });

        await this.emailSender.send({
          to: email.trim(),
          subject: "Verify your ReForge AI account",
          template: "verify_email",
          data: { token: rawToken, displayName },
        });
      }

      // 6. Audit event
      await writeAuditEvent({
        orgId,
        actorUserId: userId,
        action: "auth.register",
        entityType: "user",
        entityId: userId,
        requestId,
        ip,
        userAgent,
        metadata: { orgName, signupMode: config.signupMode },
        trx,
      });
    });

    if (config.signupMode === "open") {
      return { status: "pending_verification", code: 202 };
    }

    const csrfToken = generateCsrfToken(config.csrfSecret, sessionResult.session.id);

    return {
      status: "created",
      code: 201,
      user: {
        id: userId,
        email: email.trim(),
        displayName: displayName.trim(),
        isEmailVerified: true,
      },
      organization: {
        id: orgId,
        name: orgName,
      },
      role: ROLES.OWNER,
      csrfToken,
      sessionCookie: {
        name: config.session.cookieName,
        value: sessionResult.rawToken,
        options: {
          httpOnly: true,
          secure: config.session.cookieSecure,
          sameSite: "lax",
          path: "/",
          maxAge: config.session.absoluteTimeoutMs,
        },
      },
    };
  }

  /**
   * Log in user with email and password.
   */
  async login({ email, password, ip = null, userAgent = null, requestId = null, existingSessionId = null }) {
    const config = getConfig();

    if (!email || !password) {
      throw new AppError("invalid_credentials", "Invalid email or password.", 401);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.db("users").where("normalized_email", normalizedEmail).first();

    if (!user) {
      // Mitigate account enumeration via timing
      await verifyDummyPassword(password);
      await writeAuditEvent({
        action: "auth.login_failed",
        requestId,
        ip,
        userAgent,
        metadata: { reason: "unknown_user" },
      });
      throw new AppError("invalid_credentials", "Invalid email or password.", 401);
    }

    if (!user.is_active) {
      await verifyDummyPassword(password);
      await writeAuditEvent({
        action: "auth.login_failed",
        actorUserId: user.id,
        requestId,
        ip,
        userAgent,
        metadata: { reason: "user_disabled" },
      });
      throw new AppError("invalid_credentials", "Invalid email or password.", 401);
    }

    const isValid = await verifyPassword(user.password_hash, password);
    if (!isValid) {
      await this.db("users")
        .where("id", user.id)
        .increment("failed_login_count", 1);

      await writeAuditEvent({
        action: "auth.login_failed",
        actorUserId: user.id,
        requestId,
        ip,
        userAgent,
        metadata: { reason: "bad_password" },
      });
      throw new AppError("invalid_credentials", "Invalid email or password.", 401);
    }

    // Check open mode email verification
    if (config.signupMode === "open" && !user.email_verified_at) {
      throw new AppError("email_not_verified", "Your email address has not been verified.", 403);
    }

    // Get active membership
    const membership = await this.db("memberships")
      .join("organizations", "organizations.id", "memberships.org_id")
      .where("memberships.user_id", user.id)
      .where("memberships.status", "active")
      .select("memberships.org_id", "memberships.role", "organizations.name as org_name")
      .first();

    if (!membership) {
      throw new AppError("no_active_organization", "User has no active organization membership.", 403);
    }

    const now = Date.now();

    // Revoke previous session if caller provided one
    if (existingSessionId) {
      await this.sessionService.revokeSession(existingSessionId, "login_replacement");
    }

    // Reset failed login count and update last login
    await this.db("users")
      .where("id", user.id)
      .update({
        failed_login_count: 0,
        last_login_at: now,
      });

    // Create session
    const { session, rawToken } = await this.sessionService.createSession({
      userId: user.id,
      activeOrgId: membership.org_id,
      ip,
      userAgent,
    });

    await writeAuditEvent({
      orgId: membership.org_id,
      actorUserId: user.id,
      action: "auth.login",
      entityType: "session",
      entityId: session.id,
      requestId,
      ip,
      userAgent,
    });

    const csrfToken = generateCsrfToken(config.csrfSecret, session.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isEmailVerified: Boolean(user.email_verified_at),
      },
      organization: {
        id: membership.org_id,
        name: membership.org_name,
      },
      role: membership.role,
      csrfToken,
      sessionCookie: {
        name: config.session.cookieName,
        value: rawToken,
        options: {
          httpOnly: true,
          secure: config.session.cookieSecure,
          sameSite: "lax",
          path: "/",
          maxAge: config.session.absoluteTimeoutMs,
        },
      },
    };
  }

  /**
   * Log out session.
   */
  async logout({ sessionId, userId = null, orgId = null, ip = null, userAgent = null, requestId = null }) {
    if (sessionId) {
      await this.sessionService.revokeSession(sessionId, "user_logout");
      await writeAuditEvent({
        orgId,
        actorUserId: userId,
        action: "auth.logout",
        entityType: "session",
        entityId: sessionId,
        requestId,
        ip,
        userAgent,
      });
    }
  }

  /**
   * Verify email with token.
   */
  async verifyEmail({ token, requestId = null }) {
    if (!token || typeof token !== "string") {
      throw new AppError("invalid_token", "Invalid or expired verification token.", 400);
    }

    const tokenHash = hashToken(token.trim());
    const now = Date.now();

    const record = await this.db("auth_tokens")
      .where("token_hash", tokenHash)
      .where("purpose", "verify_email")
      .whereNull("used_at")
      .where("expires_at", ">", now)
      .first();

    if (!record) {
      throw new AppError("invalid_token", "Invalid or expired verification token.", 400);
    }

    await this.db.transaction(async (trx) => {
      await trx("auth_tokens").where("id", record.id).update({ used_at: now });
      await trx("users").where("id", record.user_id).update({ email_verified_at: now });
      await writeAuditEvent({
        orgId: record.org_id,
        actorUserId: record.user_id,
        action: "auth.email_verified",
        entityType: "user",
        entityId: record.user_id,
        requestId,
        trx,
      });
    });
  }

  /**
   * Request password reset. Always returns 202 to avoid email enumeration.
   */
  async forgotPassword({ email, ip = null, userAgent = null, requestId = null }) {
    if (!email || typeof email !== "string") return;

    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.db("users").where("normalized_email", normalizedEmail).first();

    if (user && user.is_active) {
      const rawToken = generateSecureToken(32);
      const tokenHash = hashToken(rawToken);
      const now = Date.now();

      await this.db("auth_tokens").insert({
        id: crypto.randomUUID(),
        token_hash: tokenHash,
        purpose: "reset_password",
        user_id: user.id,
        org_id: user.organization_id,
        expires_at: now + 30 * 60 * 1000, // 30 minutes
        used_at: null,
        created_at: now,
      });

      await this.emailSender.send({
        to: user.email,
        subject: "Reset your ReForge AI password",
        template: "reset_password",
        data: { token: rawToken, displayName: user.display_name },
      });
    }

    await writeAuditEvent({
      action: "auth.forgot_password_requested",
      requestId,
      ip,
      userAgent,
      metadata: { requested: true },
    });
  }

  /**
   * Reset password with token. Revokes all existing user sessions.
   */
  async resetPassword({ token, newPassword, ip = null, userAgent = null, requestId = null }) {
    if (!token || typeof token !== "string") {
      throw new AppError("invalid_token", "Invalid or expired reset token.", 400);
    }
    validatePasswordPolicy(newPassword);

    const tokenHash = hashToken(token.trim());
    const now = Date.now();

    const record = await this.db("auth_tokens")
      .where("token_hash", tokenHash)
      .where("purpose", "reset_password")
      .whereNull("used_at")
      .where("expires_at", ">", now)
      .first();

    if (!record) {
      throw new AppError("invalid_token", "Invalid or expired reset token.", 400);
    }

    const passwordHash = await hashPassword(newPassword);

    await this.db.transaction(async (trx) => {
      await trx("auth_tokens").where("id", record.id).update({ used_at: now });
      await trx("users").where("id", record.user_id).update({
        password_hash: passwordHash,
        failed_login_count: 0,
        updated_at: now,
      });

      // Revoke ALL user sessions
      await this.sessionService.revokeAllUserSessions(record.user_id, "password_reset", null, trx);

      await writeAuditEvent({
        orgId: record.org_id,
        actorUserId: record.user_id,
        action: "auth.password_reset",
        entityType: "user",
        entityId: record.user_id,
        requestId,
        ip,
        userAgent,
        trx,
      });
    });
  }

  /**
   * Change password from an active session. Rotates current session and revokes others.
   */
  async changePassword({
    userId,
    currentSessionId,
    currentPassword,
    newPassword,
    ip = null,
    userAgent = null,
    requestId = null,
  }) {
    validatePasswordPolicy(newPassword);

    const user = await this.db("users").where("id", userId).first();
    if (!user) {
      throw new AppError("unauthenticated", "User not found.", 401);
    }

    const isValid = await verifyPassword(user.password_hash, currentPassword);
    if (!isValid) {
      throw new AppError("invalid_current_password", "Current password is incorrect.", 400);
    }

    const newHash = await hashPassword(newPassword);
    const now = Date.now();

    await this.db.transaction(async (trx) => {
      await trx("users").where("id", userId).update({
        password_hash: newHash,
        updated_at: now,
      });

      // Revoke all OTHER sessions
      await this.sessionService.revokeAllUserSessions(userId, "password_change_other_revocation", currentSessionId, trx);

      await writeAuditEvent({
        orgId: user.organization_id,
        actorUserId: userId,
        action: "auth.password_changed",
        entityType: "user",
        entityId: userId,
        requestId,
        ip,
        userAgent,
        trx,
      });
    });
  }
}
