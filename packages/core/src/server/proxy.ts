import { Hono, type Context, type MiddlewareHandler } from "hono";
import { trimBase } from "../shared/config";
import type { Format, Provider, RouteKey } from "../shared/types";
import type { Store } from "./store";

/** HTTP statuses that should trigger failover to the next provider. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Headers copied from upstream back to the client. */
const COPY_DOWN = ["content-type", "cache-control", "x-request-id", "openai-organization", "anthropic-ratelimit-requests-reset"];

/** Resolve the ordered, compatible provider list for a model on a routing slot. */
function candidates(store: Store, model: string, key: RouteKey): Provider[] {
  const d = store.get();
  const entry = d.models[model];
  const fe = entry?.[key];
  if (!fe?.enabled) return [];
  const byId = new Map(d.providers.map((p) => [p.id, p]));
  // Defense-in-depth: openai/anthropic require that wire format; responses
  // requires supportsResponses. (Admin keeps chains pure, but a provider's
  // formats/flag can be edited afterwards.)
  return fe.providers
    .map((id) => byId.get(id))
    .filter((p): p is Provider => {
      if (!p) return false;
      return key === "responses" ? !!p.supportsResponses : p.formats.includes(key);
    });
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

/** Resolve the upstream URL + wire format for a routing slot. The OpenAI base
 *  includes the version segment (we append the bare resource); the Anthropic
 *  base excludes /v1 (we append v1/messages). /responses reuses the OpenAI base. */
function upstreamTarget(p: Provider, key: RouteKey): { url: string; wire: Format } {
  if (key === "anthropic") {
    return { url: `${trimBase(p.baseUrlAnthropic)}/v1/messages`, wire: "anthropic" };
  }
  const path = key === "responses" ? "responses" : "chat/completions";
  return { url: `${trimBase(p.baseUrlOpenai)}/${path}`, wire: "openai" };
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

export interface ProbeResult {
  ok: boolean;
  status: number;
  provider?: string;
  format: RouteKey;
  error?: string;
}

/** First routing slot for which this model has at least one candidate provider. */
function probeFormat(store: Store, model: string): RouteKey | null {
  for (const key of ["openai", "anthropic", "responses"] as RouteKey[]) {
    if (candidates(store, model, key).length) return key;
  }
  return null;
}

/** Pull a short human-readable message out of an upstream error body. */
function shortError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return (j.error?.message || j.message || text).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/**
 * Send a minimal non-streaming request through the model's routing chain and
 * report the outcome. Mirrors dispatch() — failover on 429/5xx/network, return
 * as-is on other 4xx (e.g. 404) — so the result reflects what a real call does.
 */
export async function probeModel(store: Store, model: string, keyHint?: RouteKey): Promise<ProbeResult> {
  const key = keyHint ?? probeFormat(store, model);
  if (!key) {
    return { ok: false, status: 0, format: keyHint ?? "openai", error: "model not enabled on the requested endpoint, or no provider speaks a usable format" };
  }
  const list = candidates(store, model, key);
  if (!list.length) {
    return { ok: false, status: 0, format: key, error: "model not enabled or no provider available" };
  }
  const wire: Format = key === "anthropic" ? "anthropic" : "openai";
  const body =
    wire === "openai"
      ? { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }
      : { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };

  let lastStatus = 0;
  let lastName: string | undefined;
  for (const provider of list) {
    let upstream: Response;
    try {
      upstream = await fetch(upstreamTarget(provider, key).url, {
        method: "POST",
        headers: upstreamHeaders(provider, wire),
        body: JSON.stringify(body),
      });
    } catch {
      lastStatus = 0;
      lastName = provider.name;
      continue;
    }
    lastName = provider.name;
    lastStatus = upstream.status;
    if (upstream.ok) {
      await upstream.text().catch(() => undefined);
      return { ok: true, status: upstream.status, provider: provider.name, format: key };
    }
    if (RETRYABLE.has(upstream.status)) {
      await upstream.text().catch(() => undefined);
      continue;
    }
    const errText = await upstream.text().catch(() => "");
    return {
      ok: false,
      status: upstream.status,
      provider: provider.name,
      format: key,
      error: shortError(errText) || `HTTP ${upstream.status}`,
    };
  }
  return {
    ok: false,
    status: lastStatus,
    provider: lastName,
    format: key,
    error: lastStatus ? `upstream returned ${lastStatus}` : "network error (all providers unreachable)",
  };
}

export function proxyApi(store: Store, auth: MiddlewareHandler): Hono {
  const app = new Hono();
  app.use("*", auth);

  /** Shared dispatch with failover. `key` selects the routing slot (and thus the
   *  candidate chain); `wire`/`path` derive from it for the upstream call. */
  const dispatch = async (c: Context, key: RouteKey) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.model !== "string") {
      return c.json({ error: { message: "request body must be JSON with a 'model' field", type: "invalid_request_error" } }, 400);
    }
    const model: string = body.model;
    const wire: Format = key === "anthropic" ? "anthropic" : "openai";
    const stream = body.stream === true;
    // candidates() already restricts the responses chain to supportsResponses sources.
    const list = candidates(store, model, key);
    if (!list.length) {
      if (key === "responses") {
        return c.json(
          {
            error: {
              message: `model '${model}' is not enabled for /responses — enable it on a source marked "supports responses"`,
              type: "invalid_request_error",
              code: "model_not_found",
            },
          },
          404,
        );
      }
      return notFound(c, model);
    }
    const clientVersion = c.req.header("anthropic-version") ?? undefined;
    const start = Date.now();
    let lastStatus = 502;
    let lastErr = "";

    for (const provider of list) {
      let upstream: Response;
      try {
        upstream = await fetch(upstreamTarget(provider, key).url, {
          method: "POST",
          headers: upstreamHeaders(provider, wire, clientVersion),
          body: JSON.stringify(body),
        });
      } catch {
        // Network error / DNS / timeout → try next provider.
        lastStatus = 502;
        lastErr = "network error";
        continue;
      }

      if (upstream.ok) {
        store.pushLog({ ts: Date.now(), model, provider: provider.name, format: wire, status: upstream.status, ms: Date.now() - start, stream });
        return passThrough(upstream);
      }
      if (RETRYABLE.has(upstream.status)) {
        lastStatus = upstream.status;
        // Drain so the connection can be reused, then move on; capture the
        // reason for the log (this branch never streams back to the client).
        const txt = await upstream.text().catch(() => "");
        lastErr = shortError(txt) || `HTTP ${upstream.status}`;
        continue;
      }
      // Non-retryable client error: return it to the caller as-is. Read the
      // error text off a CLONE so the original body still streams back.
      const errText = await upstream.clone().text().catch(() => "");
      store.pushLog({ ts: Date.now(), model, provider: provider.name, format: wire, status: upstream.status, ms: Date.now() - start, stream, error: shortError(errText) || `HTTP ${upstream.status}` });
      return passThrough(upstream);
    }

    store.pushLog({ ts: Date.now(), model, provider: list[list.length - 1].name, format: wire, status: lastStatus, ms: Date.now() - start, stream, error: lastErr || `all providers failed (last status ${lastStatus})` });
    return c.json(
      { error: { message: `all providers for '${model}' failed (last status ${lastStatus})`, type: "upstream_error" } },
      502,
    );
  };

  app.post("/chat/completions", (c) => dispatch(c, "openai"));
  app.post("/messages", (c) => dispatch(c, "anthropic"));
  // OpenAI Responses API — its own routing slot (sources must be supportsResponses).
  app.post("/responses", (c) => dispatch(c, "responses"));

  // OpenAI-style model list of everything routable on the OpenAI path. This is
  // the OpenAI list endpoint — advertise only models whose openai slot is
  // enabled, so an agent that picks an id here can actually call it on
  // /chat/completions. Anthropic-only models are intentionally omitted.
  app.get("/models", (c) => {
    const d = store.get();
    const byId = new Map(d.providers.map((p) => [p.id, p]));
    const data = Object.entries(d.models)
      .filter(([, e]) => e.openai.enabled)
      .map(([id, e]) => ({
        id,
        object: "model",
        created: 0,
        owned_by: byId.get(e.openai.providers[0] ?? "")?.name || "MyAPIKey",
      }));
    return c.json({ object: "list", data });
  });

  return app;
}
