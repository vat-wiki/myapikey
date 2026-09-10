const KEY = "myapikey.creds";

export interface Creds {
  user: string;
  pass: string;
}

export function getCreds(): Creds | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.user && j.pass) return { user: j.user, pass: j.pass };
  } catch {
    /* ignore */
  }
  return null;
}

export function setCreds(user: string, pass: string): void {
  localStorage.setItem(KEY, JSON.stringify({ user, pass }));
}

export function clearCreds(): void {
  localStorage.removeItem(KEY);
}

/** Authed JSON request to the gateway (admin API or proxy). */
export async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const c = getCreds();
  if (!c) throw new Error("Not authenticated");
  const res = await fetch(path, {
    method,
    headers: {
      authorization: "Basic " + btoa(`${c.user}:${c.pass}`),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep as text */
  }
  if (!res.ok) {
    const msg =
      (json as { error?: { message?: string } } | null)?.error?.message ?? text ?? res.statusText;
    throw new Error(String(msg));
  }
  return json as T;
}

/** One protocol row of a source-level test (POST /admin/providers/:id/test):
 *  a minimal ping sent straight to the source (no model routing involved). */
export interface ProviderTestResult {
  format: string;
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
}

export interface ProviderPublic {
  id: string;
  name: string;
  baseUrlOpenai: string;
  baseUrlAnthropic: string;
  formats: string[];
  supportsResponses?: boolean;
  apiKey: string;
  /** Request-per-minute cap (0 = unlimited). Pacing: once hit, dispatch fails
   *  over to the next source instead of racing the upstream's own limit. */
  rpm: number;
  discoveredModels?: string[];
  /** Manually supplemented upstream ids (the source-models dialog) — merged
   *  with discoveredModels everywhere suggestions/staleness are computed. */
  extraModels?: string[];
  discoveredAt?: number | null;
  createdAt: number;
}

export interface ModelProvider {
  id: string;
  name: string;
  /** Upstream model name this source is mapped to on this route
   *  (undefined = send the public model name verbatim). */
  model?: string;
  /** Default thinking level for this slot on this route (undefined = pure
   *  passthrough). Effort token on openai/responses routes, thinking budget
   *  tokens (integer) on anthropic routes. When set it OVERRIDES whatever
   *  thinking parameters the request carried. */
  thinking?: string;
}
export interface FormatView {
  enabled: boolean;
  providers: ModelProvider[];
}
/** Where this model's traffic ACTUALLY landed most recently (one entry per
 *  protocol, from the latest successful call in the log tail). Lets the UI
 *  show the in-use slot after a failover instead of the configured first. */
export interface LastRoute {
  format: string;
  providerId: string;
  /** The upstream model name that was actually forwarded. */
  model: string;
  ts: number;
}
/** The latest FAILED call per (model, protocol) from the log tail — lets the
 *  chain popover flag slots that recently errored, with the real message. */
export interface LastFail {
  format: string;
  providerId: string;
  model: string;
  status: number;
  error?: string;
  ts: number;
}
export interface ModelView {
  name: string;
  openai: FormatView;
  anthropic: FormatView;
  responses: FormatView;
  /** Per-model even-pacing limit (requests/min, 0 = unlimited). Calls are
   *  spread one every 60/rpm seconds; excess queue at the gateway. */
  paceRpm: number;
  /** Debug capture switch (in-memory ring buffer of actual upstream bodies). */
  debugCapture?: boolean;
  lastRoute?: LastRoute[];
  lastFail?: LastFail[];
}

/** One debug-captured upstream attempt (GET /admin/models/:name/debug). In-memory
 *  only — cleared when the model's debug switch turns off or the gateway restarts. */
export interface DebugCapture {
  ts: number;
  model: string;
  provider: string;
  providerId: string;
  format: string;
  /** The upstream model name actually sent (post per-slot rewrite); absent when
   *  the public name went through verbatim. */
  upstreamModel?: string;
  /** Upstream HTTP status (0 = network error / never reached). */
  status: number;
  ms: number;
  stream: boolean;
  /** The exact forwarded request body (JSON text). */
  request: string;
  /** The upstream response body as it flowed (raw SSE text for streams). */
  response?: string;
  truncated?: boolean;
  error?: string;
  thinking?: { value: string; from: "client" | "default" };
}

/** One provider's circuit-breaker state (GET /admin/circuit). Mirrors the
 *  server's CircuitView: `cooling` = currently skipped (cooldown active),
 *  `open` = healthy/eligible. */
export interface CircuitProvider {
  id: string;
  name: string;
  state: "open" | "cooling";
  fails: number;
  secondsLeft: number;
  until: number;
  lastStatus: number;
  lastReason: string;
  lastTs: number;
  /** Configured RPM cap (0 = unlimited). */
  rpm: number;
  /** Calls forwarded to this source in the trailing 60s window. */
  rpmUsed: number;
}

/** Token usage for one call. `input` is UNCACHED prompt tokens (cache hits are
 *  reported separately, even on wires where the upstream folds them into
 *  prompt_tokens). `estimated` marks local-tokenizer approximations (OpenAI
 *  chat streams where the upstream omitted usage) — rendered with ≈. */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  estimated?: boolean;
}

/** One bucket in a stats breakdown (GET /admin/stats). `id` is set only on
 *  provider buckets (the stable grouping key); `key` is the display label. */
export interface StatBucket {
  key: string;
  id?: string;
  calls: number;
  success: number;
  error: number;
  avgMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache read hits (Anthropic `cache_read_input_tokens`; OpenAI-family
   *  `prompt_tokens_details.cached_tokens` / DeepSeek `prompt_cache_hit_tokens`). */
  cacheRead: number;
  /** Prompt-cache creation/write tokens (Anthropic `cache_creation_input_tokens`). */
  cacheCreation: number;
  /** cacheRead / (inputTokens + cacheRead + cacheCreation). 0 when none. */
  cacheHitRate: number;
}

/** One provider×model cell in the cache breakdown. `provider` is the live
 *  display name (rename-safe). */
export interface ProviderModelStat {
  providerId: string;
  provider: string;
  model: string;
  calls: number;
  success: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  cacheHitRate: number;
}

/** One day in the stats time series (YYYY-MM-DD, local). */
export interface StatDay {
  day: string;
  calls: number;
  success: number;
  error: number;
}

/** Aggregated call stats (GET /admin/stats?range=…). */
export interface StatsResult {
  from: number;
  to: number;
  totals: {
    calls: number;
    success: number;
    error: number;
    errorRate: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
  };
  byModel: StatBucket[];
  byProvider: StatBucket[];
  byFormat: StatBucket[];
  byProviderModel: ProviderModelStat[];
  byDay: StatDay[];
}
