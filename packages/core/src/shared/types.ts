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
  /** Whether this backend also implements the OpenAI Responses API (/responses).
   *  NOT implied by `formats` — many openai-compatible backends lack it. Opt-in. */
  supportsResponses?: boolean;
  /** Model ids this provider offered at last discovery (cached, may be stale). */
  discoveredModels?: string[];
  /** Epoch ms of the last successful/attempted discovery. */
  discoveredAt?: number;
  createdAt: number;
}

/** One routing slot: an independent enable flag + a priority-ordered provider
 *  chain. Invariant (enforced by admin mutations, defended by proxy candidates()):
 *  every id in `providers` exists in `GateConfig.providers` and is compatible
 *  with the slot — openai/anthropic ids must carry that wire format; responses
 *  ids must additionally be supportsResponses sources (still OpenAI-format). */
export interface FormatEntry {
  enabled: boolean;
  /** Provider ids in priority order. First = primary, rest = fallback. */
  providers: string[];
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

/** One persisted call-history entry (stored in logs.jsonl, one JSON object per line). */
export interface LogEntry {
  ts: number;
  model: string;
  provider: string;
  format: Format;
  status: number;
  /** End-to-end latency (ms): from the dispatch start to the returned response. */
  ms: number;
  /** Whether the request asked for streaming. */
  stream: boolean;
  /** Short upstream error text on non-2xx (omitted on success). */
  error?: string;
}
