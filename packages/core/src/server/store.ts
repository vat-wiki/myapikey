import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, newApiKey, CONFIG_VERSION } from "../shared/config";
import type { GateConfig, LogEntry, Provider } from "../shared/types";
import { createLogger, type Logger } from "./logger";

/** Call-log retention: the log is bounded two ways — never older than this, and
 *  never more than LOG_MAX_LINES entries. Whichever binds first. 90 days covers
 *  usage-trend ranges; the 1M line cap is a safety valve for runaway volume. */
const LOG_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const LOG_MAX_LINES = 1_000_000;
/** Run a full age+count trim at most once per this many NEW lines, so the trim
 *  cost (a whole-file rewrite) is amortized instead of paid on every call. The
 *  1M cap is also checked directly so it can't overshoot between checks. */
const LOG_TRIM_CHECK_EVERY = 5_000;
/** How many recent lines GET /admin/logs returns (the "recent calls" timeline).
 *  The full history lives in the same file for stats — this is just the tail. */
const LOG_RECENT = 200;
/** Tail-read window for the recent-calls view: large enough to hold LOG_RECENT
 *  lines even with chunky error text, so getLogs() never reads the whole file. */
const LOG_TAIL_BYTES = 512 * 1024;

/** Circuit-breaker backoff: a transient failure cools a provider for BASE ms,
 *  doubling each consecutive failure up to CAP. Resets on the next success. */
const CB_BASE = 30_000;
const CB_CAP = 300_000;
// Floor for honoring an upstream Retry-After hint — small positive values (a
// lenient "Retry-After: 0"/sub-second) shouldn't read as "no cooldown" and let
// us re-hammer a just-rate-limited source in a tight loop.
const CB_MIN = 1_000;
// Ceiling for a reset DEADLINE parsed out of an error body (e.g. Volcengine Ark's
// 1308 "您的限额将在 <datetime> 重置" — a quota window, not a backoff guess).
// Larger than CB_CAP because a quota reset is a real future event the source
// explicitly told us about: while cooling the source is SKIPPED, so honoring the
// true reset avoids re-probing a source we KNOW is rate-limited. Sanity-bound so a
// malformed body can't take a source offline for more than a work day.
const RESET_CAP_MS = 6 * 60 * 60 * 1000;

/** RPM pacing window: a source's `rpm` cap counts calls within this trailing
 *  window. 60s matches the usual "requests per minute" limit. */
const RPM_WINDOW_MS = 60_000;

/** Even-pacing queue cap: a request whose reserved slot is further out than
 *  this gets rejected (429) instead of queueing. Bounds both the client's hang
 *  time and the queue depth (at N rpm / 60s wait, at most ~N requests queue). */
const PACE_MAX_WAIT_MS = 60_000;

/** Per-provider circuit state (in-memory, never persisted). */
interface CircuitEntry {
  fails: number;
  /** Epoch ms until which the provider is skipped. 0 = open. */
  until: number;
  lastStatus: number;
  lastReason: string;
  lastTs: number;
}

/** Read-only circuit view exposed at GET /admin/circuit. */
export interface CircuitView {
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
  /** Calls forwarded to this source within the trailing 60s window. */
  rpmUsed: number;
}

/** One bucket in a stats breakdown (by model / provider / format). `id` is set
 *  only on provider buckets (the stable grouping key); `key` is the label shown. */
export interface StatBucket {
  key: string;
  id?: string;
  calls: number;
  success: number;
  error: number;
  avgMs: number;
  /** Token totals for this bucket (success rows only). */
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache read hits summed across this bucket's rows (Anthropic/Ark
   *  cache_read_input_tokens). 0 for buckets with no caching. */
  cacheRead: number;
  /** Prompt-cache creation (write) tokens summed across this bucket's rows
   *  (cache_creation_input_tokens). */
  cacheCreation: number;
  /** cacheRead / (inputTokens + cacheRead + cacheCreation): "of all prompt
   *  tokens, how many were served from cache." 0 when there were no prompt
   *  tokens. */
  cacheHitRate: number;
}

