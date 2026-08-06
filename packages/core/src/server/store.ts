import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, newApiKey, CONFIG_VERSION } from "../shared/config";
import type { GateConfig, LogEntry, Provider } from "../shared/types";

const MAX_LOG = 200;

/**
 * Owns a single data directory (default ~/.myapikey): data.json holds the
 * config, logs.jsonl holds recent calls. Reads config into memory at startup,
 * writes through on every mutation. Mutations are serialized via a promise
 * chain so concurrent admin requests can't trample each other.
 */
export class Store {
  private data: GateConfig;
  private readonly dataDir: string;
  private readonly dataPath: string;
  private readonly logsPath: string;
  private readonly credentialsPath: string;
  private chain: Promise<unknown> = Promise.resolve();
  /** Line count of the on-disk log (drives periodic trimming). The entries
   *  themselves are persisted to logs.jsonl, never held in memory. */
  private logCount = 0;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dataPath = join(dataDir, "data.json");
    this.logsPath = join(dataDir, "logs.jsonl");
    this.credentialsPath = join(dataDir, "credentials.txt");
    this.data = this.load();
    this.logCount = this.countLogs();
  }

  /** Resolved on-disk locations (for read-only display in Settings). */
  getPaths(): { dataDir: string; dataFile: string; logsFile: string; credentialsFile: string } {
    return {
      dataDir: this.dataDir,
      dataFile: this.dataPath,
      logsFile: this.logsPath,
      credentialsFile: this.credentialsPath,
    };
  }

  /**
   * Write a human-readable credentials.txt (web login + /v1 api key), current
   * as of this boot. So a brand-new user — or anyone who closed the startup
   * terminal / runs serve as a daemon — can still recover the login: just
   * `cat <dataDir>/credentials.txt`. Regenerated on every startup, so it stays
   * correct after a password change + restart. Returns the file path.
   */
  writeCredentialsFile(): string {
    const { account, apiKey } = this.data;
    const body = [
      "MyAPIKey credentials",
      "====================",
      "",
      "Web UI login:",
      `  username: ${account.username}`,
      `  password: ${account.password}`,
      "",
      "API key (for agents calling /v1):",
      `  ${apiKey}`,
      "",
      "Regenerated on each startup. If you change the password in Settings, this",
      'file updates on the next restart. Safe to delete once you\'ve saved the',
      "credentials elsewhere.",
      "",
    ].join("\n");
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.credentialsPath, body);
    return this.credentialsPath;
  }

  private load(): GateConfig {
    if (!existsSync(this.dataPath)) {
      const fresh = defaultConfig();
      this.persist(fresh);
      return fresh;
    }
    const raw = JSON.parse(readFileSync(this.dataPath, "utf8")) as GateConfig;
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
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.dataPath, JSON.stringify(d, null, 2));
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

  /** Append a call to the on-disk log (one JSON object per line). */
  pushLog(entry: LogEntry): void {
    appendFileSync(this.logsPath, JSON.stringify(entry) + "\n");
    this.logCount++;
    // Bound the file: once it drifts past 2× the cap, drop the oldest lines.
    if (this.logCount > MAX_LOG * 2) this.trimLogs();
  }

  /** Recent log entries, newest first, capped at MAX_LOG. */
  getLogs(): LogEntry[] {
    if (!existsSync(this.logsPath)) return [];
    const entries: LogEntry[] = [];
    for (const line of readFileSync(this.logsPath, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        entries.push(JSON.parse(s) as LogEntry);
      } catch {
        // Partial tail line if the process was interrupted mid-append; skip it.
      }
    }
    return entries.slice(-MAX_LOG).reverse();
  }

  /** Rewrite the log file keeping only the most recent MAX_LOG entries. */
  private trimLogs(): void {
    const lines = readFileSync(this.logsPath, "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(-MAX_LOG);
    writeFileSync(this.logsPath, kept.length ? kept.map((l) => l + "\n").join("") : "");
    this.logCount = kept.length;
  }

  private countLogs(): number {
    if (!existsSync(this.logsPath)) return 0;
    return readFileSync(this.logsPath, "utf8").split("\n").filter(Boolean).length;
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
