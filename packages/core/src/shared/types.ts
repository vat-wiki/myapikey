/**
 * Shared data model for MyAPIKey.
 * One config object, persisted as a single JSON file (data.json).
 */

/** Wire format a backend speaks (and that we expose on the matching path). */
export type Format = "openai" | "anthropic";

/** A backend / subscription platform / direct provider. */
export interface Provider {
  id: string; // prv_<rand>
  name: string; // human label, also used as CLI handle
  /** OpenAI-family base INCLUDING the version segment, e.g. https://api.openai.com/v1
   *  or Ark's /api/v3. Used for /chat/completions, /responses, /models. */
  baseUrlOpenai: string;
  /** Anthropic base EXCLUDING /v1, e.g. https://api.anthropic.com or Ark's /api/coding.
   *  The gateway appends /v1/messages (and /v1/models for discovery). */
  baseUrlAnthropic: string;
  apiKey: string;
  /** Which wire formats this backend responds to. */
  formats: Format[];
  /** Optional request-per-minute cap (RPM pacing). When set, dispatch skips this
   *  source once it has forwarded `rpm` calls in the trailing 60s window — the
   *  request fails over to the next source instead of racing the upstream's own
   *  rate limit (and burning a free/quota-bound key). 0/absent = unlimited.
   *  The limit is on the key, so it's per-source and shared across every model
   *  routed through it. Tracked in-memory only (see Store.rpmUsed). */
  rpm?: number;
  /** Whether this backend also implements the OpenAI Responses API (/responses).
   *  NOT implied by `formats` — many openai-compatible backends lack it. Opt-in. */
  supportsResponses?: boolean;
  /** Model ids this provider offered at last discovery (cached, may be stale). */
  discoveredModels?: string[];
  /** Epoch ms of the last successful/attempted discovery. */
  discoveredAt?: number;
  createdAt: number;
}

/** One routing slot: an independent enable flag + a priority-ordered chain of
 *  (provider, optional upstream model) pairs. Invariant (enforced by admin
 *  mutations, defended by proxy candidates()): every id in `providers` exists in
 *  `GateConfig.providers` and is compatible with the slot — openai/anthropic ids
 *  must carry that wire format; responses ids must additionally be
 *  supportsResponses sources (still OpenAI-format).
 *
 *  A provider id may appear MORE THAN ONCE — each occurrence is an independent
 *  failover slot that can carry its own upstream model name. When forwarding to
 *  a slot, if its `model` is set the gateway rewrites the request's `model`
 *  field to that value before the passthrough POST; otherwise the public model
 *  name (the key in GateConfig.models) is sent verbatim. That is a pure name
 *  rewrite on the passthrough body — still no OpenAI↔Anthropic translation. It
 *  lets you alias (claude-sonnet-4 → claude-sonnet-4-20250514), swap the actual
 *  model (gpt-4 → gpt-4o) per source, or fail over across several models on ONE
 *  backend (Ark → doubao-pro primary, Ark → doubao-lite fallback). Absent model
 *  = identity (send the public name). */
export interface FormatEntry {
  enabled: boolean;
  /** Ordered chain of routing slots: first = primary, rest = fallback. The same
   *  provider id may repeat — each occurrence can map a different upstream model. */
  providers: ChainSlot[];
}

/** One slot in a format's provider chain: which provider to forward to, and the
 *  optional upstream model name to rewrite the request's `model` field to.
 *  Duplicates of `id` are legal (distinct failover slots). */
export interface ChainSlot {
  id: string;
  /** Upstream model name to send to this provider. Absent = forward the public
   *  model name (the key in GateConfig.models) unchanged. */
  model?: string;
}

/** A model's routing dimensions — one per forwarding endpoint. /chat/completions
 *  (openai) and /responses are separate OpenAI-family endpoints with different
 *  URLs, so they route independently: each has its own enable + chain. A
 *  supportsResponses source can sit in BOTH the openai and the responses chains. */
export type RouteKey = "openai" | "anthropic" | "responses";

/** Per-model routing entry, keyed by model name (e.g. "gpt-4o"). */
export interface ModelEntry {
  openai: FormatEntry;
  anthropic: FormatEntry;
  responses: FormatEntry;
}

export interface Account {
  username: string;
  password: string;
}

export interface GateConfig {
  version: number;
  account: Account;
  /** Secret agents use to call /v1 (Bearer / x-api-key). Separate from the account password. */
  apiKey: string;
  providers: Provider[];
  /** modelName -> routing entry. */
  models: Record<string, ModelEntry>;
}

/** Token usage for a single call. Captured from the upstream's reported usage
 *  when available — that's the exact billed count (Anthropic streams, non-
 *  streaming bodies, /responses all carry it). For OpenAI /chat/completions
 *  streams where the upstream omits usage (most agents don't set
 *  stream_options.include_usage), `estimated` is set and input/output come from
 *  a local tokenizer approximation (gpt-tokenizer, o200k_base) instead — the UI
 *  renders those with a ≈ marker. cacheRead/cacheCreation (prompt-caching hits,
 *  Anthropic-only) are surfaced separately from `input`. */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  estimated?: boolean;
}

/** One persisted call-history entry (stored in logs.jsonl, one JSON object per line). */
export interface LogEntry {
  ts: number;
  model: string;
  provider: string;
  /** Stable provider id (newer entries). Stats group by this so renaming a
   *  provider doesn't split its history; the display name is resolved from the
   *  live config at read time. Absent on legacy lines → fall back to `provider`. */
  providerId?: string;
  format: Format;
  status: number;
  /** End-to-end latency (ms): from the dispatch start to the returned response. */
  ms: number;
  /** Whether the request asked for streaming. */
  stream: boolean;
  /** Token usage for this call (success rows only). Absent when the upstream
   *  reported none AND no local estimate was possible (e.g. a failed/truncated
   *  stream), or on legacy log lines written before usage tracking. */
  usage?: Usage;
  /** Short upstream error text on non-2xx (omitted on success). */
  error?: string;
  /** Row kind. Absent on legacy lines → treated as a normal call. "cooldown"
   *  marks a circuit-breaker event (a provider just entered cooldown), shown
   *  distinctly in the timeline alongside the failures that caused it. */
  kind?: "call" | "cooldown";
  /** Present only on cooldown rows: the cooldown duration and the consecutive
   *  failure count that triggered it. */
  cooldownMs?: number;
  fails?: number;
}
