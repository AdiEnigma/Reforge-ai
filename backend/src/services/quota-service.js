import { getDb } from "../db/connection.js";
import { getConfig } from "../config.js";
import { AppError } from "../errors.js";

/**
 * Service to manage atomic organization quotas and global Gemini limits.
 */
export class QuotaService {
  constructor(db = null) {
    this.db = db || getDb();
    this.globalGeminiCalls = new Map(); // epochDay -> count
  }

  getEpochDay(timestamp = Date.now()) {
    return Math.floor(timestamp / 86400000);
  }

  /**
   * Check and increment the global Gemini daily call counter in memory.
   * Throws 503 capacity if global capacity is exhausted.
   */
  checkAndIncrementGlobalGemini(maxLimit = null) {
    const config = getConfig();
    const limit = maxLimit !== null ? maxLimit : config.quotas.globalDailyGeminiCalls;
    const epochDay = this.getEpochDay();

    const current = this.globalGeminiCalls.get(epochDay) || 0;
    if (current >= limit) {
      throw new AppError("capacity_exceeded", "Service capacity temporarily reached. Please retry tomorrow or contact support.", 503, {
        retryAfter: 3600,
      });
    }

    this.globalGeminiCalls.set(epochDay, current + 1);
    return { epochDay, count: current + 1, limit };
  }

  /**
   * Atomically checks and increments an organization's daily quota counter in SQLite.
   * Concurrency-safe: SQLite single-writer guarantees atomic serial execution within transactions.
   *
   * @param {string} orgId Organization ID
   * @param {string} action Action key (e.g. 'gemini_analyze', 'gemini_chat')
   * @param {number} maxLimit Max allowed calls per epoch day
   */
  async consumeQuota(orgId, action, maxLimit) {
    if (!orgId) {
      throw new AppError("unauthenticated", "Organization context is required for quota tracking.", 401);
    }

    const epochDay = this.getEpochDay();
    const now = Date.now();

    return await this.db.transaction(async (trx) => {
      // Fetch current usage row with lock
      const row = await trx("daily_quotas")
        .where({ org_id: orgId, action, epoch_day: epochDay })
        .first();

      const currentCount = row ? row.count : 0;

      if (currentCount >= maxLimit) {
        throw new AppError("quota_exceeded", `Daily organization quota for ${action} has been reached.`, 429, {
          action,
          limit: maxLimit,
          current: currentCount,
        });
      }

      if (row) {
        await trx("daily_quotas")
          .where({ org_id: orgId, action, epoch_day: epochDay })
          .update({
            count: currentCount + 1,
            updated_at: now,
          });
      } else {
        await trx("daily_quotas").insert({
          org_id: orgId,
          action,
          epoch_day: epochDay,
          count: 1,
          updated_at: now,
        });
      }

      return {
        orgId,
        action,
        epochDay,
        used: currentCount + 1,
        limit: maxLimit,
        remaining: maxLimit - (currentCount + 1),
      };
    });
  }

  /**
   * Reset in-memory global counter (primarily for testing)
   */
  resetGlobalCounters() {
    this.globalGeminiCalls.clear();
  }
}

let quotaServiceInstance = null;

export function getQuotaService(db = null) {
  if (quotaServiceInstance && !db) {
    return quotaServiceInstance;
  }
  const svc = new QuotaService(db);
  if (!db) quotaServiceInstance = svc;
  return svc;
}
