/**
 * Shared data model for my-ai-gate.
 * One config object, persisted as a single JSON file (data.json).
 */

/** Wire format a backend speaks (and that we expose on the matching path). */
export type Format = "openai" | "anthropic";

/** A backend / subscription platform / direct provider. */
export interface Provider {
  id: string; // prv_<rand>
  name: string; // human label, also used as CLI handle
  /** Base URL INCLUDING the /v1 segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** Which wire formats this backend responds to. */
  formats: Format[];
  createdAt: number;
}

/** Per-model routing entry. Keyed by model name (e.g. "gpt-4o"). */
export interface ModelEntry {
  enabled: boolean;
  /** Provider ids in priority order. First = primary, rest = fallback. */
  providers: string[];
}

export interface Account {
  username: string;
  password: string;
}

export interface GateConfig {
  version: number;
  account: Account;
  providers: Provider[];
  /** modelName -> routing entry. */
  models: Record<string, ModelEntry>;
}

/** Options for logging call history (in-memory ring buffer). */
export interface LogEntry {
  ts: number;
  model: string;
  provider: string;
  format: Format;
  status: number;
  bytesOut: number;
}