/** One provider×model cell in the cache breakdown (GET /admin/stats). Groups
 *  the retained history by the stable provider id × the model name, so each
 *  source's per-model cache hit rate is visible. `provider` is the LIVE display
 *  name (resolved at read time from the config, so renaming a source doesn't
 *  split history — same invariant as `byProvider`). */
export interface ProviderModelStat {
  /** Stable provider id, or "" when the row had none (legacy name-only). */
  providerId: string;
  /** Live provider display name. */
  provider: string;
  model: string;
  calls: number;
  success: number;
  /** Fresh (non-cached) prompt tokens summed across this cell's rows. */
  inputTokens: number;
  /** Completion tokens summed across this cell's rows. */
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  cacheHitRate: number;
}

/** One day in the stats time series. */
export interface StatDay {
  /** YYYY-MM-DD (local). */
  day: string;
  calls: number;
  success: number;
  error: number;
}

/** Aggregated call stats for GET /admin/stats. */
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
    /** Token totals across the window (success rows only). cacheRead/
     *  cacheCreation are prompt-cache hits (Anthropic) — the cached input
     *  tokens, counted separately from `inputTokens`. A small fraction of
     *  rows (OpenAI chat streams where the upstream omitted usage) contribute
     *  local tokenizer ESTIMATES rather than billed counts. */
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
  };
  byModel: StatBucket[];
  byProvider: StatBucket[];
  byFormat: StatBucket[];
  /** Cache hit rate per source × model — every retained (provider, model) cell,
   *  so the UI can show each source's per-model caching. Rows with no cache
   *  activity carry 0 cache fields; the UI filters those for the cache view. */
  byProviderModel: ProviderModelStat[];
  byDay: StatDay[];
}

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
  private readonly serverLogPath: string;
  /** Process-level runtime log (server.log — errors + notable events). Owned
   *  by the Store like every other dataDir file; injectable for quiet tests. */
  private readonly logger: Logger;
  private chain: Promise<unknown> = Promise.resolve();
  /** Line count of the on-disk log (drives periodic trimming). The entries
   *  themselves are persisted to logs.jsonl, never held in memory. */
  private logCount = 0;
  /** logCount as of the last trim pass — bounds how often pushLog triggers one. */
  private lastTrimCount = 0;
  /** Per-provider circuit-breaker state (transient failures only). In-memory,
   *  NOT persisted (resets on restart). Mutated via the circuit* methods only,
   *  never through update()/persist(). */
  private circuit = new Map<string, CircuitEntry>();
  /** Per-provider dispatch timestamps within the RPM pacing window. In-memory,
   *  NOT persisted (resets on restart). Pruned as `rpmUsed` reads. */
  private rpm = new Map<string, number[]>();
  /** Per-model even-pacing queue: model name -> epoch ms of the next free
   *  release slot. In-memory, NOT persisted (resets on restart). */
  private pace = new Map<string, number>();

  constructor(dataDir: string, opts: { logger?: Logger } = {}) {
    this.dataDir = dataDir;
    this.dataPath = join(dataDir, "data.json");
    this.logsPath = join(dataDir, "logs.jsonl");
    this.credentialsPath = join(dataDir, "credentials.txt");
    this.serverLogPath = join(dataDir, "server.log");
    this.logger = opts.logger ?? createLogger({ file: this.serverLogPath });
    this.data = this.load();
    this.logCount = this.countLogs();
    // Don't trim on the very first post-startup call: let normal hysteresis do
    // it. (Stale >90-day data still gets cut at the next trim, within a few
    // thousand calls — there's no urgency to cleaning already-old rows.)
    this.lastTrimCount = this.logCount;
  }

  /** Resolved on-disk locations (for read-only display in Settings). */
  getPaths(): { dataDir: string; dataFile: string; logsFile: string; credentialsFile: string; serverLogFile: string } {
    return {
      dataDir: this.dataDir,
      dataFile: this.dataPath,
      logsFile: this.logsPath,
      credentialsFile: this.credentialsPath,
      serverLogFile: this.serverLogPath,
    };
  }

  /** Runtime log (console + server.log). Errors and notable events only —
   *  per-call history is pushLog/logs.jsonl, a separate surface. */
  getLogger(): Logger {
    return this.logger;
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
      "API key (for agents calling /openai/v1 + /anthropic/v1):",
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
    // Run every migrator unconditionally. Each is idempotent and returns
    // whether it rewrote anything. We deliberately do NOT chain them with ||
    // (which short-circuits): a v1 config makes migrateModels return true, which
    // would skip migrateFormatEntries, yet the version still bumps to
    // CONFIG_VERSION below — leaving v5-versioned data with unconverted string[]
    // chains that crash candidates() on the very same boot. Calling all three
    // every boot is cheap (they no-op once migrated) and closes that window.
    const m1 = migrateModels(raw);
    const m2 = migrateProviders(raw);
    const m3 = migrateFormatEntries(raw);
    if (m1 || m2 || m3 || !raw.version || raw.version < CONFIG_VERSION) {
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
    // Amortized trim: a full age+count pass at most once per LOG_TRIM_CHECK_EVERY
    // new lines, plus immediately if the hard line cap is crossed.
    if (this.logCount - this.lastTrimCount >= LOG_TRIM_CHECK_EVERY || this.logCount > LOG_MAX_LINES) {
      this.trimLogs();
    }
  }

  /** Recent log entries, newest first, capped at LOG_RECENT. Reads only the tail
   *  of the file (LOG_TAIL_BYTES) so the Logs page's 4s poll stays cheap no
   *  matter how large the retained history grows. */
  getLogs(): LogEntry[] {
    if (!existsSync(this.logsPath)) return [];
    const size = statSync(this.logsPath).size;
    const len = Math.min(size, LOG_TAIL_BYTES);
    const fd = openSync(this.logsPath, "r");
    try {
      const buf = Buffer.alloc(len);
      if (len > 0) readSync(fd, buf, 0, len, size - len);
      // If we sliced into the file, the first line is partial — drop it. When we
      // read the whole file the first line is complete.
      const lines = buf.toString("utf8").split("\n");
      const start = len < size ? 1 : 0;
      const entries: LogEntry[] = [];
      for (let i = start; i < lines.length; i++) {
        const s = lines[i].trim();
        if (!s) continue;
        try {
          entries.push(JSON.parse(s) as LogEntry);
        } catch {
          // Partial tail line if the process was interrupted mid-append; skip it.
        }
      }
      return entries.slice(-LOG_RECENT).reverse();
    } finally {
      closeSync(fd);
    }
  }

  /** Rewrite the log enforcing both bounds: drop entries older than
   *  LOG_MAX_AGE_MS, then trim to the most recent LOG_MAX_LINES. Malformed lines
   *  (a partial tail from an interrupted append) are dropped here too. */
  private trimLogs(): void {
    if (!existsSync(this.logsPath)) {
      this.logCount = 0;
      this.lastTrimCount = 0;
      return;
    }
    const lines = readFileSync(this.logsPath, "utf8").split("\n").filter(Boolean);
    const cutoff = Date.now() - LOG_MAX_AGE_MS;
    const kept: string[] = [];
    for (const line of lines) {
      let ts = 0;
      try {
        ts = (JSON.parse(line) as { ts?: number }).ts ?? 0;
      } catch {
        continue; // drop a malformed (partial-tail) line
      }
      if (ts >= cutoff) kept.push(line);
    }
    // Hard cap on total lines: keep only the most recent LOG_MAX_LINES.
    const final = kept.length > LOG_MAX_LINES ? kept.slice(kept.length - LOG_MAX_LINES) : kept;
    writeFileSync(this.logsPath, final.length ? final.map((l) => l + "\n").join("") : "");
    this.logCount = final.length;
    this.lastTrimCount = this.logCount;
  }

  private countLogs(): number {
    if (!existsSync(this.logsPath)) return 0;
    return readFileSync(this.logsPath, "utf8").split("\n").filter(Boolean).length;
  }

  /** Aggregate the retained call history into stats for GET /admin/stats. Reads
   *  the whole log (acceptable on a stats page load — it is never polled),
   *  filters to the given range (rangeMs = 0 means "all retained"), and excludes
   *  cooldown rows. Provider breakdown groups by the stable provider id and is
   *  labeled with the live name, so renaming a source doesn't split history. */
  getStats(rangeMs: number): StatsResult {
    const to = Date.now();
    const from = rangeMs > 0 ? to - rangeMs : 0;
    const empty: StatsResult = {
      from,
      to,
      totals: { calls: 0, success: 0, error: 0, errorRate: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 },
      byModel: [],
      byProvider: [],
      byFormat: [],
      byProviderModel: [],
      byDay: [],
    };
    if (!existsSync(this.logsPath)) return empty;

    const providerName = new Map(this.data.providers.map((p) => [p.id, p.name]));
    const model = new Map<string, Acc>();
    const provider = new Map<string, Acc>();
    const format = new Map<string, Acc>();
    const day = new Map<string, Acc>();
    /** provider×model cells for the cache breakdown. Keyed by `pid model`
     *  (null byte so a provider name can't collide with a model name). The
     *  display name is resolved at projection time, not stored here. */
    const providerModel = new Map<string, { providerId: string; model: string; a: Acc }>();
    const tot = newAcc();
    const latencies: number[] = [];

    for (const line of readFileSync(this.logsPath, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let e: LogEntry;
      try {
        e = JSON.parse(s) as LogEntry;
      } catch {
        continue;
      }
      if (e.kind === "cooldown") continue; // circuit-breaker event, not a call
      if (!e.ts || e.ts < from) continue;
      if (rangeMs > 0 && e.ts > to + 60_000) continue; // future (clock skew) — ignore
      const ok = e.status >= 200 && e.status < 300;
      const err = e.status >= 400;
      const ms = e.ms || 0;
      bump(tot, ok, err, e);
      latencies.push(ms);
      bump(acc(model, e.model), ok, err, e);
      bump(acc(provider, e.providerId ?? e.provider ?? "?"), ok, err, e);
      bump(acc(format, e.format ?? "?"), ok, err, e);
      bump(acc(day, dayKey(e.ts)), ok, err, e);
      // provider×model cell for the cache breakdown.
      const pid = e.providerId ?? e.provider ?? "?";
      const pmKey = pid + " " + e.model;
      let pm = providerModel.get(pmKey);
      if (!pm) {
        pm = { providerId: pid, model: e.model, a: newAcc() };
        providerModel.set(pmKey, pm);
      }
      bump(pm.a, ok, err, e);
    }

    latencies.sort((a, b) => a - b);
    const pick = (frac: number): number =>
      latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(frac * latencies.length))] : 0;

    // Fill every day in [startDay, today] so the chart x-axis is continuous
    // (zero-call days still appear). For "all", start at the earliest data day.
    const todayKey = dayKey(to);
    let startKey: string;
    if (rangeMs > 0) startKey = dayKey(from);
    else if (day.size) startKey = [...day.keys()].sort()[0];
    else startKey = todayKey;
    const byDay: StatDay[] = [];
    const [sy, sm, sd] = startKey.split("-").map(Number);
    // setDate/getDate iterate in local calendar days (DST-safe).
    for (let d = new Date(sy, (sm || 1) - 1, sd || 1); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
      const dk = dayKey(d.getTime());
      const a = day.get(dk);
      byDay.push({ day: dk, calls: a?.calls ?? 0, success: a?.success ?? 0, error: a?.error ?? 0 });
    }

    const sortDesc = (a: StatBucket, b: StatBucket) => b.calls - a.calls;
    return {
      from,
      to,
      totals: {
        calls: tot.calls,
        success: tot.success,
        error: tot.error,
        errorRate: tot.calls ? tot.error / tot.calls : 0,
        avgMs: tot.calls ? Math.round(tot.sumMs / tot.calls) : 0,
        p50Ms: pick(0.5),
        p95Ms: pick(0.95),
        inputTokens: tot.sumInput,
        outputTokens: tot.sumOutput,
        cacheRead: tot.sumCacheRead,
        cacheCreation: tot.sumCacheCreation,
      },
      byModel: [...model].map(([k, a]) => ({ key: k, ...fields(a) })).sort(sortDesc),
      byProvider: [...provider]
        .map(([k, a]) => {
          const isId = !!k && k !== "?" && this.data.providers.some((p) => p.id === k);
          return { key: isId ? providerName.get(k) ?? k : k, id: isId ? k : undefined, ...fields(a) };
        })
        .sort(sortDesc),
      byFormat: [...format].map(([k, a]) => ({ key: k, ...fields(a) })).sort(sortDesc),
      byProviderModel: [...providerModel.values()]
        .map(({ providerId: pid, model: m, a }) => {
          // Resolve the live display name when pid is a real provider id (so a
          // rename doesn't split history); otherwise fall back to the raw key.
          const isId = !!pid && pid !== "?" && this.data.providers.some((p) => p.id === pid);
          return {
            providerId: isId ? pid : "",
            provider: isId ? providerName.get(pid) ?? pid : pid,
            model: m,
            calls: a.calls,
            success: a.success,
            inputTokens: a.sumInput,
            outputTokens: a.sumOutput,
            cacheRead: a.sumCacheRead,
            cacheCreation: a.sumCacheCreation,
            cacheHitRate: hitRate(a.sumCacheRead, a.sumInput, a.sumCacheCreation),
          } satisfies ProviderModelStat;
        })
        // Group siblings together (provider name asc), busiest models first —
        // the UI regroups by provider regardless, this just keeps it readable.
        .sort((x, y) => (x.provider < y.provider ? -1 : x.provider > y.provider ? 1 : y.calls - x.calls)),
      byDay,
    };
  }

  // --- circuit breaker (transient failures only; in-memory) ---

  /** Whether a provider is currently in cooldown and should be skipped. */
  isCooling(id: string): boolean {
    const c = this.circuit.get(id);
    return !!c && c.until > Date.now();
  }

  /** Record a transient upstream failure. Escalates cooldown with each
   *  consecutive failure (BASE * 2^(fails-1), capped at CAP); `fails` persists
   *  across cooldown expirations and is reset only by success — unless the
   *  provider has been quiet for > CAP, in which case it starts fresh at 1.
   *  When the upstream told us exactly how long to back off (`retryAfterMs`,
   *  parsed from a 429/overloaded Retry-After header, OR a reset deadline parsed
   *  from a Volcengine-Ark-style error body — `resetDeadline` selects the larger
   *  RESET_CAP_MS ceiling for the latter), honor it — clamped to [CB_MIN, cap] —
   *  instead of the escalating guess: the source isn't sicker, it just said when
   *  it'll be ready. `fails` still increments either way so a later hint-less
   *  failure continues the escalation from where it left off. Returns `entered` =
   *  transitioned from healthy → cooling this call (the caller logs a cooldown
   *  row only then, to avoid timeline spam), plus the fails count and cooldown
   *  duration for that row. */
  recordCircuitFailure(id: string, status: number, reason: string, retryAfterMs?: number, resetDeadline?: boolean): { entered: boolean; fails: number; cooldownMs: number } {
    const now = Date.now();
    const cur = this.circuit.get(id);
    const stale = !cur || now - cur.lastTs > CB_CAP;
    const fails = stale ? 1 : cur!.fails + 1;
    const hint = retryAfterMs && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    // A hint's ceiling depends on what it represents: a Retry-After backoff guess
    // caps at CB_CAP (5min — OpenAI-style org-quota Retry-Afters can span
    // hours/days, and we'd rather re-probe than write the source off that long);
    // a reset DEADLINE parsed from an Ark-style body caps at RESET_CAP_MS (a real
    // future event worth waiting for). The no-hint escalating guess always caps at
    // CB_CAP.
    const cap = resetDeadline ? RESET_CAP_MS : CB_CAP;
    const cooldownMs = hint ? Math.min(cap, Math.max(CB_MIN, Math.round(hint))) : Math.min(CB_CAP, CB_BASE * 2 ** (fails - 1));
    const until = now + cooldownMs;
    const wasCooling = !!cur && cur.until > now;
    this.circuit.set(id, { fails, until, lastStatus: status, lastReason: reason, lastTs: now });
    return { entered: !wasCooling, fails, cooldownMs };
  }

  /** A successful call resets the cooldown (circuit closes). Keeps lastTs/
   *  lastReason as history; the provider reads as state "open". */
  recordCircuitSuccess(id: string): void {
    const cur = this.circuit.get(id);
    if (!cur || (cur.fails === 0 && cur.until === 0)) return;
    this.circuit.set(id, { ...cur, fails: 0, until: 0 });
  }

  /** Force-clear a provider's cooldown (the UI "reset" button). */
  resetCircuit(id: string): void {
    const cur = this.circuit.get(id);
    if (!cur) return;
    this.circuit.set(id, { ...cur, fails: 0, until: 0 });
  }

  // --- RPM pacing (in-memory sliding window, never persisted) ---

  /** Count this source's forwarded calls in the trailing RPM_WINDOW_MS, pruning
   *  expired entries as it reads (timestamps are appended oldest-first). Returns
   *  0 for a source with no recent activity. */
  rpmUsed(id: string): number {
    const arr = this.rpm.get(id);
    if (!arr || !arr.length) return 0;
    const cutoff = Date.now() - RPM_WINDOW_MS;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (!arr.length) this.rpm.delete(id);
    return arr.length;
  }

  /** Record that we forwarded a call to this source (called by dispatch right
   *  before the upstream fetch). Lets the next pacing check count this attempt. */
  recordDispatch(id: string): void {
    const arr = this.rpm.get(id);
    if (arr) arr.push(Date.now());
    else this.rpm.set(id, [Date.now()]);
  }

  // --- even pacing (per model, in-memory leaky-bucket queue) ---

  /** Reserve the next release slot for a call to `model`, paced at `rpm`
   *  requests/min (one every 60/rpm seconds). Returns the ms the caller should
   *  sleep BEFORE forwarding (0 = go now), or -1 when the next free slot is
   *  further out than PACE_MAX_WAIT_MS (caller rejects with 429 - the slot is
   *  left unclaimed so rejections never push the queue further back). Slot
   *  claiming is synchronous, so concurrent dispatches get strictly FIFO slots;
   *  after an idle period the stale slot is clamped to now (first request goes
   *  through immediately). */
  paceClaim(model: string, rpm: number): number {
    const interval = RPM_WINDOW_MS / rpm;
    const now = Date.now();
    const next = Math.max(this.pace.get(model) ?? 0, now);
    const wait = next - now;
    if (wait > PACE_MAX_WAIT_MS) return -1;
    this.pace.set(model, next + interval);
    return wait;
  }

  /** Snapshot of every configured provider's circuit state for GET /admin/circuit.
   *  Healthy providers appear as state "open"; a provider deleted while cooling
   *  simply drops out (we iterate the live config, not the map). */
  circuitState(): CircuitView[] {
    const now = Date.now();
    return this.data.providers.map((p) => {
      const c = this.circuit.get(p.id);
      const cooling = !!c && c.until > now;
      return {
        id: p.id,
        name: p.name,
        state: cooling ? "cooling" : "open",
        fails: c?.fails ?? 0,
        secondsLeft: cooling ? Math.max(0, Math.ceil((c!.until - now) / 1000)) : 0,
        until: c?.until ?? 0,
        lastStatus: c?.lastStatus ?? 0,
        lastReason: c?.lastReason ?? "",
        lastTs: c?.lastTs ?? 0,
        rpm: p.rpm ?? 0,
        rpmUsed: this.rpmUsed(p.id),
      };
    });
  }
}

