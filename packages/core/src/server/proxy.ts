import { Hono, type Context, type MiddlewareHandler } from "hono";
import { trimBase } from "../shared/config";
import type { DebugCapture, Format, Provider, RouteKey, Usage } from "../shared/types";
import { CAPTURE_BODY_MAX, type Store } from "./store";
import { UsageCollector } from "./tokens";

/** HTTP statuses that should trigger failover to the next provider. 401/403
 *  included: a banned/invalid credential (e.g. "User has been banned") is dead
 *  for THIS source only - the same request may be fine on the next one. */
const RETRYABLE = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

/** Even pacing (per-model `paceRpm`) message constants. The queue itself lives
 *  in Store.paceClaim - 60s wait horizon, one release every 60/rpm seconds. */
const PACE_MAX_WAIT_S = 60;
const RPM_SECONDS = 60;

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

/** Parse a quota-reset DATETIME out of an upstream error body, for backends that
 *  put it in the message instead of a Retry-After header. Volcengine Ark's 1308
 *  ("已达到 5 小时的使用上限。您的限额将在 2026-08-11 18:33:11 重置。") is the case
 *  that bit us: no Retry-After, so the cooldown fell back to the escalating guess
 *  and re-hit the limit every 30/60/120…s. Returns ms-until-reset so the caller
 *  can cool for the real remaining window.
 *
 *  Bare datetimes in these Chinese-vendor bodies are Beijing time (UTC+8); force
 *  that zone so the cooldown is right no matter what TZ the gateway itself runs
 *  in (Date.parse on a zone-less space-separated string would otherwise read it
 *  as the gateway's LOCAL time). An explicit zone (Z / ±HH:MM) is honored as-is.
 *  Returns undefined for no match / unparseable / already-in-the-past so the
 *  caller falls back to the escalating backoff. */
function parseResetFromBody(text: string): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return undefined;
  const zone = m[3] ?? "+08:00";
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (!Number.isFinite(t)) return undefined;
  const ms = t - Date.now();
  return ms > 0 ? ms : undefined;
}

/** One resolved routing slot: the provider to forward to plus THIS slot's
 *  optional upstream model name (absent = send the public model name) and
 *  default thinking level. The same provider may occupy several slots in a
 *  chain — each is an independent failover slot carrying its own upstream
 *  model. */
interface CandidateSlot {
  provider: Provider;
  model?: string;
  thinking?: string;
}

