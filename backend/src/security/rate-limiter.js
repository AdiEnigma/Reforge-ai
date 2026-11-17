import { AppError } from "../errors.js";

/**
 * In-memory sliding window rate limiter for single-process SQLite pilot.
 * Tracks attempts by key with TTL and emits standard Retry-After headers.
 */
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  /**
   * Consume points for a given key.
   * @param {string} key Identifier (e.g. `login:ip:127.0.0.1` or `email:user@example.com`)
   * @param {number} maxAttempts Max allowed points in window
   * @param {number} windowMs Window duration in milliseconds
   */
  consume(key, maxAttempts, windowMs) {
    const now = Date.now();
    let record = this.buckets.get(key);

    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      this.buckets.set(key, record);
      return { allowed: true, remaining: maxAttempts - 1, retryAfterSec: 0 };
    }

    if (record.count >= maxAttempts) {
      const retryAfterSec = Math.ceil((record.resetTime - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, retryAfterSec) };
    }

    record.count += 1;
    return { allowed: true, remaining: maxAttempts - record.count, retryAfterSec: 0 };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  clear() {
    this.buckets.clear();
  }
}

export const rateLimiter = new RateLimiter();

/**
 * Middleware factory for rate limiting with AppError response
 */
export function createRateLimiterMiddleware({ keyGenerator, maxAttempts, windowMs, errorCode = "rate_limit_exceeded", message = "Too many requests. Please try again later." }) {
  return (req, res, next) => {
    const key = keyGenerator(req);
    const result = rateLimiter.consume(key, maxAttempts, windowMs);

    if (!result.allowed) {
      res.setHeader("Retry-After", result.retryAfterSec);
      return next(new AppError(errorCode, message, 429, { retryAfter: result.retryAfterSec }));
    }

    next();
  };
}
