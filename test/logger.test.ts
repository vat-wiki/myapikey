import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, levelFromEnv } from "../src/server/logger";

const tmp = () => mkdtempSync(join(tmpdir(), "myapikey-logger-"));

describe("createLogger", () => {
  it("appends one timestamped, level-tagged line per call", () => {
    const dir = tmp();
    try {
      const file = join(dir, "server.log");
      const log = createLogger({ file, console: false });
      log.warn("hello");
      log.error("boom");
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      // ISO-8601 UTC timestamp, level padded to 5 (ERROR), then the message
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN  hello$/);
      expect(lines[1]).toMatch(/ ERROR boom$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops messages below the configured level", () => {
    const dir = tmp();
    try {
      const file = join(dir, "server.log");
      const log = createLogger({ file, console: false, level: "warn" });
      log.info("quiet");
      log.warn("kept");
      log.error("also kept");
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("kept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits nothing at level silent (file never created)", () => {
    const dir = tmp();
    try {
      const file = join(dir, "server.log");
      const log = createLogger({ file, console: false, level: "silent" });
      log.info("a");
      log.warn("b");
      log.error("c");
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotates to .1 past the size cap, then starts a fresh file", () => {
    const dir = tmp();
    try {
      const file = join(dir, "server.log");
      writeFileSync(file, "x".repeat(100));
      const log = createLogger({ file, console: false, rotateBytes: 50 });
      log.warn("after cap");
      expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(100));
      expect(readFileSync(file, "utf8")).toContain("after cap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws with no file configured", () => {
    const log = createLogger({ console: false });
    expect(() => log.error("no file")).not.toThrow();
  });

  it("parses MYAPIKEY_LOG_LEVEL, falling back to info", () => {
    for (const v of ["info", "warn", "error", "silent"] as const) expect(levelFromEnv(v)).toBe(v);
    expect(levelFromEnv("bogus")).toBe("info");
    expect(levelFromEnv(undefined)).toBe("info");
  });
});
