import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpStore, type TmpStore } from "../helpers/store";
import { makeProvider, seedStore } from "../helpers/fixtures";

// CB_BASE=30000, CB_CAP=300000 (see store.ts).
const BASE = 1_700_000_000_000;

describe("store circuit breaker", () => {
  let env: TmpStore;
  beforeEach(async () => {
    vi.useFakeTimers({ now: BASE });
    env = tmpStore();
    await seedStore(env.store, { providers: [makeProvider({ id: "prv_1", name: "p1" })] });
  });
  afterEach(() => {
    vi.useRealTimers();
    env.cleanup();
  });

  describe("fresh state", () => {
    it("is not cooling with no recorded failures", () => {
      expect(env.store.isCooling("prv_1")).toBe(false);
    });
    it("circuitState lists the provider as open with no fails", () => {
      const view = env.store.circuitState();
      expect(view).toHaveLength(1);
      expect(view[0]).toMatchObject({
        id: "prv_1",
        name: "p1",
        state: "open",
        fails: 0,
        secondsLeft: 0,
        until: 0,
        lastStatus: 0,
        lastReason: "",
        lastTs: 0,
      });
    });
  });

  describe("recordCircuitFailure escalation", () => {
    it("first failure enters cooling with a 30s cooldown", () => {
      const r = env.store.recordCircuitFailure("prv_1", 503, "upstream 5xx");
      expect(r).toEqual({ entered: true, fails: 1, cooldownMs: 30_000 });
      expect(env.store.isCooling("prv_1")).toBe(true);
    });
    it("second consecutive failure does not re-enter and doubles the cooldown", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1");
      const r = env.store.recordCircuitFailure("prv_1", 503, "e2");
      expect(r).toEqual({ entered: false, fails: 2, cooldownMs: 60_000 });
    });
    it("escalates 3→120s, 4→240s, 5→capped at 300s (not 480s)", () => {
      env.store.recordCircuitFailure("prv_1", 503, "1"); // fails=1
      env.store.recordCircuitFailure("prv_1", 503, "2"); // fails=2
      expect(env.store.recordCircuitFailure("prv_1", 503, "3").cooldownMs).toBe(120_000);
      expect(env.store.recordCircuitFailure("prv_1", 503, "4").cooldownMs).toBe(240_000);
      const fifth = env.store.recordCircuitFailure("prv_1", 503, "5");
      expect(fifth.fails).toBe(5);
      expect(fifth.cooldownMs).toBe(300_000); // capped at CB_CAP, NOT 480000
    });
    it("further failures stay capped at 300s", () => {
      for (let i = 0; i < 5; i++) env.store.recordCircuitFailure("prv_1", 503, "x");
      const sixth = env.store.recordCircuitFailure("prv_1", 503, "6");
      expect(sixth.fails).toBe(6);
      expect(sixth.cooldownMs).toBe(300_000);
    });
  });

  describe("entered semantics", () => {
    it("is true only on the healthy→cooling transition (one cooldown row)", () => {
      expect(env.store.recordCircuitFailure("prv_1", 503, "e1").entered).toBe(true);
      // still cooling → second failure does NOT re-enter
      expect(env.store.recordCircuitFailure("prv_1", 503, "e2").entered).toBe(false);
    });
    it("re-enters after cooldown expires (wasCooling=false post-expiry)", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1"); // until = BASE + 30000
      vi.advanceTimersByTime(31_000); // past until, gap still < CB_CAP
      const r = env.store.recordCircuitFailure("prv_1", 503, "e2");
      expect(r.entered).toBe(true);
      expect(r.fails).toBe(2);
    });
  });

  describe("cooldown expiry", () => {
    it("clears isCooling once time advances past until", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1"); // 30s cooldown
      expect(env.store.isCooling("prv_1")).toBe(true);
      vi.advanceTimersByTime(30_001);
      expect(env.store.isCooling("prv_1")).toBe(false);
    });
    it("persists fails across cooldown expiry when the gap is ≤ CB_CAP", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1");
      vi.advanceTimersByTime(40_000); // past cooldown, well under CB_CAP
      expect(env.store.isCooling("prv_1")).toBe(false);
      // fails goes 1→2, NOT reset to 1
      expect(env.store.recordCircuitFailure("prv_1", 503, "e2").fails).toBe(2);
    });
  });

  describe("stale reset", () => {
    it("resets fails to 1 when the gap since lastTs exceeds CB_CAP", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1"); // lastTs = BASE
      vi.advanceTimersByTime(300_001); // > CB_CAP
      const r = env.store.recordCircuitFailure("prv_1", 503, "e2");
      expect(r).toEqual({ entered: true, fails: 1, cooldownMs: 30_000 });
    });
  });

  describe("recordCircuitSuccess", () => {
    it("closes the circuit after a failure", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1");
      expect(env.store.isCooling("prv_1")).toBe(true);
      env.store.recordCircuitSuccess("prv_1");
      expect(env.store.isCooling("prv_1")).toBe(false);
      const e = env.store.circuitState()[0];
      expect(e.state).toBe("open");
      expect(e.fails).toBe(0);
      expect(e.until).toBe(0);
    });
  });

  describe("resetCircuit", () => {
    it("force-clears cooldown (the UI reset button)", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1");
      expect(env.store.isCooling("prv_1")).toBe(true);
      env.store.resetCircuit("prv_1");
      expect(env.store.isCooling("prv_1")).toBe(false);
      const e = env.store.circuitState()[0];
      expect(e.fails).toBe(0);
      expect(e.until).toBe(0);
    });
  });

  describe("circuitState view while cooling", () => {
    it("reports state=cooling with a positive secondsLeft bounded by cooldownMs/1000", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1"); // 30s cooldown
      const e = env.store.circuitState()[0];
      expect(e.state).toBe("cooling");
      expect(e.secondsLeft).toBeGreaterThan(0);
      expect(e.secondsLeft).toBeLessThanOrEqual(30);
      expect(e.until).toBe(BASE + 30_000);
    });
    it("counts down as time advances", () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1");
      vi.advanceTimersByTime(10_000);
      // ceil((30000 - 10000) / 1000) = 20
      expect(env.store.circuitState()[0].secondsLeft).toBe(20);
    });
  });

  describe("deleted provider", () => {
    it("drops out of circuitState but stays in the internal map", async () => {
      env.store.recordCircuitFailure("prv_1", 503, "e1");
      expect(env.store.isCooling("prv_1")).toBe(true);
      await seedStore(env.store, { providers: [] }); // remove prv_1 from config
      expect(env.store.circuitState()).toEqual([]); // view iterates live config
      expect(env.store.isCooling("prv_1")).toBe(true); // internal map unchanged
    });
  });
});
