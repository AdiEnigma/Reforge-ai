import argon2 from "argon2";
import crypto from "node:crypto";

/**
 * Argon2id parameters matching plan requirements:
 * - memory: at least 19 MiB (19 * 1024 KiB)
 * - iterations: 2
 * - parallelism: 1
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

// Cached dummy hash generated at startup to defend against timing attacks for unknown emails
let dummyHash = null;

export async function initPasswordSecurity() {
  if (!dummyHash) {
    dummyHash = await argon2.hash("dummy-constant-time-placeholder-password", ARGON2_OPTIONS);
  }
}

export function validatePasswordPolicy(password, email = "") {
  if (typeof password !== "string") {
    throw new Error("Password must be a string.");
  }
  if (password.length < 10) {
    throw new Error("Password must be at least 10 characters long.");
  }
  if (password.length > 128) {
    throw new Error("Password cannot exceed 128 characters.");
  }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    throw new Error("Password must not be the same as your email address.");
  }
}

export async function hashPassword(password) {
  validatePasswordPolicy(password);
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash, plainPassword) {
  if (!storedHash) {
    // Perform dummy verify to mitigate timing attacks
    if (!dummyHash) await initPasswordSecurity();
    await argon2.verify(dummyHash, plainPassword).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(storedHash, plainPassword);
  } catch {
    return false;
  }
}

export async function verifyDummyPassword(plainPassword) {
  if (!dummyHash) await initPasswordSecurity();
  try {
    await argon2.verify(dummyHash, plainPassword);
  } catch {
    // Ignored
  }
  return false;
}

export function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateCsrfToken(csrfSecret, sessionId) {
  return crypto.createHmac("sha256", csrfSecret).update(sessionId).digest("hex");
}

export function verifyCsrfToken(csrfSecret, sessionId, providedToken) {
  if (!sessionId || !providedToken) return false;
  const expected = generateCsrfToken(csrfSecret, sessionId);
  return constantTimeEquals(expected, providedToken);
}

export function truncateIp(ip) {
  if (!ip || typeof ip !== "string") return "unknown";
  if (ip.includes(":")) {
    // IPv6: keep first 3 segments
    const parts = ip.split(":");
    return parts.slice(0, 3).join(":") + "::/48";
  }
  // IPv4: keep first 3 octets
  const parts = ip.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return ip;
}

export function hashUserAgent(ua) {
  if (!ua || typeof ua !== "string") return "unknown";
  return crypto.createHash("sha256").update(ua).digest("hex").slice(0, 32);
}
