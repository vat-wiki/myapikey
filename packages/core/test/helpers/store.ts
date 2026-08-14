import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/server/store";
import { createLogger } from "../../src/server/logger";

/** Silent runtime logger for tests: no console output, no server.log file —
 *  otherwise every failover/auth-failure a test exercises would print and
 *  write to disk. Stateless, so one shared instance is fine. */
const quietLogger = createLogger({ console: false });

/** A Store rooted in a fresh throwaway data dir, plus a `cleanup()` that nukes
 *  it. Use in beforeEach/afterEach so every test starts from a pristine
 *  data.json + logs.jsonl. */
export interface TmpStore {
  store: Store;
  dir: string;
  /** Recursively remove the temp dir (idempotent). */
  cleanup: () => void;
}

/** Empty store: the constructor creates a fresh `defaultConfig()` data.json. */
export function tmpStore(): TmpStore {
  const dir = mkdtempSync(join(tmpdir(), "myapikey-test-"));
  return { store: new Store(dir, { logger: quietLogger }), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Seed a raw JSON document as data.json, THEN construct the Store — so the
 *  constructor's `load()` runs its migration path against whatever you wrote.
 *  Use this to exercise legacy config shapes (v1/v2/v3) and broken-JSON guards. */
export function tmpStoreFromRaw(raw: unknown): TmpStore {
  const dir = mkdtempSync(join(tmpdir(), "myapikey-test-"));
  writeFileSync(join(dir, "data.json"), JSON.stringify(raw));
  return { store: new Store(dir, { logger: quietLogger }), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
