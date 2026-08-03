import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultConfig } from "../shared/config";
import type { GateConfig, LogEntry } from "../shared/types";

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
