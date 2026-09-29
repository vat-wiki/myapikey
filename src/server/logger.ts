import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Runtime-log levels, ascending severity. `silent` emits nothing. */
export type LogLevel = "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2, silent: 3 };

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoggerOptions {
  /** Log file to append to (parent dirs created). Omit = console only. */
  file?: string;
  /** Minimum emitted level. Defaults to the MYAPIKEY_LOG_LEVEL env, else "info". */
  level?: LogLevel;
  /** Mirror to stdout (info/warn) / stderr (error). Default true. */
  console?: boolean;
  /** Size cap before the file rotates to `<file>.1`. Default 5 MiB. */
  rotateBytes?: number;
}

/** Parse MYAPIKEY_LOG_LEVEL; anything unrecognized falls back to "info". */
export function levelFromEnv(v: string | undefined): LogLevel {
  return v === "info" || v === "warn" || v === "error" || v === "silent" ? v : "info";
}

const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;

/** Process-level runtime log — the ops-facing line the gateway was missing:
 *  one plain text line per error or notable event (failover, circuit cooldown,
 *  auth failure, unhandled exception), mirrored to the console and appended to
 *  `<dataDir>/server.log`. Deliberately distinct from the per-call history in
 *  logs.jsonl (that's the web Logs/Stats surface; this is "what happened to
 *  the process"). Successful requests are NOT logged here — keep it quiet.
 *  File I/O is best-effort: logging must never throw into a request path. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? levelFromEnv(process.env.MYAPIKEY_LOG_LEVEL);
  const useConsole = opts.console ?? true;
  const cap = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;

  const write = (lvl: "info" | "warn" | "error", msg: string) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (useConsole) {
      // error → stderr so a log collector splits real failures from chatter
      (lvl === "error" ? process.stderr : process.stdout).write(line + "\n");
    }
    if (opts.file) {
      try {
        mkdirSync(dirname(opts.file), { recursive: true });
        // Keep-one rotation: past the cap, the current file becomes `.1`
        // (overwriting any older backup) and a fresh file starts.
        if (existsSync(opts.file) && statSync(opts.file).size > cap) {
          renameSync(opts.file, `${opts.file}.1`);
        }
        appendFileSync(opts.file, line + "\n");
      } catch {
        // Disk full / permissions — swallow; never fail a request over logging.
      }
    }
  };

  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}
