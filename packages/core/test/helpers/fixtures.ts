import type { ChainSlot, FormatEntry, GateConfig, LogEntry, ModelEntry, Provider } from "../../src/shared/types";
import type { Store } from "../../src/server/store";

let seq = 0;
const next = (): number => ++seq;

/** A Provider with sane defaults; pass a partial to override (id is the main
 *  thing tests reference, since routing + circuit-breaker + stats key on it). */
export function makeProvider(over: Partial<Provider> = {}): Provider {
  const n = next();
  const defaults: Provider = {
    id: `prv_${n}`,
    name: `provider-${n}`,
    baseUrlOpenai: "https://up.openai.test/v1",
    baseUrlAnthropic: "https://up.anthropic.test",
    apiKey: "sk-up-test",
    formats: ["openai"],
    createdAt: 1000,
  };
  return { ...defaults, ...over };
}

/** A routing slot: enabled iff the chain is non-empty (matches the admin
 *  invariant — an enabled-but-empty slot would 404). `slots` accepts bare ids
 *  (`fe(["a","b"])`) or per-slot pairs carrying an upstream model
 *  (`fe([{id:"a",model:"up-a"},{"id":"b"}])`); a duplicate id is legal
 *  (`fe(["a","a"])` — two failover slots under one source). */
export function fe(slots: (string | ChainSlot)[], over: { enabled?: boolean } = {}): FormatEntry {
  const providers: ChainSlot[] = slots.map((s) => (typeof s === "string" ? { id: s } : s));
  return { enabled: over.enabled ?? providers.length > 0, providers };
}

/** A model entry; defaults to all slots disabled/empty. Non-slot fields
 *  (e.g. `paceRpm`) pass through as-is. */
export function makeModel(slots: Partial<ModelEntry> = {}): ModelEntry {
  const { openai, anthropic, responses, ...rest } = slots;
  return {
    ...rest,
    openai: openai ?? fe([]),
    anthropic: anthropic ?? fe([]),
    responses: responses ?? fe([]),
  };
}

/** A log entry with sane defaults. */
export function makeLog(over: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: 1000,
    model: "gpt-4o",
    provider: "provider-1",
    providerId: "prv_1",
    format: "openai",
    status: 200,
    ms: 50,
    stream: false,
    ...over,
  };
}

/** A complete GateConfig with sensible empty defaults. */
export function buildConfig(over: Partial<GateConfig> = {}): GateConfig {
  return {
    version: 5,
    account: { username: "admin", password: "password123" },
    apiKey: "sk-myapikey-test",
    providers: [],
    models: {},
    ...over,
  };
}

/** Seed a store's config in one shot (write-through). Pass only the fields you
 *  want to replace; others are left intact. */
export function seedStore(store: Store, cfg: Partial<GateConfig>): Promise<GateConfig> {
  return store.update((d) => {
    if (cfg.version !== undefined) d.version = cfg.version;
    if (cfg.account) d.account = cfg.account;
    if (cfg.apiKey !== undefined) d.apiKey = cfg.apiKey;
    if (cfg.providers !== undefined) d.providers = cfg.providers;
    if (cfg.models !== undefined) d.models = cfg.models;
  });
}
