import helmet from "helmet";
import cors from "cors";
import { getConfig } from "./config.js";
import { AppError } from "./errors.js";

/**
 * Configure Helmet with practical policies that protect HTTP headers
 * without breaking Three.js canvas renders, local asset fetches, or data URIs.
 */
export function configureHelmet() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Needed for Vite dev & dynamic workers
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "http:", "https:", "ws:", "wss:"],
      },
    },
    crossOriginEmbedderPolicy: false, // Prevent breaking external 3D font / blob loaders
  });
}

/**
 * Configure CORS using strict allowlist from configuration.
 * Allows requests with no origin (e.g. mobile apps, curl, server-to-server) or from allowed origins.
 */
export function configureCors() {
  const config = getConfig();
  const allowed = new Set(config.corsAllowedOrigins);

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server, curl, same-origin)
      if (!origin) {
        return callback(null, true);
      }
      if (allowed.has(origin)) {
        return callback(null, true);
      }
      const err = new AppError(
        "cors_origin_rejected",
        `CORS policy does not allow access from origin: ${origin}`,
        403
      );
      callback(err);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    credentials: false, // P1 does not use cross-origin credentials yet
  });
}
