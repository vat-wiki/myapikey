import { describe, it, expect } from "vitest";
import { cn } from "../src/lib/utils";
import { FMT_ACCENT, providerColor, type Fmt } from "../src/lib/format";

// The Fmt union, as a runtime mirror for key-set assertions.
const FMT_KEYS = ["openai", "anthropic", "responses"] as const;

describe("web/lib", () => {
  describe("cn() — clsx + tailwind-merge", () => {
    it("merges conditional classes via clsx (falsy values dropped)", () => {
      expect(cn("a", false, "b", undefined)).toBe("a b");
    });

    it("resolves padding conflicts — later px-4 wins", () => {
      expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    });

    it("resolves text-color conflicts — later wins", () => {
      expect(cn("text-red-500 text-blue-500")).toBe("text-blue-500");
    });
  });

  describe("FMT_ACCENT", () => {
    it("has exactly the three format keys", () => {
      expect(Object.keys(FMT_ACCENT).sort()).toEqual([...FMT_KEYS].sort());
    });

    it.each(FMT_KEYS)("%s has all six string fields", (k) => {
      const v = FMT_ACCENT[k as Fmt];
      for (const field of ["solid", "text", "soft", "border", "chip", "badge"] as const) {
        expect(typeof v[field]).toBe("string");
        expect((v[field] as string).length).toBeGreaterThan(0);
      }
    });

    it.each(FMT_KEYS)("%s solid starts with 'bg-'", (k) => {
      expect(FMT_ACCENT[k as Fmt].solid.startsWith("bg-")).toBe(true);
    });
  });

  describe("providerColor()", () => {
    it("is deterministic — same id yields the same palette entry", () => {
      expect(providerColor("prv_1")).toEqual(providerColor("prv_1"));
    });

    it("returns a solid that starts with 'bg-' and a non-empty badge string", () => {
      const c = providerColor("prv_1");
      expect(c.solid.startsWith("bg-")).toBe(true);
      expect(typeof c.badge).toBe("string");
      expect(c.badge.length).toBeGreaterThan(0);
    });

    it("returns a consistent {solid,badge} shape across ids", () => {
      const a = providerColor("alpha");
      const b = providerColor("beta");
      expect(Object.keys(a).sort()).toEqual(["badge", "solid"]);
      expect(Object.keys(b).sort()).toEqual(["badge", "solid"]);
    });
  });

  describe("Fmt type / key set", () => {
    it("FMT_ACCENT runtime keys match the Fmt union", () => {
      const keys = Object.keys(FMT_ACCENT);
      expect(keys).toHaveLength(FMT_KEYS.length);
      for (const k of FMT_KEYS) expect(keys).toContain(k);
    });
  });
});