/** Running accumulator for a stats bucket. */
interface Acc {
  calls: number;
  success: number;
  error: number;
  sumMs: number;
  sumInput: number;
  sumOutput: number;
  sumCacheRead: number;
  sumCacheCreation: number;
}
function newAcc(): Acc {
  return { calls: 0, success: 0, error: 0, sumMs: 0, sumInput: 0, sumOutput: 0, sumCacheRead: 0, sumCacheCreation: 0 };
}
function bump(a: Acc, ok: boolean, err: boolean, e: LogEntry): void {
  a.calls++;
  if (ok) a.success++;
  if (err) a.error++;
  a.sumMs += e.ms || 0;
  const u = e.usage;
  if (u) {
    a.sumInput += u.input || 0;
    a.sumOutput += u.output || 0;
    a.sumCacheRead += u.cacheRead || 0;
    a.sumCacheCreation += u.cacheCreation || 0;
  }
}
/** Get-or-create a bucket entry in a stats map. */
function acc(m: Map<string, Acc>, k: string): Acc {
  let a = m.get(k);
  if (!a) m.set(k, (a = newAcc()));
  return a;
}
/** Local-calendar YYYY-MM-DD for a timestamp (stats day bucket key). */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fields(
  a: Acc,
): Pick<StatBucket, "calls" | "success" | "error" | "avgMs" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheCreation" | "cacheHitRate"> {
  return {
    calls: a.calls,
    success: a.success,
    error: a.error,
    avgMs: a.calls ? Math.round(a.sumMs / a.calls) : 0,
    inputTokens: a.sumInput,
    outputTokens: a.sumOutput,
    cacheRead: a.sumCacheRead,
    cacheCreation: a.sumCacheCreation,
    cacheHitRate: hitRate(a.sumCacheRead, a.sumInput, a.sumCacheCreation),
  };
}
/** Cache hit rate: cacheRead / (input + cacheRead + cacheCreation) — "of all
 *  prompt tokens, how many were served from cache." 0 when there were no prompt
 *  tokens (guard against divide-by-zero). */
