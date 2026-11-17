import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Validates and normalises backend environment variables.
 * Fails fast with clear actionable messages on critical configuration errors.
 */
export function validateEnv(env = process.env) {
  const errors = [];

  const nodeEnv = env.NODE_ENV || "development";
  const port = Number(env.PORT) || 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push(`PORT must be an integer between 1 and 65535. Received: ${env.PORT}`);
  }

  // Feature Flag: AUTH_ENFORCED defaults to false in P1/P2
  const authEnforced = env.AUTH_ENFORCED === "true";

  // Database location: default to backend/data/reforge.db
  const defaultDbDir = path.resolve(__dirname, "../data");
  const dbPath = env.DATABASE_PATH
    ? path.resolve(env.DATABASE_PATH)
    : path.join(defaultDbDir, "reforge.db");

  // Asset storage directory: default to backend/data/assets
  const assetStorageDir = env.ASSET_STORAGE_DIR
    ? path.resolve(env.ASSET_STORAGE_DIR)
    : path.join(defaultDbDir, "assets");

  // CORS origins
  const corsOriginsRaw = env.CORS_ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000";
  const corsAllowedOrigins = corsOriginsRaw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // P2: Authentication & Multi-Tenancy Configuration
  const signupMode = env.SIGNUP_MODE || "invite"; // 'invite' or 'open'
  if (!["invite", "open"].includes(signupMode)) {
    errors.push(`SIGNUP_MODE must be 'invite' or 'open'. Received: ${signupMode}`);
  }

  const appOrigin = env.APP_ORIGIN || "http://localhost:5173";

  // CSRF secret: In production, MUST be provided and at least 32 characters
  let csrfSecret = env.CSRF_SECRET;
  if (!csrfSecret) {
    if (nodeEnv === "production") {
      errors.push("CSRF_SECRET environment variable is mandatory in production (min 32 chars).");
    } else {
      csrfSecret = "dev-csrf-secret-key-32-characters-min-reforge-ai";
    }
  } else if (csrfSecret.length < 32) {
    errors.push("CSRF_SECRET must be at least 32 characters long.");
  }

  // Session timeouts (in milliseconds)
  const sessionIdleTimeoutMs = Number(env.SESSION_IDLE_TIMEOUT_MS) || 8 * 60 * 60 * 1000; // 8 hours sliding
  const sessionAbsoluteTimeoutMs = Number(env.SESSION_ABSOLUTE_TIMEOUT_MS) || 14 * 24 * 60 * 60 * 1000; // 14 days absolute

  // Cookie settings
  const cookieName = nodeEnv === "production" ? "__Host-rf_sid" : "rf_sid";
  const cookieSecure = nodeEnv === "production";

  // P3: Internal Service Communication Secret (X-Internal-Token)
  let internalToken = env.INTERNAL_TOKEN;
  if (!internalToken) {
    if (nodeEnv === "production") {
      errors.push("INTERNAL_TOKEN environment variable is mandatory in production (min 32 chars).");
    } else {
      internalToken = "dev-internal-token-32-chars-minimum-reforge-ai-secret";
    }
  } else if (internalToken.length < 32) {
    errors.push("INTERNAL_TOKEN must be at least 32 characters long.");
  }

  // P3: Quotas & Global Limits
  const geminiGlobalDailyCalls = Number(env.GEMINI_GLOBAL_DAILY_CALLS) || 5000;
  const quotaOrgGeminiAnalyzeDaily = Number(env.QUOTA_ORG_GEMINI_ANALYZE_DAILY) || 30;
  const quotaOrgGeminiChatDaily = Number(env.QUOTA_ORG_GEMINI_CHAT_DAILY) || 200;

  // Gemini API key: optional for starting (logged if missing)
  const geminiApiKey = env.GEMINI_API_KEY || "";
  const geminiModel = env.GEMINI_MODEL || "gemini-3.6-flash";

  // Vision adapter configuration
  const visionPipelineEnabled = env.VISION_PIPELINE_ENABLED === "true";
  const visionServiceUrl = env.VISION_SERVICE_URL || "http://127.0.0.1:8765";
  const visionFailOpen = env.VISION_FAIL_OPEN !== "false";
  const visionTimeoutSeconds = Number(env.VISION_REQUEST_TIMEOUT_SECONDS) || 60;

  // Reconstruction adapter configuration
  const reconstructionEnabled = env.RECONSTRUCTION_ENABLED === "true";
  const reconstructionServiceUrl = env.RECONSTRUCTION_SERVICE_URL || "http://127.0.0.1:8766";
  const reconstructionTimeoutSeconds = Number(env.RECONSTRUCTION_TIMEOUT_SECONDS) || 60;

  if (errors.length > 0) {
    const error = new Error(`Configuration validation failed:\n - ${errors.join("\n - ")}`);
    error.name = "ConfigValidationError";
    throw error;
  }

  return {
    nodeEnv,
    port,
    authEnforced,
    dbPath,
    assetStorageDir,
    corsAllowedOrigins,
    signupMode,
    appOrigin,
    csrfSecret,
    session: {
      idleTimeoutMs: sessionIdleTimeoutMs,
      absoluteTimeoutMs: sessionAbsoluteTimeoutMs,
      cookieName,
      cookieSecure,
    },
    internalToken,
    quotas: {
      globalDailyGeminiCalls: geminiGlobalDailyCalls,
      orgDailyAnalyze: quotaOrgGeminiAnalyzeDaily,
      orgDailyChat: quotaOrgGeminiChatDaily,
    },
    geminiApiKey,
    geminiModel,
    vision: {
      enabled: visionPipelineEnabled,
      url: visionServiceUrl,
      failOpen: visionFailOpen,
      timeoutSeconds: visionTimeoutSeconds,
    },
    reconstruction: {
      enabled: reconstructionEnabled,
      url: reconstructionServiceUrl,
      timeoutSeconds: reconstructionTimeoutSeconds,
    },
  };
}

let cachedConfig = null;

export function getConfig() {
  if (!cachedConfig) {
    cachedConfig = validateEnv();
  }
  return cachedConfig;
}

export function resetConfigForTest(newEnv) {
  cachedConfig = newEnv ? validateEnv(newEnv) : null;
  return cachedConfig;
}
