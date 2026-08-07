import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpStore, type TmpStore } from "../helpers/store";
import { makeLog } from "../helpers/fixtures";

describe("store: logs", () => {
  let ts: TmpStore;
  beforeEach(() => {
    ts = tmpStore();
  });
  afterEach(() => {
    ts.cleanup();
  });

  describe("pushLog", () => {
    it("appends one JSON object + newline; a subsequent getLogs returns it, newest-first", () => {
      ts.store.pushLog(makeLog({ ts: 1000 }));
      const logs = ts.store.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].ts).toBe(1000);
    });

    it("returns void; the file gains one line per push (count newlines)", () => {
      const r = ts.store.pushLog(makeLog({ ts: 1 }));
      expect(r).toBeUndefined();
      ts.store.pushLog(makeLog({ ts: 2 }));
      ts.store.pushLog(makeLog({ ts: 3 }));
      const raw = readFileSync(join(ts.dir, "logs.jsonl"), "utf8");
      // Each push writes exactly one trailing "\n"; the trailing newline yields
      // an empty final element, so element count = newline count + 1.
      const newlines = raw.split("\n").length - 1;
      expect(newlines).toBe(3);
    });

    it("serializes a large (~100KB) entry that getLogs returns intact within the tail window", () => {
      const big = "x".repeat(100_000);
      ts.store.pushLog(makeLog({ ts: 9000, error: big }));
      const logs = ts.store.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].error).toBe(big);
    });
  });

  describe("getLogs", () => {
    it("returns [] on a fresh store with no logs.jsonl yet", () => {
      expect(ts.store.getLogs()).toEqual([]);
    });

    it("returns entries newest-first across many pushes", () => {
      ts.store.pushLog(makeLog({ ts: 1000 }));
      ts.store.pushLog(makeLog({ ts: 2000 }));
      ts.store.pushLog(makeLog({ ts: 3000 }));
      const logs = ts.store.getLogs();
      expect(logs.map((l) => l.ts)).toEqual([3000, 2000, 1000]);
    });

    it("caps at the 200 most recent; the first element is the newest", () => {
      for (let i = 0; i < 205; i++) ts.store.pushLog(makeLog({ ts: i }));
      const logs = ts.store.getLogs();
      expect(logs).toHaveLength(200);
      expect(logs[0].ts).toBe(204); // newest (highest ts)
      // And the oldest survivor is just past the 200-cutoff from the top.
      expect(logs[logs.length - 1].ts).toBe(5);
    });

    it("skips a corrupt/partial line written directly to the file without throwing", () => {
      ts.store.pushLog(makeLog({ ts: 7000 }));
      appendFileSync(join(ts.dir, "logs.jsonl"), "this is not json\n");
      const logs = ts.store.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].ts).toBe(7000);
    });

    it("tail-reads the last 512KB: a recent small entry survives after a >512KB earlier line", () => {
      // An earlier line whose serialized form exceeds LOG_TAIL_BYTES (512KB).
      ts.store.pushLog(makeLog({ ts: 1, error: "x".repeat(600_000) }));
      // A small recent entry that must land inside the tail window.
      ts.store.pushLog(makeLog({ ts: 2, model: "recent-small" }));
      const logs = ts.store.getLogs(); // would throw if the tail read broke
      expect(logs.some((l) => l.ts === 2 && l.model === "recent-small")).toBe(true);
    });
  });
});
