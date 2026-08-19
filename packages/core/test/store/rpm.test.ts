import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpStore, type TmpStore } from "../helpers/store";
import { makeProvider, seedStore } from "../helpers/fixtures";

// RPM_WINDOW_MS = 60_000 (see store.ts).
const BASE = 1_700_000_000_000;

describe("store rpm pacing", () => {
  let env: TmpStore;
  beforeEach(async () => {
    vi.useFakeTimers({ now: BASE });
    env = tmpStore();
    await seedStore(env.store, { providers: [makeProvider({ id: "prv_1", name: "p1", rpm: 3 })] });
  });
  afterEach(() => {
    vi.useRealTimers();
    env.cleanup();
  });

  describe("rpmUsed / recordDispatch", () => {
    it("is 0 with no recorded dispatches", () => {
      expect(env.store.rpmUsed("prv_1")).toBe(0);
    });
    it("counts dispatches within the window", () => {
      env.store.recordDispatch("prv_1");
      env.store.recordDispatch("prv_1");
      expect(env.store.rpmUsed("prv_1")).toBe(2);
    });
    it("prunes entries older than the 60s window as it reads", () => {
      env.store.recordDispatch("prv_1"); // at BASE
      env.store.recordDispatch("prv_1"); // at BASE
      vi.advanceTimersByTime(60_001); // both now expired
      expect(env.store.rpmUsed("prv_1")).toBe(0);
      // A fresh dispatch after pruning counts from zero.
      env.store.recordDispatch("prv_1");
      expect(env.store.rpmUsed("prv_1")).toBe(1);
    });
    it("keeps the unexpired tail when only some entries have aged out", () => {
      env.store.recordDispatch("prv_1"); // at BASE (will expire)
      vi.advanceTimersByTime(40_000);
      env.store.recordDispatch("prv_1"); // at BASE+40s (stays)
      env.store.recordDispatch("prv_1"); // at BASE+40s (stays)
      vi.advanceTimersByTime(21_000); // now BASE+61s: first expired, last two still < 60s old
      expect(env.store.rpmUsed("prv_1")).toBe(2);
    });
  });

  describe("rpmNextFreeMs", () => {
    it("is 0 with no recorded dispatches", () => {
      expect(env.store.rpmNextFreeMs("prv_1")).toBe(0);
    });
    it("reports ms until the oldest window entry ages out", () => {
      env.store.recordDispatch("prv_1"); // at BASE
      vi.advanceTimersByTime(10_000);
      expect(env.store.rpmNextFreeMs("prv_1")).toBe(50_000);
    });
    it("is 0 once the window has expired, pruning as it reads", () => {
      env.store.recordDispatch("prv_1"); // at BASE
      vi.advanceTimersByTime(60_001);
      expect(env.store.rpmNextFreeMs("prv_1")).toBe(0);
      expect(env.store.rpmUsed("prv_1")).toBe(0);
    });
  });

  describe("circuitState exposes rpm", () => {
    it("reports the configured cap and live window count", () => {
      env.store.recordDispatch("prv_1");
      env.store.recordDispatch("prv_1");
      const e = env.store.circuitState()[0];
      expect(e.rpm).toBe(3);
      expect(e.rpmUsed).toBe(2);
    });
    it("rpm reads 0 for a source with no cap configured", async () => {
      await seedStore(env.store, { providers: [makeProvider({ id: "prv_2", name: "p2" })] });
      env.store.recordDispatch("prv_2");
      const e = env.store.circuitState().find((x) => x.id === "prv_2")!;
      expect(e.rpm).toBe(0);
      expect(e.rpmUsed).toBe(1);
    });
  });
});
