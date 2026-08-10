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

/** Auth headers for the Anthropic wire format. Sends BOTH x-api-key and
 *  Authorization: Bearer (same key). Native Anthropic (api.anthropic.com)
 *  accepts either; anthropic- COMPATIBLE surfaces (sensenova, Volcengine Ark,
 *  …) typically honor ONLY Authorization: Bearer and 401 on bare x-api-key.
 *  Each server uses the header it recognizes and ignores the other, so one
 *  request satisfies either flavor. (Anthropic's own C# SDK sends both.) */
export function anthropicAuthHeaders(apiKey: string, version: string): Record<string, string> {
  return { "x-api-key": apiKey, authorization: `Bearer ${apiKey}`, "anthropic-version": version };
}

function upstreamHeaders(provider: Provider, format: Format, clientVersion?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (format === "openai") h.authorization = `Bearer ${provider.apiKey}`;
  else Object.assign(h, anthropicAuthHeaders(provider.apiKey, clientVersion || "2023-06-01"));
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

function passThrough(upstream: Response, servedBy?: string): Response {
  const headers = new Headers();
  for (const h of COPY_DOWN) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Internal hook for the model-page "test": report which provider answered.
  // Only set on in-process probe calls (see isProbe in dispatch), so it never
  // appears on responses to real agent clients.
  if (servedBy) headers.set("x-myapikey-provider", servedBy);
  // Stream the upstream body straight through (handles SSE + normal JSON).
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Pull a short human-readable message out of an upstream error body. */
export function shortError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return (j.error?.message || j.message || text).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
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
    // The model-page "test" button drives dispatch via an in-process loopback
    // (adminApi calls v1.request). The probe is a real call in every respect —
    // including being logged — so we only tag it to report WHICH provider
    // answered back to the test handler (x-myapikey-provider), without leaking
    // that header to real agent clients.
    const isProbe = c.req.header("x-myapikey-probe") === "1";
    // The per-source "test this source" variant pins dispatch to ONE provider:
    // the candidate chain is reduced to just it, and on failure we stop
    // immediately (no failover) WITHOUT recording a circuit failure — a manual
    // probe must not trip the breaker. Failure surfaces the real upstream status
    // (429/500/…), not a collapsed 502, so the badge shows what really happened.
    const pinId = c.req.header("x-myapikey-probe-provider") || "";
    // candidates() already restricts the responses chain to supportsResponses sources.
    let list = candidates(store, model, key);
    if (pinId) list = list.filter((p) => p.id === pinId);
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

    // Skip providers currently in circuit-breaker cooldown. If every candidate
    // is cooling, fall back to the full list anyway — cooldown is a heuristic,
    // and one real attempt beats a guaranteed 502 (a cooled provider that now
    // succeeds also resets its circuit). A pinned (per-source) probe ignores
    // cooldown entirely: the user is asking to test THIS source now, whatever
    // its breaker state.
    const live = pinId ? list : list.filter((p) => !store.isCooling(p.id));
    const order = live.length ? live : list;

    for (const provider of order) {
      // Model mapping (per model×source): rewrite the passthrough body's model
      // to this provider's configured upstream name. Recomputed from the ORIGINAL
      // `model` each iteration, so failover to the next provider never carries the
      // previous provider's upstream name. Absent map/key → send the public name.
      const mapped = store.get().models[model]?.[key]?.modelMap?.[provider.id];
      body.model = mapped ?? model;
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
        if (pinId) break; // per-source probe: fail fast, no circuit impact.
        const r = store.recordCircuitFailure(provider.id, lastStatus, lastErr);
        if (r.entered) {
          store.pushLog({ ts: Date.now(), model, provider: provider.name, providerId: provider.id, format: wire, status: lastStatus, ms: Date.now() - start, stream, kind: "cooldown", cooldownMs: r.cooldownMs, fails: r.fails, error: lastErr });
        }
        continue;
      }

      if (upstream.ok) {
        // A success closes the circuit (provider is healthy again).
        store.recordCircuitSuccess(provider.id);
        store.pushLog({ ts: Date.now(), model, provider: provider.name, providerId: provider.id, format: wire, status: upstream.status, ms: Date.now() - start, stream });
        return passThrough(upstream, isProbe ? provider.name : undefined);
      }
      if (RETRYABLE.has(upstream.status)) {
        lastStatus = upstream.status;
        // Drain so the connection can be reused, then move on; capture the
        // reason for the log (this branch never streams back to the client).
        const txt = await upstream.text().catch(() => "");
        lastErr = shortError(txt) || `HTTP ${upstream.status}`;
        if (pinId) break; // per-source probe: fail fast, no circuit impact.
        const r = store.recordCircuitFailure(provider.id, lastStatus, lastErr);
        if (r.entered) {
          store.pushLog({ ts: Date.now(), model, provider: provider.name, providerId: provider.id, format: wire, status: lastStatus, ms: Date.now() - start, stream, kind: "cooldown", cooldownMs: r.cooldownMs, fails: r.fails, error: lastErr });
        }
        continue;
      }
      // Non-retryable client error: return it to the caller as-is. Read the
      // error text off a CLONE so the original body still streams back.
      const errText = await upstream.clone().text().catch(() => "");
      store.pushLog({ ts: Date.now(), model, provider: provider.name, providerId: provider.id, format: wire, status: upstream.status, ms: Date.now() - start, stream, error: shortError(errText) || `HTTP ${upstream.status}` });
      return passThrough(upstream, isProbe ? provider.name : undefined);
    }

    const last = order[order.length - 1];
    store.pushLog({ ts: Date.now(), model, provider: last.name, providerId: last.id, format: wire, status: lastStatus, ms: Date.now() - start, stream, error: lastErr || `all providers failed (last status ${lastStatus})` });
    // A pinned (per-source) probe failed: surface the REAL upstream status the
    // one provider returned (429/500/…), not a collapsed 502, and tag it with
    // x-myapikey-provider so the source-row badge names the tested source.
    if (pinId) {
      const h = new Headers({ "content-type": "application/json" });
      if (isProbe) h.set("x-myapikey-provider", last.name);
      return new Response(
        JSON.stringify({ error: { message: lastErr || `provider failed (status ${lastStatus})`, type: "upstream_error" } }),
        { status: lastStatus, headers: h },
      );
    }
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
