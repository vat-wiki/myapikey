import { Hono, type Context, type MiddlewareHandler } from "hono";
import { trimBase } from "../shared/config";
import type { Format, Provider } from "../shared/types";
import type { Store } from "./store";

/** HTTP statuses that should trigger failover to the next provider. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Headers copied from upstream back to the client. */
const COPY_DOWN = ["content-type", "cache-control", "x-request-id", "openai-organization", "anthropic-ratelimit-requests-reset"];

/** Resolve the ordered, format-compatible provider list for a model. */
function candidates(store: Store, model: string, format: Format): Provider[] {
  const d = store.get();
  const entry = d.models[model];
  if (!entry || !entry.enabled) return [];
  const byId = new Map(d.providers.map((p) => [p.id, p]));
  return entry.providers
    .map((id) => byId.get(id))
    .filter((p): p is Provider => !!p && p.formats.includes(format));
}

function notFound(c: Context, model: string) {
  return c.json(
    {
      error: {
        message: `model '${model}' is not available (not enabled or no provider speaks this format)`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    },
    404,
  );
}

function upstreamHeaders(provider: Provider, format: Format, clientVersion?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (format === "openai") h.authorization = `Bearer ${provider.apiKey}`;
  else {
    h["x-api-key"] = provider.apiKey;
    h["anthropic-version"] = clientVersion || "2023-06-01";
  }
  return h;
}

function passThrough(upstream: Response): Response {
  const headers = new Headers();
  for (const h of COPY_DOWN) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Stream the upstream body straight through (handles SSE + normal JSON).
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function proxyApi(store: Store, auth: MiddlewareHandler): Hono {
  const app = new Hono();
  app.use("*", auth);

  /** Shared dispatch with failover. format selects the upstream path + auth scheme. */
  const dispatch = async (c: Context, format: Format) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.model !== "string") {
      return c.json({ error: { message: "request body must be JSON with a 'model' field", type: "invalid_request_error" } }, 400);
    }
    const model: string = body.model;
    const list = candidates(store, model, format);
    if (!list.length) return notFound(c, model);

    const path = format === "openai" ? "chat/completions" : "messages";
    const clientVersion = c.req.header("anthropic-version") ?? undefined;
    let lastStatus = 502;

    for (const provider of list) {
      let upstream: Response;
      try {
        upstream = await fetch(`${trimBase(provider.baseUrl)}/${path}`, {
          method: "POST",
          headers: upstreamHeaders(provider, format, clientVersion),
          body: JSON.stringify(body),
        });
      } catch {
        // Network error / DNS / timeout → try next provider.
        lastStatus = 502;
        continue;
      }

      if (upstream.ok) {
        store.pushLog({ ts: Date.now(), model, provider: provider.name, format, status: upstream.status, bytesOut: 0 });
        return passThrough(upstream);
      }
      if (RETRYABLE.has(upstream.status)) {
        lastStatus = upstream.status;
        // Drain so the connection can be reused, then move on.
        await upstream.text().catch(() => undefined);
        continue;
      }
      // Non-retryable client error: return it to the caller as-is.
      store.pushLog({ ts: Date.now(), model, provider: provider.name, format, status: upstream.status, bytesOut: 0 });
      return passThrough(upstream);
    }

    store.pushLog({ ts: Date.now(), model, provider: list[list.length - 1].name, format, status: lastStatus, bytesOut: 0 });
    return c.json(
      { error: { message: `all providers for '${model}' failed (last status ${lastStatus})`, type: "upstream_error" } },
      502,
    );
  };

  app.post("/chat/completions", (c) => dispatch(c, "openai"));
  app.post("/messages", (c) => dispatch(c, "anthropic"));

  // OpenAI-style model list of everything enabled (agents call .list()).
  app.get("/models", (c) => {
    const d = store.get();
    const byId = new Map(d.providers.map((p) => [p.id, p]));
    const data = Object.entries(d.models)
      .filter(([, e]) => e.enabled)
      .map(([id]) => ({
        id,
        object: "model",
        created: 0,
        owned_by: (byId.get(d.models[id].providers[0] ?? "")?.name) || "my-ai-gate",
      }));
    return c.json({ object: "list", data });
  });

  return app;
}
