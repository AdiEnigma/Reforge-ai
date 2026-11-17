import crypto from "node:crypto";
import { getDb } from "../db/connection.js";
import { getConfig } from "../config.js";
import { generateSecureToken, hashToken, truncateIp, hashUserAgent } from "../security/passwords.js";

/**
 * Session Service
 * Manages server-side opaque sessions, token hashing, sliding idle timeouts,
 * and absolute lifetimes.
 */
export class SessionService {
  constructor(db = null) {
    this.db = db || getDb();
  }

  /**
   * Creates a new session in the database.
   * Returns { session, rawToken } so the caller can send rawToken in cookie.
   */
  async createSession({ userId, activeOrgId, ip = null, userAgent = null, trx = null }) {
    const config = getConfig();
    const db = trx || this.db;

    const sessionId = crypto.randomUUID();
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);

    const now = Date.now();
    const idleExpiresAt = now + config.session.idleTimeoutMs;
    const absoluteExpiresAt = now + config.session.absoluteTimeoutMs;

    const truncatedIp = truncateIp(ip);
    const uaHash = hashUserAgent(userAgent);

    const sessionRecord = {
      id: sessionId,
      token_hash: tokenHash,
      user_id: userId,
      active_org_id: activeOrgId,
      created_at: now,
      last_seen_at: now,
      idle_expires_at: idleExpiresAt,
      absolute_expires_at: absoluteExpiresAt,
      revoked_at: null,
      revoked_reason: null,
      ip_truncated: truncatedIp,
      user_agent_hash: uaHash,
    };

    await db("sessions").insert(sessionRecord);

    return { session: sessionRecord, rawToken };
  }

  /**
   * Authenticates and loads a session from a raw token.
   * Re-reads user status and membership from DB.
   */
  async getSessionByRawToken(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return null;

    const tokenHash = hashToken(rawToken);
    const now = Date.now();

    // Join session with user and active membership
    const row = await this.db("sessions")
      .join("users", "sessions.user_id", "users.id")
      .join("memberships", function () {
        this.on("memberships.user_id", "=", "sessions.user_id")
            .andOn("memberships.org_id", "=", "sessions.active_org_id");
      })
      .join("organizations", "organizations.id", "sessions.active_org_id")
      .where("sessions.token_hash", tokenHash)
      .select(
        "sessions.id as session_id",
        "sessions.token_hash",
        "sessions.user_id",
        "sessions.active_org_id",
        "sessions.created_at as session_created_at",
        "sessions.last_seen_at",
        "sessions.idle_expires_at",
        "sessions.absolute_expires_at",
        "sessions.revoked_at",
        "sessions.revoked_reason",
        "users.email",
        "users.normalized_email",
        "users.display_email",
        "users.display_name",
        "users.is_active",
        "users.email_verified_at",
        "memberships.role",
        "memberships.status as membership_status",
        "organizations.name as org_name",
        "organizations.slug as org_slug"
      )
      .first();

    if (!row) return null;

    // Check revocation
    if (row.revoked_at) {
      return { status: "revoked", reason: row.revoked_reason };
    }

    // Check user & membership active
    if (!row.is_active || row.membership_status !== "active") {
      return { status: "inactive" };
    }

    // Check expiration
    if (now > row.idle_expires_at || now > row.absolute_expires_at) {
      return { status: "expired" };
    }

    // Slide idle timeout and update last_seen_at if more than 5 minutes elapsed
    const config = getConfig();
    if (now - row.last_seen_at > 5 * 60 * 1000) {
      const newIdleExpiry = now + config.session.idleTimeoutMs;
      await this.db("sessions")
        .where("id", row.session_id)
        .update({
          last_seen_at: now,
          idle_expires_at: newIdleExpiry,
        });
    }

    return {
      status: "valid",
      session: {
        id: row.session_id,
        userId: row.user_id,
        activeOrgId: row.active_org_id,
        createdAt: row.session_created_at,
        lastSeenAt: row.last_seen_at,
        idleExpiresAt: row.idle_expires_at,
        absoluteExpiresAt: row.absolute_expires_at,
      },
      user: {
        id: row.user_id,
        email: row.email,
        displayEmail: row.display_email,
        displayName: row.display_name,
        isEmailVerified: Boolean(row.email_verified_at),
      },
      organization: {
        id: row.active_org_id,
        name: row.org_name,
        slug: row.org_slug,
      },
      role: row.role,
    };
  }

  /**
   * Revokes a specific session.
   */
  async revokeSession(sessionId, reason = "logout", trx = null) {
    const db = trx || this.db;
    const now = Date.now();
    await db("sessions")
      .where("id", sessionId)
      .update({
        revoked_at: now,
        revoked_reason: reason,
      });
  }

  /**
   * Revokes all sessions for a user (e.g. password reset).
   */
  async revokeAllUserSessions(userId, reason = "password_reset", exceptSessionId = null, trx = null) {
    const db = trx || this.db;
    const now = Date.now();
    const query = db("sessions")
      .where("user_id", userId)
      .whereNull("revoked_at")
      .update({
        revoked_at: now,
        revoked_reason: reason,
      });

    if (exceptSessionId) {
      query.whereNot("id", exceptSessionId);
    }

    await query;
  }
}
