import { Hono } from "hono";
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

  // Two independent secrets: the account password admins /admin (Basic), the
  // API key gates /v1 (Bearer / x-api-key). Neither works on the other's surface.
  const accountAuth = authMiddleware(
    () => store.get().account.username,
    () => store.get().account.password,
  );
  const apiKeyAuth = apiKeyMiddleware(() => store.get().apiKey);

  // Both sub-apps require auth, applied inside each sub-app (before routes).
  // Two agent surfaces, each with its own /models: /openai/v1 (openai family)
  // and /anthropic/v1 (anthropic family). Both gate on the same API key.
  const { openai, anthropic } = proxyApi(store, apiKeyAuth);
  const admin = adminApi(store, accountAuth, openai, anthropic);

  app.route("/openai/v1", openai);
  app.route("/anthropic/v1", anthropic);
  app.route("/admin", admin);

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