/** Resolve the ordered, compatible provider slots for a model on a routing slot. */
function candidates(store: Store, model: string, key: RouteKey): CandidateSlot[] {
  const d = store.get();
  const entry = d.models[model];
  const fe = entry?.[key];
  if (!fe?.enabled) return [];
  const byId = new Map(d.providers.map((p) => [p.id, p]));
  // Defense-in-depth: openai/anthropic require that wire format; responses
  // requires supportsResponses. (Admin keeps chains pure, but a provider's
  // formats/flag can be edited afterwards.)
  return fe.providers
    .map((s): CandidateSlot | null => {
      const p = byId.get(s.id);
      return p ? { provider: p, model: s.model, thinking: s.thinking } : null;
    })
    .filter((slot): slot is CandidateSlot => {
      if (!slot) return false;
      return key === "responses" ? !!slot.provider.supportsResponses : slot.provider.formats.includes(key);
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

// --- per-slot default thinking level -----------------------------------------
// Each routing slot can carry a default thinking level. When a slot HAS one it
// takes precedence over EVERYTHING the request carried — the gateway's own
// config is the authority, so the default replaces the request's thinking
// parameters outright (all of them, including compat-backend switches, leaving
// exactly one thinking instruction in the body). A slot WITHOUT a default is
// pure passthrough: whatever the request carried goes through untouched —
// restored verbatim if an earlier failover slot overrode it. Like the model
// rewrite, the default is written in the wire's own dialect, never translated
// across formats:
//   openai /chat/completions → `reasoning_effort: "<token>"` (low/medium/high/…)
//   /responses               → `reasoning: { effort: "<token>" }`
//   anthropic /v1/messages   → `thinking: { type: "enabled", budget_tokens: N }`
//     (Anthropic has no named levels — the stored default IS the budget, a
//     positive integer. The API also demands max_tokens > budget_tokens, so an
//     at-or-below cap is lifted to budget+1 (and restored on a passthrough
//     slot); otherwise the call would 400 — including our own max_tokens:1
//     probe.)

/** The body fields that steer thinking on a slot. The FIRST is the wire's
 *  canonical parameter — the one a default is written into; the rest are
 *  compat-backend switches (`thinking`, `enable_thinking` on chat/completions)
 *  that an override clears so the forced level is the only instruction left. */
function thinkingFields(key: RouteKey): string[] {
  if (key === "anthropic") return ["thinking"];
  if (key === "responses") return ["reasoning"];
  return ["reasoning_effort", "reasoning", "thinking", "enable_thinking"];
}

/** Best-effort display of what a body's own thinking switches ask for (for the
 *  log row on a passthrough slot, where the request's setting is what ran). */
function clientThinking(body: Record<string, unknown>, key: RouteKey): { set: boolean; value?: string } {
  const show = (v: unknown): string | undefined => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
  if (key === "responses") {
    const r = body.reasoning;
    if (r === undefined || r === null) return { set: false };
    const effort = (r as { effort?: unknown }).effort;
    return { set: true, value: effort === undefined ? show(r) : show(effort) };
  }
  if (key === "anthropic") {
    const t = body.thinking;
    if (t === undefined || t === null) return { set: false };
    const budget = (t as { budget_tokens?: unknown }).budget_tokens;
    return { set: true, value: budget === undefined ? show(t) : show(budget) };
  }
  const found = [
    body.reasoning_effort,
    (body.reasoning as { effort?: unknown } | undefined)?.effort,
    (body.thinking as { budget_tokens?: unknown } | undefined)?.budget_tokens,
    (body.thinking as { type?: unknown } | undefined)?.type,
    body.enable_thinking,
  ].find((v) => v !== undefined && v !== null);
  return { set: found !== undefined, value: found === undefined ? undefined : show(found) };
}

/** Snapshot of the request's own thinking switches, taken once before the
 *  failover loop — every attempt mutates the shared body, so a passthrough
 *  slot needs the originals kept aside to restore. */
interface ThinkingOrig {
  fields: Record<string, unknown>;
  /** anthropic only: the request's original max_tokens (restored alongside,
   *  since an override may have lifted it above the forced budget). */
  maxTokens: unknown;
}

/** Apply THIS slot's thinking level to the body (mutating it), and return the
 *  log row's `thinking` field: the level that ran and where it came from.
 *  Undefined = nothing applied. A slot WITH a default overrides the request's
 *  own parameters entirely; a slot WITHOUT one restores them (undoing any
 *  override an earlier failover slot applied — same recompute-per-attempt
 *  discipline as the model rewrite, so slot A's level never leaks into B). */
function applySlotThinking(
  body: Record<string, unknown>,
  key: RouteKey,
  def: string | undefined,
  orig: ThinkingOrig,
): { value: string; from: "client" | "default" } | undefined {
  const fields = thinkingFields(key);
  if (!def) {
    for (const f of fields) {
      if (orig.fields[f] === undefined) delete body[f];
      else body[f] = orig.fields[f];
    }
    if (key === "anthropic") {
      if (orig.maxTokens === undefined) delete body.max_tokens;
      else body.max_tokens = orig.maxTokens;
    }
    const own = clientThinking(orig.fields, key);
    return own.set ? { value: own.value ?? "", from: "client" } : undefined;
  }
  for (const f of fields) delete body[f];
  if (key === "anthropic") {
    const budget = Number(def);
    body.thinking = { type: "enabled", budget_tokens: budget };
    if (typeof body.max_tokens === "number" && body.max_tokens <= budget) body.max_tokens = budget + 1;
  } else if (key === "responses") {
    body.reasoning = { effort: def };
  } else {
    body.reasoning_effort = def;
  }
  return { value: def, from: "default" };
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

/** Exported for the admin source-test (direct upstream ping, no routing). */
export function upstreamHeaders(provider: Provider, format: Format, clientVersion?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (format === "openai") h.authorization = `Bearer ${provider.apiKey}`;
  else Object.assign(h, anthropicAuthHeaders(provider.apiKey, clientVersion || "2023-06-01"));
  return h;
}

/** Resolve the upstream URL + wire format for a routing slot. The OpenAI base
 *  includes the version segment (we append the bare resource); the Anthropic
 *  base excludes /v1 (we append v1/messages). /responses reuses the OpenAI base.
 *  Exported for the admin source-test (direct upstream ping, no routing). */
export function upstreamTarget(p: Provider, key: RouteKey): { url: string; wire: Format } {
  if (key === "anthropic") {
    return { url: `${trimBase(p.baseUrlAnthropic)}/v1/messages`, wire: "anthropic" };
  }
  const path = key === "responses" ? "responses" : "chat/completions";
  return { url: `${trimBase(p.baseUrlOpenai)}/${path}`, wire: "openai" };
}

/** HTTP header values are ByteStrings (Latin-1, code points ≤ 255) — a value
 *  with any wider char throws at Headers.set time. Provider names can be any
 *  unicode (e.g. "商汤"), so %-encode the probe tag and %-decode it on the admin
 *  read side. encodeURIComponent is a no-op on plain-ASCII names. */
const encodeTag = (s: string): string => encodeURIComponent(s);

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
  if (servedBy) headers.set("x-myapikey-provider", encodeTag(servedBy));
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
  /** Token usage captured from the body as it flowed (success rows only).
   *  Undefined for failed/truncated streams and for a body with no usage. */
  usage?: Usage;
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
  opts: {
    stream: boolean;
    key: RouteKey;
    /** The original request's `messages`, used only to estimate prompt tokens
     *  on the openai-chat-stream fallback path (see tokens.ts). */
    requestMessages?: unknown;
    /** Called with each decoded text chunk AS IT FLOWS — the debug capture's
     *  tee point (the proxy keeps forwarding bytes verbatim regardless).
     *  Optional: absent = zero capture overhead. */
    onText?: (txt: string) => void;
    onSettle: (info: SettleInfo) => void;
  },
): ReadableStream<Uint8Array> {
  const reader = upstream.body?.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const markers = terminalMarkers(opts.key, opts.stream);
  let tail = ""; // rolling window so a marker split across chunks is still caught
  let terminal = false;
  let settled = false;
  const usage = new UsageCollector();

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
            settle({ ok: true, status: 200, usage: usage.finalize({ stream: opts.stream, key: opts.key, requestMessages: opts.requestMessages }) });
          }
          controller.close();
          return;
        }
        const txt = dec.decode(value, { stream: true });
        usage.feed(txt, { stream: opts.stream, key: opts.key });
        opts.onText?.(txt);
        if (!terminal && markers.length) {
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

/** Model list of the models enabled on ONE routing family's slot. Each agent
 *  surface gets its own `/models` so a client listing models never picks an id
 *  that 404s on that surface's call endpoint — and each answers in its own
 *  ecosystem's list shape: openai `{object:"list", data:[{id, owned_by}]}` vs
 *  anthropic `{data:[{id, display_name}], first_id, last_id, has_more}`. We
 *  can't know real created_at / capabilities, so the anthropic shape carries
 *  only the honest minimal fields rather than fabricating them. */
function modelsList(c: Context, store: Store, fmt: "openai" | "anthropic") {
  const d = store.get();
  const byId = new Map(d.providers.map((p) => [p.id, p]));
  const enabled = Object.entries(d.models).filter(([, e]) => e[fmt].enabled);
  if (fmt === "anthropic") {
    const data = enabled.map(([id]) => ({ id, display_name: id, created_at: "1970-01-01T00:00:00Z", type: "model" }));
    return c.json({ data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: false });
  }
  const data = enabled.map(([id, e]) => ({
    id,
    object: "model",
    created: 0,
    owned_by: byId.get(e.openai.providers[0]?.id ?? "")?.name || "MyAPIKey",
  }));
  return c.json({ object: "list", data });
}

/** The two agent surfaces as separate sub-apps, so each carries its own
 *  `/models` (openai list vs anthropic list) under its own prefix. `dispatch`
 *  is shared — it's keyed by RouteKey, surface-agnostic. */
export function proxyApi(
  store: Store,
  auth: MiddlewareHandler,
): { openai: Hono; anthropic: Hono } {
  const openai = new Hono();
  const anthropic = new Hono();
  // GET /models is a PUBLIC discovery read — no api key required. It returns only
  // the enabled model names (like /health), so an agent or a quick curl can see
  // what each surface offers before wiring up auth. Registered BEFORE the auth
  // middleware so it isn't gated: Hono only runs middleware on routes registered
  // after it.
  openai.get("/models", (c) => modelsList(c, store, "openai"));
  anthropic.get("/models", (c) => modelsList(c, store, "anthropic"));
  openai.use("*", auth);
  anthropic.use("*", auth);

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
    // The request's own thinking switches, snapshotted BEFORE the failover
    // loop — each attempt mutates the shared body, and a passthrough slot
    // (no default) must restore these originals.
    const thinkOrig: ThinkingOrig = {
      fields: Object.fromEntries(thinkingFields(key).map((f) => [f, body[f]])),
      maxTokens: body.max_tokens,
    };
    // The model-page "test" button drives dispatch via an in-process loopback
    // (adminApi calls v1.request). The probe is a real call in every respect —
    // including being logged — so we only tag it to report WHICH provider
    // answered back to the test handler (x-myapikey-provider), without leaking
    // that header to real agent clients.
    const isProbe = c.req.header("x-myapikey-probe") === "1";
    // The per-source "test this source" variant pins dispatch to ONE slot (by
    // chain index, since a provider may occupy several slots): the candidate
    // chain is reduced to just that slot, and on failure we stop immediately
    // (no failover) WITHOUT recording a circuit failure — a manual probe must
    // not trip the breaker. Failure surfaces the real upstream status
    // (429/500/…), not a collapsed 502, so the badge shows what really happened.
    const pinIndexRaw = c.req.header("x-myapikey-probe-slot");
    const pinIndex = pinIndexRaw !== "" && Number.isInteger(Number(pinIndexRaw)) ? Number(pinIndexRaw) : null;
    // candidates() already restricts the responses chain to supportsResponses sources.
    let list = candidates(store, model, key);
    if (pinIndex != null) {
      // An out-of-range index → empty list → 404, so a bad probe is reported as
      // unreachable rather than accidentally hitting a different slot.
      list = list[pinIndex] != null ? [list[pinIndex]] : [];
    }
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
    // Thinking level of the most recent attempt (for the all-failed row after
    // the rounds loop; per-attempt rows capture the loop's own `think` const).
    let lastThink: { value: string; from: "client" | "default" } | undefined;
    // Runtime log (console + server.log). Errors and notable events only — the
    // per-call history these lines summarize goes to pushLog/logs.jsonl anyway.
    // UI-triggered probes are excluded: their outcome is shown inline already.
    const rt = store.getLogger();
    const sayFailover = (p: Provider, why: string) => {
      if (!isProbe) rt.warn(`proxy model=${model}: provider '${p.name}' ${why} → trying next`);
    };
    const sayCooldown = (p: Provider, r: { entered: boolean; fails: number; cooldownMs: number }) => {
      if (r.entered && !isProbe) rt.warn(`proxy circuit open: provider '${p.name}' cooldown=${r.cooldownMs}ms fails=${r.fails}`);
    };

    // Even pacing (per-model leaky bucket, `paceRpm`): spread the model's calls
    // one every 60/rpm seconds - excess requests QUEUE here (bounded by a 60s
    // wait horizon; past it they're rejected 429 in the wire's own error shape).
    // One slot per REQUEST, claimed before the failover loop, so a call that
    // fails over to later sources never queues twice. Independent of the
    // per-source Provider.rpm skip (that one spills to the next source). Probes
    // go through the same queue - they are real calls and claim real slots.
    const paceRpm = store.get().models[model]?.paceRpm;
    if (paceRpm) {
      const wait = store.paceClaim(model, paceRpm);
      if (wait < 0) {
        const retryAfter = Math.max(1, Math.ceil(RPM_SECONDS / paceRpm));
        const message = `rate limited: even-pacing queue for '${model}' is full (max wait ${Math.round(PACE_MAX_WAIT_S)}s; retry in ~${retryAfter}s)`;
        if (!isProbe) rt.warn(`proxy model=${model}: paced out (429)`);
        store.pushLog({ ts: Date.now(), model, provider: "", format: wire, status: 429, ms: Date.now() - start, stream, error: "even-pacing queue full" });
        const headers = { "content-type": "application/json", "retry-after": String(retryAfter) };
        if (wire === "anthropic") {
          return c.json({ type: "error", error: { type: "rate_limit_error", message } }, 429, headers);
        }
        return c.json({ error: { message, type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429, headers);
      }
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
        // The client may have hung up while queued - release nothing upstream
        // (the slot is already spent, but no need to burn provider quota too).
        if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 });
      }
    }

    // Selection + failover run in ROUNDS. Each round attempts the candidates
    // that are neither in circuit-breaker cooldown nor over their rpm cap; a
    // capped-but-healthy source still spills to the next free source (failover
    // first). Only when NOTHING is immediately usable but some candidate is
    // merely over its rpm cap does the request QUEUE: sleep until that source's
    // soonest window slot frees and run another round — the client perceives
    // only the wait (or its own timeout), never an rpm error. There is no wait
    // cap: rounds terminate anyway because retryable failures escalate the
    // circuit breaker, so sources converge to cooling and the final round is
    // the old try-anyway fallback (full list — one real attempt beats a
    // guaranteed 502, and a skipped provider that now succeeds also resets its
    // state). A pinned (per-source) probe ignores all of this — the user is
    // testing THIS source now, whatever its breaker/pacing state.
    const cooling = (slot: CandidateSlot) => store.isCooling(slot.provider.id);
    const overRpm = (slot: CandidateSlot) => !!slot.provider.rpm && store.rpmUsed(slot.provider.id) >= slot.provider.rpm;
    /** Sleep until the soonest rpm slot frees among `capped`. Returns false
     *  when the client hung up while queued — the caller drops the request
     *  (nothing was sent upstream, so no log row either). */
    const waitForSlot = async (capped: CandidateSlot[]): Promise<boolean> => {
      const wait = Math.max(1, Math.min(...capped.map((s) => store.rpmNextFreeMs(s.provider.id))));
      if (!isProbe) rt.warn(`proxy model=${model}: all sources over rpm cap — queued, next slot in ~${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      return !c.req.raw.signal?.aborted;
    };

    for (;;) {
      // Re-read the chain each round: config and circuit state move while queued.
      const cur = pinIndex != null ? list : candidates(store, model, key);
      if (pinIndex == null && !cur.length) return notFound(c, model); // disabled while queued
      const live = pinIndex != null ? cur : cur.filter((s) => !cooling(s) && !overRpm(s));
      const capped = pinIndex != null ? [] : cur.filter((s) => !cooling(s) && overRpm(s));
      if (pinIndex == null && !live.length && capped.length) {
        if (await waitForSlot(capped)) continue;
        return new Response(null, { status: 499 });
      }
      const order = live.length ? live : cur;

      for (const slot of order) {
        const provider = slot.provider;
        // Per-slot upstream model name (absent = send the public name). Read from
        // the slot each iteration, so failover never carries the previous slot's
        // upstream name.
        body.model = slot.model ?? model;
        // The actual upstream model forwarded this attempt (after the per-slot
        // rewrite). Recorded on the log row so history shows which real model a
        // routed call landed on when a source remaps the public name. `undefined`
        // when the public name went through verbatim — JSON.stringify drops it, so
        // identity + legacy rows stay clean.
        const upstreamModel = slot.model && slot.model !== model ? slot.model : undefined;
        // Per-slot thinking level: re-read from the slot and re-applied every
        // attempt. A configured default OVERRIDES whatever the request carried;
        // a slot without one restores the request's own switches (see
        // applySlotThinking), so slot A's level never leaks into slot B.
        const think = applySlotThinking(body, key, slot.thinking, thinkOrig);
        lastThink = think;
        // Count this attempt toward the source's RPM window — but not for a pinned
        // probe, which (like circuit state) takes no routing side-effects.
        if (pinIndex == null) store.recordDispatch(provider.id);
        // Debug capture: EVERY upstream attempt is offered to the store —
        // failed attempts always land in the global failure net (the safety
        // net for after-the-fact debugging), everything lands in the model's
        // own buffer while its switch is on. The row carries the exact
        // forwarded body (this slot's model rewrite + thinking injection are
        // already applied) and the response as it flowed. UI probes are
        // excluded (not real conversations). One entry per attempt: a
        // failover chain writes several, each showing what THAT source
        // actually received.
        const attemptStart = Date.now();
        const reqText = JSON.stringify(body);
        const capture = (status: number, response: string | undefined, truncated: boolean, error?: string) => {
          if (isProbe) return;
          const row: DebugCapture = {
            ts: Date.now(),
            model,
            provider: provider.name,
            providerId: provider.id,
            format: wire,
            status,
            ms: Date.now() - attemptStart,
            stream,
            request: reqText,
            ...(upstreamModel ? { upstreamModel } : {}),
            ...(think ? { thinking: think } : {}),
            ...(response ? { response } : {}),
            ...(truncated ? { truncated: true } : {}),
            ...(error ? { error } : {}),
          };
          store.pushCapture(model, row);
        };
        let upstream: Response;
        try {
          upstream = await fetch(upstreamTarget(provider, key).url, {
            method: "POST",
            headers: upstreamHeaders(provider, wire, clientVersion),
            body: reqText,
          });
        } catch {
          // Network error / DNS / timeout → try next provider.
          capture(0, undefined, false, "network error");
          lastStatus = 502;
          lastErr = "network error";
          if (pinIndex != null) break; // per-source probe: fail fast, no circuit impact.
          sayFailover(provider, "network error");
          const r = store.recordCircuitFailure(provider.id, lastStatus, lastErr);
          if (r.entered) {
            store.pushLog({ ts: Date.now(), model, upstreamModel, provider: provider.name, providerId: provider.id, format: wire, status: lastStatus, ms: Date.now() - start, stream, thinking: think, kind: "cooldown", cooldownMs: r.cooldownMs, fails: r.fails, error: lastErr });
            sayCooldown(provider, r);
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
          // Debug capture tee: accumulate the decoded chunks into a bounded
          // string (the proxy keeps forwarding bytes verbatim regardless).
          const capAcc = { text: "", truncated: false };
          const out = observedBody(upstream, {
            stream,
            key,
            requestMessages: body.messages,
            onText: (txt: string) => {
              const room = CAPTURE_BODY_MAX - capAcc.text.length;
              if (room <= 0) {
                capAcc.truncated = true;
                return;
              }
              if (txt.length > room) capAcc.truncated = true;
              capAcc.text += txt.slice(0, room);
            },
            onSettle: (info) => {
              if (info.ok) {
                store.recordCircuitSuccess(provider.id);
                store.pushLog({ ts: Date.now(), model, upstreamModel, provider: provider.name, providerId: provider.id, format: wire, status: 200, ms: ttfb, stream, thinking: think, usage: info.usage });
                capture(200, capAcc.text, capAcc.truncated);
              } else {
                // A pinned per-source probe takes no circuit side-effects (a manual
                // test must not trip the breaker) — mirrors the retryable branch.
                if (pinIndex == null) store.recordCircuitFailure(provider.id, info.status, info.error || "stream failed");
                if (!isProbe) rt.warn(`proxy stream failed: provider '${provider.name}' status=${info.status} (${info.error || "stream failed"})`);
                store.pushLog({ ts: Date.now(), model, upstreamModel, provider: provider.name, providerId: provider.id, format: wire, status: info.status, ms: ttfb, stream, thinking: think, error: info.error });
                capture(info.status, capAcc.text, capAcc.truncated, info.error);
              }
            },
          });
          return new Response(out, { status: upstream.status, headers: downHeaders(upstream, isProbe ? provider.name : undefined) });
        }
        if (RETRYABLE.has(upstream.status)) {
          lastStatus = upstream.status;
          // Drain so the connection can be reused, then move on; capture the
          // reason for the log (this branch never streams back to the client).
          const txt = await upstream.text().catch(() => "");
          lastErr = shortError(txt) || `HTTP ${upstream.status}`;
          capture(upstream.status, txt, false, lastErr);
          if (pinIndex != null) break; // per-source probe: fail fast, no circuit impact.
          sayFailover(provider, `HTTP ${lastStatus} (${lastErr})`);
          // A 429/overloaded upstream usually carries Retry-After; honoring it
          // cools for exactly as long as asked (clamped) instead of the escalating
          // guess. Absent (5xx often, OR a quota error that buried the reset time
          // in the BODY — e.g. Volcengine Ark's 1308 "您的限额将在 <datetime> 重置")
          // → parse that deadline out of the body, else fall back to escalating.
          const retryAfterMs = parseRetryAfter(upstream.headers.get("retry-after"));
          const resetInMs = retryAfterMs ? undefined : parseResetFromBody(txt);
          const r = store.recordCircuitFailure(provider.id, lastStatus, lastErr, retryAfterMs ?? resetInMs, !!resetInMs);
          if (r.entered) {
            store.pushLog({ ts: Date.now(), model, upstreamModel, provider: provider.name, providerId: provider.id, format: wire, status: lastStatus, ms: Date.now() - start, stream, thinking: think, kind: "cooldown", cooldownMs: r.cooldownMs, fails: r.fails, error: lastErr });
            sayCooldown(provider, r);
          }
          continue;
        }
        // Non-retryable client error: return it to the caller as-is. Read the
        // error text off a CLONE so the original body still streams back.
        const errText = await upstream.clone().text().catch(() => "");
        store.pushLog({ ts: Date.now(), model, upstreamModel, provider: provider.name, providerId: provider.id, format: wire, status: upstream.status, ms: Date.now() - start, stream, thinking: think, error: shortError(errText) || `HTTP ${upstream.status}` });
        capture(upstream.status, errText, false, shortError(errText) || `HTTP ${upstream.status}`);
        return passThrough(upstream, isProbe ? provider.name : undefined);
      }

      const last = order[order.length - 1];
      const lastUpstreamModel = last.model && last.model !== model ? last.model : undefined;
      // Every slot in this round failed retryably. rpm-capped candidates
      // remain - queue for their next slot instead of erroring the client.
      if (pinIndex == null && capped.length) {
        if (await waitForSlot(capped)) continue;
        return new Response(null, { status: 499 });
      }
      if (!isProbe) rt.error(`proxy all providers failed model=${model} (last status ${lastStatus})`);
      store.pushLog({ ts: Date.now(), model, upstreamModel: lastUpstreamModel, provider: last.provider.name, providerId: last.provider.id, format: wire, status: lastStatus, ms: Date.now() - start, stream, thinking: lastThink, error: lastErr || `all providers failed (last status ${lastStatus})` });
      // A pinned (per-source) probe failed: surface the REAL upstream status the
      // one slot returned (429/500/…), not a collapsed 502, and tag it with
      // x-myapikey-provider so the source-row badge names the tested source.
      if (pinIndex != null) {
        const h = new Headers({ "content-type": "application/json" });
        if (isProbe) h.set("x-myapikey-provider", encodeTag(last.provider.name));
        return new Response(
          JSON.stringify({ error: { message: lastErr || `provider failed (status ${lastStatus})`, type: "upstream_error" } }),
          { status: lastStatus, headers: h },
        );
      }
      return c.json(
        { error: { message: `all providers for '${model}' failed (last status ${lastStatus})`, type: "upstream_error" } },
        502,
      );
    }
  };

  // OpenAI surface: chat/completions + responses (/models is registered above,
  // before the auth middleware, so it stays public).
  openai.post("/chat/completions", (c) => dispatch(c, "openai"));
  // OpenAI Responses API — its own routing slot (sources must be supportsResponses).
  openai.post("/responses", (c) => dispatch(c, "responses"));

  // Anthropic surface: messages (/models likewise registered above, public).
  anthropic.post("/messages", (c) => dispatch(c, "anthropic"));

  return { openai, anthropic };
}
