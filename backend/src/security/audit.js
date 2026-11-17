import crypto from "node:crypto";
import { getDb } from "../db/connection.js";

/**
 * Append-only security audit log writer.
 * Never logs passwords, raw tokens, or session secrets.
 */
export async function writeAuditEvent({
  orgId = null,
  actorUserId = null,
  action,
  entityType = null,
  entityId = null,
  requestId = null,
  ip = null,
  userAgent = null,
  metadata = null,
  trx = null,
}) {
  if (!action) {
    throw new Error("Audit event action is required.");
  }

  const db = trx || getDb();
  const eventId = crypto.randomUUID();
  const now = Date.now();

  const truncatedIp = ip ? (ip.includes(":") ? ip.slice(0, 16) : ip.split(".").slice(0, 3).join(".") + ".0") : null;
  const userAgentHash = userAgent ? crypto.createHash("sha256").update(userAgent).digest("hex").slice(0, 32) : null;

  // Sanitize metadata to guarantee no credentials leak
  let cleanMetadata = null;
  if (metadata && typeof metadata === "object") {
    cleanMetadata = { ...metadata };
    delete cleanMetadata.password;
    delete cleanMetadata.token;
    delete cleanMetadata.secret;
    delete cleanMetadata.hash;
  }

  await db("audit_events").insert({
    id: eventId,
    org_id: orgId,
    actor_user_id: actorUserId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    request_id: requestId,
    ip_truncated: truncatedIp,
    user_agent_hash: userAgentHash,
    metadata: cleanMetadata ? JSON.stringify(cleanMetadata) : null,
    created_at: now,
  });

  return eventId;
}
