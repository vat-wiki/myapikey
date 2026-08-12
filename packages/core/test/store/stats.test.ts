import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpStore } from "../helpers/store";
import type { TmpStore } from "../helpers/store";
import { makeLog, makeProvider, seedStore } from "../helpers/fixtures";

describe("store/getStats", () => {
  let env: TmpStore;
  beforeEach(() => {
    env = tmpStore();
  });
  afterEach(() => {
    env.cleanup();
  });

  describe("empty store", () => {
    it("returns zeroed totals and empty buckets", () => {
      const s = env.store.getStats(0);
      expect(s.totals).toEqual({
        calls: 0,
        success: 0,
        error: 0,
        errorRate: 0,
        avgMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreation: 0,
      });
      expect(s.byModel).toEqual([]);
      expect(s.byProvider).toEqual([]);
      expect(s.byFormat).toEqual([]);
      expect(s.byDay).toEqual([]);
    });
  });

  describe("totals", () => {
    it("counts calls/success/error, errorRate, and avgMs over all calls' ms", () => {
      const now = Date.now();
      const ms = [10, 30, 50, 20]; // 3 success (10,30,50) + 1 error (20)
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: ms[0] }));
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: ms[1] }));
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: ms[2] }));
      env.store.pushLog(makeLog({ ts: now - 1000, status: 500, ms: ms[3] }));

      const s = env.store.getStats(0);
      expect(s.totals.calls).toBe(4);
      expect(s.totals.success).toBe(3);
      expect(s.totals.error).toBe(1);
      expect(s.totals.errorRate).toBe(0.25);
      // avgMs = rounded mean of every call's ms (cooldown excluded; these are all calls)
      expect(s.totals.avgMs).toBe(Math.round(ms.reduce((a, b) => a + b, 0) / ms.length));
    });
  });

  describe("latency percentiles", () => {
    it("p50/p95 match pick(frac) over the sorted ms list", () => {
      const now = Date.now();
      const ms = [10, 20, 30, 40, 100];
      for (const m of ms) env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: m }));

      const s = env.store.getStats(0);
      const sorted = [...ms].sort((a, b) => a - b);
      const pick = (frac: number) => sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
      expect(s.totals.p50Ms).toBe(pick(0.5));
      expect(s.totals.p95Ms).toBe(pick(0.95));
      // concrete: len 5 → p50 index 2 = 30, p95 index 4 = 100
      expect(s.totals.p50Ms).toBe(30);
      expect(s.totals.p95Ms).toBe(100);
    });
  });

  describe("byModel and byFormat", () => {
    it("groups per model/format, sorted desc by calls", () => {
      const now = Date.now();
      // alpha/openai: 3 calls (2 ok, 1 err); beta/anthropic: 1 call (ok)
      env.store.pushLog(makeLog({ ts: now - 1000, model: "alpha", format: "openai", status: 200, ms: 100 }));
      env.store.pushLog(makeLog({ ts: now - 1000, model: "alpha", format: "openai", status: 200, ms: 200 }));
      env.store.pushLog(makeLog({ ts: now - 1000, model: "alpha", format: "openai", status: 500, ms: 50 }));
      env.store.pushLog(makeLog({ ts: now - 1000, model: "beta", format: "anthropic", status: 200, ms: 40 }));

      const s = env.store.getStats(0);
      const alphaAvg = Math.round((100 + 200 + 50) / 3);
      expect(s.byModel).toEqual([
        { key: "alpha", calls: 3, success: 2, error: 1, avgMs: alphaAvg, inputTokens: 0, outputTokens: 0 },
        { key: "beta", calls: 1, success: 1, error: 0, avgMs: 40, inputTokens: 0, outputTokens: 0 },
      ]);
      expect(s.byFormat).toEqual([
        { key: "openai", calls: 3, success: 2, error: 1, avgMs: alphaAvg, inputTokens: 0, outputTokens: 0 },
        { key: "anthropic", calls: 1, success: 1, error: 0, avgMs: 40, inputTokens: 0, outputTokens: 0 },
      ]);
    });
  });

  describe("byProvider", () => {
    it("groups by stable providerId, labeled with the live name (rename does not split history)", async () => {
      await seedStore(env.store, { providers: [makeProvider({ id: "prv_1", name: "old" })] });
      const now = Date.now();
      env.store.pushLog(makeLog({ ts: now - 1000, providerId: "prv_1", provider: "old", status: 200, ms: 70 }));
      env.store.pushLog(makeLog({ ts: now - 1000, providerId: "prv_1", provider: "old", status: 200, ms: 30 }));

      // rename: same id, new name — history must stay grouped under prv_1
      await seedStore(env.store, { providers: [makeProvider({ id: "prv_1", name: "new" })] });

      const s = env.store.getStats(0);
      expect(s.byProvider).toEqual([
        { id: "prv_1", key: "new", calls: 2, success: 2, error: 0, avgMs: 50, inputTokens: 0, outputTokens: 0 },
      ]);
    });
  });

  describe("cooldown exclusion", () => {
    it("excludes kind:cooldown rows from totals and buckets", () => {
      const now = Date.now();
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: 10 }));
      env.store.pushLog(makeLog({ ts: now - 1000, kind: "cooldown", status: 500, ms: 999 }));

      const s = env.store.getStats(0);
      expect(s.totals.calls).toBe(1); // only the real call
      expect(s.totals.error).toBe(0); // the 500 was on the cooldown row, ignored
      expect(s.totals.avgMs).toBe(10);
    });
  });

  describe("range filtering", () => {
    it("rangeMs window excludes entries older than the window; 0 includes all", () => {
      const now = Date.now();
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: 10 })); // recent
      env.store.pushLog(makeLog({ ts: now - 10 * 24 * 60 * 60 * 1000, status: 200, ms: 20 })); // 10d ago

      const week = env.store.getStats(7 * 24 * 60 * 60 * 1000);
      expect(week.totals.calls).toBe(1); // only the recent entry

      const all = env.store.getStats(0);
      expect(all.totals.calls).toBe(2); // both
    });
  });

  describe("future-ts skew guard", () => {
    it("drops entries >60s in the future (guard is gated on rangeMs > 0)", () => {
      // NOTE: source only applies the skew guard when rangeMs > 0
      // (line `if (rangeMs > 0 && e.ts > to + 60_000) continue;`), so we use a
      // positive window that still contains the recent entry rather than getStats(0).
      const now = Date.now();
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: 10 })); // recent
      env.store.pushLog(makeLog({ ts: now + 120_000, status: 200, ms: 20 })); // 2min in future

      const s = env.store.getStats(60 * 60 * 1000); // 1h window
      expect(s.totals.calls).toBe(1); // future entry ignored
    });
  });

  describe("byDay continuity", () => {
    it("is non-empty and the last day is today's local YYYY-MM-DD", () => {
      const now = Date.now();
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: 10 }));

      const s = env.store.getStats(2 * 24 * 60 * 60 * 1000);
      expect(s.byDay.length).toBeGreaterThan(0);
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      expect(s.byDay[s.byDay.length - 1].day).toBe(today);
    });

    it("fills zero-call days in the window (only today is non-zero)", () => {
      const now = Date.now();
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, ms: 10 }));
      const s = env.store.getStats(2 * 24 * 60 * 60 * 1000);
      expect(s.byDay.length).toBeGreaterThanOrEqual(2);
      expect(s.byDay.filter((d) => d.calls > 0).length).toBe(1);
    });
  });

  describe("token usage aggregation", () => {
    it("sums input/output/cache across usage-bearing rows into totals", () => {
      const now = Date.now();
      env.store.pushLog(
        makeLog({ ts: now - 1000, status: 200, model: "a", usage: { input: 100, output: 20, cacheRead: 5, cacheCreation: 3 } }),
      );
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, model: "a", usage: { input: 50, output: 10 } }));
      // A failed call carries no usage → contributes 0.
      env.store.pushLog(makeLog({ ts: now - 1000, status: 500, model: "a" }));
      // A legacy row with no usage field → 0.
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, model: "b" }));

      const s = env.store.getStats(0);
      expect(s.totals.inputTokens).toBe(150);
      expect(s.totals.outputTokens).toBe(30);
      expect(s.totals.cacheRead).toBe(5);
      expect(s.totals.cacheCreation).toBe(3);
    });

    it("rolls usage into per-model buckets", () => {
      const now = Date.now();
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, model: "a", usage: { input: 100, output: 20 } }));
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, model: "a", usage: { input: 40, output: 8 } }));
      env.store.pushLog(makeLog({ ts: now - 1000, status: 200, model: "b", usage: { input: 7, output: 3 } }));

      const s = env.store.getStats(0);
      const a = s.byModel.find((m) => m.key === "a");
      const b = s.byModel.find((m) => m.key === "b");
      expect(a?.inputTokens).toBe(140);
      expect(a?.outputTokens).toBe(28);
      expect(b?.inputTokens).toBe(7);
      expect(b?.outputTokens).toBe(3);
    });
  });
});
