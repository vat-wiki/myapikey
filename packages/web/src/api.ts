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
  discoveredAt?: number | null;
  createdAt: number;
}

export interface ModelProvider {
  id: string;
  name: string;
  /** Upstream model name this source is mapped to on this route
   *  (undefined = send the public model name verbatim). */
  model?: string;
}
export interface FormatView {
  enabled: boolean;
  providers: ModelProvider[];
}
export interface ModelView {
  name: string;
  openai: FormatView;
  anthropic: FormatView;
  responses: FormatView;
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

/** Token usage for one call. `estimated` marks local-tokenizer approximations
 *  (OpenAI chat streams where the upstream omitted usage) — rendered with ≈. */
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
  byDay: StatDay[];
}
