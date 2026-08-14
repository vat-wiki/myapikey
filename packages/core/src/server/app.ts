import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { authMiddleware, apiKeyMiddleware } from "./auth";
import { adminApi } from "./admin";
import { proxyApi } from "./proxy";
import type { Store } from "./store";

export interface AppOptions {
  /** Absolute path to a built web dist dir (optional). */
  webDir?: string;
}

export function createApp(store: Store, opts: AppOptions = {}): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, version: "0.1.0" }));

  // Runtime log (console + server.log): auth failures, unhandled errors.
  const logger = store.getLogger();
  app.onError((err, c) => {
    logger.error(`unhandled error on ${c.req.method} ${c.req.path}: ${err.stack ?? String(err)}`);
    return c.json({ error: { message: "internal error", type: "server_error" } }, 500);
  });

  // Two independent secrets: the account password admins /admin (Basic), the
  // API key gates /v1 (Bearer / x-api-key). Neither works on the other's surface.
  const accountAuth = authMiddleware(
    () => store.get().account.username,
    () => store.get().account.password,
    logger,
  );
  const apiKeyAuth = apiKeyMiddleware(() => store.get().apiKey, logger);

  // Both sub-apps require auth, applied inside each sub-app (before routes).
  // Two agent surfaces, each with its own /models: /openai/v1 (openai family)
  // and /anthropic/v1 (anthropic family). Both gate on the same API key.
  const { openai, anthropic } = proxyApi(store, apiKeyAuth);
  const admin = adminApi(store, accountAuth, openai, anthropic);

  app.route("/openai/v1", openai);
  app.route("/anthropic/v1", anthropic);
  app.route("/admin", admin);

  // Unmatched paths under an API prefix answer JSON 404 — NOT the SPA's
  // index.html. A misconfigured client (e.g. a doubled /v1 segment) then gets a
  // parseable error instead of HTML that only blows up later in its JSON parser
  // as "Unexpected token '<'" (this bit pi's model refresh once).
  const apiMiss = (c: Context) =>
    c.json({ error: { message: `no such endpoint: ${c.req.method} ${c.req.path}`, type: "invalid_request_error" } }, 404);
  app.all("/openai/*", apiMiss);
  app.all("/anthropic/*", apiMiss);
  app.all("/admin/*", apiMiss);
  // Legacy pre-0.12 surface: gone since the split — point the caller at the two
  // current surfaces instead of a bare 404.
  app.all("/v1/*", (c) =>
    c.json({ error: { message: "the /v1 surface was split in v0.12.0 — use /openai/v1 or /anthropic/v1", type: "invalid_request_error" } }, 404));

  // Web UI: serve built SPA when available.
  if (opts.webDir && existsSync(opts.webDir)) {
    app.use("/*", serveStatic({ root: opts.webDir }));
    app.get("*", async (c) => {
      try {
        return c.html(await readFile(`${opts.webDir}/index.html`, "utf8"));
      } catch {
        return c.notFound();
      }
    });
  } else {
    app.get("*", (c) =>
      c.text(
        "MyAPIKey is running. Web UI not built — run `npm run build:web`. API at /openai/v1 + /anthropic/v1 (proxy) and /admin (config).",
        404,
      ),
    );
  }

  return app;
}
