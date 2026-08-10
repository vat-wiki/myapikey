import { Hono, type Context, type MiddlewareHandler } from "hono";
import { trimBase } from "../shared/config";
import type { Format, Provider, RouteKey } from "../shared/types";
import type { Store } from "./store";

/** HTTP statuses that should trigger failover to the next provider. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Headers copied from upstream back to the client. */
const COPY_DOWN = ["content-type", "cache-control", "x-request-id", "openai-organization", "anthropic-ratelimit-requests-reset"];

/** Parse a `Retry-After` response header (RFC 9110) into a millisecond delay.
 *  Two legal forms: delta-seconds (`"30"`) or an HTTP-date
 *  (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns the raw ms — store clamps it to
 *  [CB_MIN, CB_CAP]; returns undefined for absent/empty/invalid/future-negative
 *  so the caller falls back to the escalating circuit backoff. OpenAI,
 *  Anthropic, OpenRouter, NIM and the OpenAI-compatible backends all emit this
 *  on a 429/overloaded, so honoring it gives an exact cooldown where the per-
 *  vendor `*-reset` headers would each need bespoke parsing. */
function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s > 0) return s * 1000;
  const t = Date.parse(v);
  if (Number.isFinite(t)) {
    const ms = t - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

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

/** Copy through the headers we reflect to the client (content-type, rate-limit
 *  hints, request id, …) and optionally tag the in-process probe with which
 *  source answered. The probe tag never reaches a real agent client (set only
 *  on isProbe calls — see dispatch). */
function downHeaders(upstream: Response, servedBy?: string): Headers {
  const headers = new Headers();
  for (const h of COPY_DOWN) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (servedBy) headers.set("x-myapikey-provider", servedBy);
  return headers;
}

function passThrough(upstream: Response, servedBy?: string): Response {
  // Stream the upstream body straight through (handles SSE + normal JSON).
  return new Response(upstream.body, { status: upstream.status, headers: downHeaders(upstream, servedBy) });
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

/** Outcome of observing an upstream body to completion. A 200 at the headers is
 *  not proof the call succeeded — some backends 200 then truncate the stream or
 *  emit nothing for request shapes they mishandle. `ok` means the stream truly
 *  ended cleanly (terminal marker seen for streaming; clean close otherwise). */
interface SettleInfo {
  ok: boolean;
  status: number;
  error?: string;
}

/** Wrap an upstream body so every byte is forwarded to the client VERBATIM while
 *  we watch — out of band — for whether the stream completed cleanly. The 200
 *  status is already committed before the body flows, so on a bad end we can't
 *  change THAT; instead we (a) [anthropic] inject a synthetic SSE `error` event
 *  so the client learns the stream died rather than seeing a silent EOF, and
 *  (b) settle {ok:false} so dispatch logs a 502 and trips the circuit (the NEXT
 *  call then fails over — this call can't be salvaged once streaming started).
 *
 *  Detection keys on the stream's terminal marker (anthropic message_stop /
 *  openai [DONE] / responses response.completed), buffered across chunk
 *  boundaries — NOT on content, which would false-positive on legitimate
 *  tool-use responses that carry only input_json_delta. A client cancel settles
 *  nothing (the client walked away — not a provider failure, don't log/cool). */
/** Substrings whose presence proves a streaming response reached a REAL
 *  terminal event — so an absent marker at stream-end means truncation. Keyed by
 *  routing slot: anthropic ends on message_stop; /chat/completions on [DONE];
 *  /responses on any of its terminal events (completed/failed/incomplete/
 *  cancelled — a clean upstream FAILURE is not a truncation, just a failed call,
 *  so we don't cool the source for it). Empty for a non-streaming body, where
 *  only a reader error counts. */
function terminalMarkers(key: RouteKey, stream: boolean): string[] {
  if (!stream) return [];
  if (key === "anthropic") return ["message_stop"];
  if (key === "responses") return ["response.completed", "response.failed", "response.incomplete", "response.cancelled"];
  return ["[DONE]"]; // openai /chat/completions
}

/** Best-effort synthetic terminal error frame, so a client learns a stream died
 *  instead of seeing a silent EOF. Each wire's own convention:
 *  - anthropic + /responses use typed `event: error` (spec'd);
 *  - /chat/completions is a data-only SSE stream with NO spec'd mid-stream error
 *    event, so we emit the de-facto `data: {"error":…}` shape most compatible
 *    backends/SDKs raise on.
 *  Never emits `[DONE]` (that signals success). */
function errorFrame(key: RouteKey, reason: string): string {
  const msg = reason.slice(0, 200);
  if (key === "anthropic") {
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`;
  }
  if (key === "responses") {
    // Plain transport-error `event: error` (response.failed would need a full
    // Response object we don't have). Best-effort — /responses is opt-in.
    return `event: error\ndata: ${JSON.stringify({ type: "error", message: msg })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { message: msg, type: "server_error" } })}\n\n`;
}

function observedBody(
  upstream: Response,
  opts: { stream: boolean; key: RouteKey; onSettle: (info: SettleInfo) => void },
): ReadableStream<Uint8Array> {
  const reader = upstream.body?.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const markers = terminalMarkers(opts.key, opts.stream);
  let tail = ""; // rolling window so a marker split across chunks is still caught
  let terminal = false;
  let settled = false;

  const settle = (info: SettleInfo) => {
    if (settled) return;
    settled = true;
    opts.onSettle(info);
  };
  const injectError = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
    controller.enqueue(enc.encode(errorFrame(opts.key, reason)));
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        settle({ ok: true, status: 200 });
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (opts.stream && !terminal) {
            const reason = "upstream stream truncated (no terminal marker)";
            injectError(controller, reason);
            settle({ ok: false, status: 502, error: reason });
          } else {
            settle({ ok: true, status: 200 });
          }
          controller.close();
          return;
        }
        if (!terminal && markers.length) {
          const txt = dec.decode(value, { stream: true });
          const win = tail + txt;
          if (markers.some((m) => win.includes(m))) terminal = true;
          tail = win.slice(-128);
        }
        controller.enqueue(value);
      } catch (e) {
        const reason = `upstream stream error: ${e instanceof Error ? e.message : String(e)}`;
        injectError(controller, reason);
        settle({ ok: false, status: 502, error: reason });
        controller.close();
      }
    },
    cancel() {
      // Client abort (Esc / disconnect) — not a provider failure. Suppress the
      // settle so we neither log nor cool down a source the client simply left.
      settled = true;
      reader?.cancel().catch(() => {});
    },
  });
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

    // Skip providers that are either in circuit-breaker cooldown OR over their
    // RPM pacing cap. Both are heuristics: if every candidate is skipped, fall
    // back to the full list anyway — one real attempt beats a guaranteed 502
    // (a skipped provider that now succeeds also resets its state). A pinned
    // (per-source) probe ignores both — the user is testing THIS source now,
    // whatever its breaker/pacing state.
    const skipped = (p: Provider) => store.isCooling(p.id) || (!!p.rpm && store.rpmUsed(p.id) >= p.rpm);
    const live = pinId ? list : list.filter((p) => !skipped(p));
    const order = live.length ? live : list;

    for (const provider of order) {
      // Model mapping (per model×source): rewrite the passthrough body's model
      // to this provider's configured upstream name. Recomputed from the ORIGINAL
      // `model` each iteration, so failover to the next provider never carries the
      // previous provider's upstream name. Absent map/key → send the public name.
      const mapped = store.get().models[model]?.[key]?.modelMap?.[provider.id];
      body.model = mapped ?? model;
      // Count this attempt toward the source's RPM window — but not for a pinned
      // probe, which (like circuit state) takes no routing side-effects.
      if (!pinId) store.recordDispatch(provider.id);
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
        // A 200 from the upstream is NOT proof the call succeeded: some backends
        // return 200 then truncate the stream (or emit no content) for request
        // shapes they mishandle. We commit the 200 status to the client right
        // away (headers are already sent) but OBSERVE the body as it flows and
        // settle once — on a clean, fully-terminated stream we close the circuit
        // + log 200; on a truncated/errored stream we log 502, trip the circuit
        // (so the NEXT call fails over), and — on the anthropic wire — inject a
        // synthetic SSE error event so the client learns the stream died instead
        // of seeing a silent EOF. TTFB is captured now; logging is deferred to
        // the body's end (so the row reflects the real outcome, not just the
        // headers). See observedBody() for the detection rules.
        const ttfb = Date.now() - start;
        const body = observedBody(upstream, {
          stream,
          key,
          onSettle: (info) => {
            if (info.ok) {
              store.recordCircuitSuccess(provider.id);
              store.pushLog({ ts: Date.now(), model, provider: provider.name, providerId: provider.id, format: wire, status: 200, ms: ttfb, stream });
            } else {
              // A pinned per-source probe takes no circuit side-effects (a manual
              // test must not trip the breaker) — mirrors the retryable branch.
              if (!pinId) store.recordCircuitFailure(provider.id, info.status, info.error || "stream failed");
              store.pushLog({ ts: Date.now(), model, provider: provider.name, providerId: provider.id, format: wire, status: info.status, ms: ttfb, stream, error: info.error });
            }
          },
        });
        return new Response(body, { status: upstream.status, headers: downHeaders(upstream, isProbe ? provider.name : undefined) });
      }
      if (RETRYABLE.has(upstream.status)) {
        lastStatus = upstream.status;
        // Drain so the connection can be reused, then move on; capture the
        // reason for the log (this branch never streams back to the client).
        const txt = await upstream.text().catch(() => "");
        lastErr = shortError(txt) || `HTTP ${upstream.status}`;
        if (pinId) break; // per-source probe: fail fast, no circuit impact.
        // A 429/overloaded upstream usually carries Retry-After; honoring it
        // cools for exactly as long as asked (clamped) instead of the escalating
        // guess. Absent (5xx often, or a proxy that stripped it) → escalate.
        const retryAfterMs = parseRetryAfter(upstream.headers.get("retry-after"));
        const r = store.recordCircuitFailure(provider.id, lastStatus, lastErr, retryAfterMs);
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
