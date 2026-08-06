import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultConfig, newApiKey, CONFIG_VERSION } from "../shared/config";
import type { GateConfig, LogEntry, Provider } from "../shared/types";

const MAX_LOG = 200;

/**
 * Owns the single data.json file. Reads once into memory at startup, writes
 * through on every mutation. Mutations are serialized via a promise chain so
 * concurrent admin requests can't trample each other.
 */
export class Store {
  private data: GateConfig;
  private readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();
  /** Recent call log (in-memory ring buffer, not persisted). */
  readonly logs: LogEntry[] = [];

  constructor(path: string) {
    this.path = path;
    this.data = this.load();
  }

  private load(): GateConfig {
    if (!existsSync(this.path)) {
      const fresh = defaultConfig();
      this.persist(fresh);
      return fresh;
    }
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as GateConfig;
    // Light sanity check; fall back to defaults if structurally broken.
    if (!raw || typeof raw !== "object" || !raw.account) return defaultConfig();
    raw.providers ??= [];
    raw.models ??= {};
    // Migration: older configs had no separate API key (the account password
    // doubled as one). Generate one and persist immediately so it's stable
    // across restarts (not regenerated on every boot until the next change).
    if (!raw.apiKey) {
      raw.apiKey = newApiKey();
      this.persist(raw);
    }
    // Migration: model entries were { enabled, providers[] } (v1), then
    // { openai, anthropic } (v2). Split into three routing slots
    // { openai, anthropic, responses } so /responses routes independently.
    // Idempotent; persisted immediately so the upgrade is stable across restarts.
    if (migrateModels(raw) || migrateProviders(raw) || !raw.version || raw.version < CONFIG_VERSION) {
      raw.version = CONFIG_VERSION;
      this.persist(raw);
    } else if (raw.version > CONFIG_VERSION) {
      console.warn(
        `myapikey: data.json version ${raw.version} is newer than supported ${CONFIG_VERSION}; continuing best-effort.`,
      );
    }
    return raw;
  }

  private persist(d: GateConfig): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(d, null, 2));
  }

  /** Read current config (from memory). */
  get(): GateConfig {
    return this.data;
  }

  /** Mutate config; persisted atomically after fn runs. */
  async update(fn: (d: GateConfig) => void): Promise<GateConfig> {
    const run = this.chain.then(() => {
      fn(this.data);
      this.persist(this.data);
      return this.data;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  pushLog(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
  }
}

/**
 * Model migration to the three-slot shape { openai, anthropic, responses }.
 *  - v1 `{ enabled, providers[] }` → split each id by the formats it speaks,
 *    plus a responses slot from supportsResponses sources.
 *  - v2 `{ openai, anthropic }` → add a responses slot split from the openai
 *    chain's supportsResponses sources (the openai chain keeps them too —
 *    /chat/completions uses all OpenAI sources, /responses uses the subset).
 * A slot is enabled only if its chain is non-empty (an enabled-but-empty slot
 * would 404 on that endpoint). Dangling ids (provider since deleted) are
 * dropped. Returns true if any entry was rewritten; v3 entries are skipped, so
 * this is idempotent.
 */
function migrateModels(raw: GateConfig): boolean {
  const models = raw.models as Record<string, unknown>;
  if (!models || typeof models !== "object") return false;
  const byId = new Map(raw.providers.map((p) => [p.id, p]));
  let changed = false;
  for (const [name, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object") continue;
    if ("responses" in entry) continue; // already v3

    if ("openai" in entry && "anthropic" in entry) {
      // v2 (two slots) → v3: responses split out of the openai chain.
      const e = entry as { openai: { enabled: boolean; providers: string[] } };
      const responses = e.openai.providers.filter((pid) => byId.get(pid)?.supportsResponses);
      (entry as unknown as { responses: { enabled: boolean; providers: string[] } }).responses = {
        enabled: e.openai.enabled && responses.length > 0,
        providers: responses,
      };
      changed = true;
      continue;
    }

    // v1 { enabled, providers[] } → v3 (three slots).
    const e = entry as { enabled?: boolean; providers?: string[] };
    const oldEnabled = !!e.enabled;
    const oldChain = Array.isArray(e.providers) ? e.providers : [];
    const openai = oldChain.filter((pid) => byId.get(pid)?.formats.includes("openai"));
    const anthropic = oldChain.filter((pid) => byId.get(pid)?.formats.includes("anthropic"));
    const responses = oldChain.filter((pid) => byId.get(pid)?.supportsResponses);
    models[name] = {
      openai: { enabled: oldEnabled && openai.length > 0, providers: openai },
      anthropic: { enabled: oldEnabled && anthropic.length > 0, providers: anthropic },
      responses: { enabled: oldEnabled && responses.length > 0, providers: responses },
    };
    changed = true;
  }
  return changed;
}

/**
 * Provider migration to per-format base URLs (v3 → v4).
 *  - v3 had a single `baseUrl` (incl. the version segment) shared by both formats.
 *  - v4 splits it: the OpenAI base keeps the version; the Anthropic base drops the
 *    trailing /vN (the gateway now appends v1/messages), reconstructing the
 *    documented Anthropic base (which never includes /v1).
 * Idempotent: v4 providers (no string `baseUrl`) are skipped. Returns true if any
 * provider was rewritten.
 */
function migrateProviders(raw: GateConfig): boolean {
  let changed = false;
  for (const p of raw.providers as (Provider & { baseUrl?: string })[]) {
    if (typeof p.baseUrl !== "string") continue; // already v4
    const old = p.baseUrl;
    p.baseUrlOpenai = old;
    const stripped = old.replace(/\/v\d+$/, "");
    p.baseUrlAnthropic = stripped || old;
    delete p.baseUrl;
    changed = true;
  }
  return changed;
}
