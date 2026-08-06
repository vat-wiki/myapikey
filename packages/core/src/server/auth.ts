import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

/** Constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Extract the presented secret from any of the three headers an agent SDK might
 * send: Authorization: Bearer <pw>, x-api-key: <pw>, or HTTP Basic.
 * Returns null if no credential is present.
 */
export function extractSecret(c: Context): { password: string; username?: string } | null {
  const xKey = c.req.header("x-api-key");
  if (xKey) return { password: xKey };

  const auth = c.req.header("authorization") ?? "";
  const lower = auth.toLowerCase();
  if (lower.startsWith("bearer ")) return { password: auth.slice(7).trim() };
  if (lower.startsWith("basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx === -1) return null;
      return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Hono middleware: require the single account/password. */
export function authMiddleware(getUser: () => string, getPass: () => string): MiddlewareHandler {
  return async (c, next) => {
    const cred = extractSecret(c);
    const ok =
      !!cred &&
      (cred.username === undefined || safeEqual(cred.username, getUser())) &&
      safeEqual(cred.password, getPass());
    if (!ok) {
      return c.json(
        { error: { message: "invalid or missing credentials", type: "authentication_error" } },
        401,
      );
    }
    await next();
  };
}

/**
 * Hono middleware: require the API key (for /v1). Accepts Bearer / x-api-key
 * but NOT HTTP Basic — Basic carries account credentials, which are a separate
 * secret. extractSecret sets `username` only for Basic, so rejecting when it's
 * present keeps the account password off /v1.
 */
export function apiKeyMiddleware(getKey: () => string): MiddlewareHandler {
  return async (c, next) => {
    const cred = extractSecret(c);
    const ok =
      !!cred && cred.username === undefined && !!cred.password && safeEqual(cred.password, getKey());
    if (!ok) {
      return c.json(
        { error: { message: "invalid or missing api key", type: "authentication_error" } },
        401,
      );
    }
    await next();
  };
}
