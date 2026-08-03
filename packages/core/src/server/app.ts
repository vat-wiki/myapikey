import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { authMiddleware } from "./auth";
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

  const auth = authMiddleware(
    () => store.get().account.username,
    () => store.get().account.password,
  );

  // Both /v1 (proxy) and /admin (config) require the single account/password.
  // Auth is applied inside each sub-app (must be registered before routes).
  const v1 = proxyApi(store, auth);
  const admin = adminApi(store, auth);

  app.route("/v1", v1);
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
        "my-ai-gate is running. Web UI not built — run `npm run build:web`. API at /v1 (proxy) and /admin (config).",
        404,
      ),
    );
  }

  return app;
}
