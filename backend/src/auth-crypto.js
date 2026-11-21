import argon2 from "argon2";
import crypto from "node:crypto";

/**
 * Hashes a plaintext password using Argon2id.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Verifies a plaintext password against an Argon2id hash.
 * @param {string} hash
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Generates a high-entropy random session token.
 * @returns {string} 32-byte hex token (64 characters)
 */
export function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes a session token with SHA-256 for secure database storage.
 * @param {string} token
 * @returns {string}
 */
export function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