function hitRate(cacheRead: number, input: number, cacheCreation: number): number {
  const denom = input + cacheRead + cacheCreation;
  return denom > 0 ? cacheRead / denom : 0;
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

/**
 * FormatEntry migration to inline (provider, model) slots (v4 → v5).
 *  - v4 stored each route's chain as `providers: string[]` (unique provider ids)
 *    plus an optional side-channel `modelMap: { providerId → upstream model }`.
 *  - v5 collapses both into `providers: { id, model? }[]`, so a provider id may
 *    now REPEAT — each occurrence carries its own upstream model — enabling
 *    failover across several models on one backend.
 * Idempotent: slots already in the {id,model?} shape (no string elements and no
 * modelMap) are skipped. Returns true if any entry was rewritten.
 */
function migrateFormatEntries(raw: GateConfig): boolean {
  const models = raw.models as Record<string, unknown>;
  if (!models || typeof models !== "object") return false;
  let changed = false;
  for (const entry of Object.values(models)) {
    if (!entry || typeof entry !== "object") continue;
    for (const f of ["openai", "anthropic", "responses"] as const) {
      const fe = (entry as Record<string, unknown>)[f] as
        | { providers?: unknown[]; modelMap?: Record<string, string> }
        | undefined;
      if (!fe || !Array.isArray(fe.providers)) continue;
      const hasStrings = fe.providers.some((x) => typeof x === "string");
      const hasMap = !!fe.modelMap && Object.keys(fe.modelMap).length > 0;
      if (!hasStrings && !hasMap) continue; // already v5
      const map = fe.modelMap ?? {};
      fe.providers = (fe.providers as unknown[]).map((x) =>
        typeof x === "string" ? (map[x] ? { id: x, model: map[x] } : { id: x }) : x,
      );
      delete fe.modelMap;
      changed = true;
    }
  }
  return changed;
}
