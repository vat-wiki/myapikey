import { describe, it, expect } from "vitest";
import { cn } from "../src/lib/utils";
import { FMT_ACCENT, providerColor, type Fmt } from "../src/lib/format";
import { providerModelList } from "../src/lib/models";
import { conversationOf, firstUserText } from "../src/lib/conv";

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

  describe("providerModelList() — discovery + supplements union", () => {
    it("merges discoveredModels and extraModels, deduped and sorted case-insensitively", () => {
      const p = { discoveredModels: ["gpt-4o", "B-model"], extraModels: ["a-model", "gpt-4o"] };
      expect(providerModelList(p)).toEqual(["a-model", "B-model", "gpt-4o"]);
    });

    it("tolerates absent lists and empty names; undefined provider → []", () => {
      expect(providerModelList(undefined)).toEqual([]);
      expect(providerModelList(null)).toEqual([]);
      expect(providerModelList({})).toEqual([]);
      expect(providerModelList({ discoveredModels: ["", "keep"], extraModels: undefined })).toEqual(["keep"]);
    });
  });

  describe("conversationOf() — debug-capture conversation grouping", () => {
    const chat = (firstUser: string, lastUser?: string) =>
      JSON.stringify({
        model: "m",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: firstUser },
          { role: "assistant", content: "hi" },
          ...(lastUser ? [{ role: "user", content: lastUser }] : []),
        ],
      });

    it("turns of one conversation share a key (first user message is constant); others differ", () => {
      const t1 = conversationOf(chat("hello world"), "");
      const t2 = conversationOf(chat("hello world", "follow-up"), "");
      const other = conversationOf(chat("different task"), "");
      expect(t2.key).toBe(t1.key);
      expect(other.key).not.toBe(t1.key);
    });

    it("titles come from the first user message, whitespace-collapsed and capped at 80 chars", () => {
      const long = "a".repeat(120) + " tail";
      const v = conversationOf(chat(`  ${long}  \n more`), "");
      expect(v.title).toBe(`a`.repeat(80) + "…");
      const short = conversationOf(chat("short prompt"), "");
      expect(short.title).toBe("short prompt");
    });

    it("metadata.user_id wins over the message hash (same text, two sessions stay apart)", () => {
      const a = conversationOf(JSON.stringify({ metadata: { user_id: "user_1__session_A" }, messages: [{ role: "user", content: "same" }] }), "");
      const b = conversationOf(JSON.stringify({ metadata: { user_id: "user_1__session_B" }, messages: [{ role: "user", content: "same" }] }), "");
      const c = conversationOf(JSON.stringify({ metadata: { user_id: "user_1__session_A" }, messages: [{ role: "user", content: "same" }, { role: "user", content: "grew" }] }), "");
      expect(b.key).not.toBe(a.key);
      expect(c.key).toBe(a.key);
    });

    it("reads the anthropic wire (content parts arrays; non-text parts contribute nothing)", () => {
      const body = JSON.stringify({
        system: "sys",
        messages: [
          { role: "user", content: [{ type: "text", text: "part one" }, { type: "image", source: {} }, { type: "text", text: "part two" }] },
        ],
      });
      const v = conversationOf(body, "");
      expect(v.title).toBe("part one part two");
      expect(v.key).toBe(conversationOf(JSON.stringify({ messages: [{ role: "user", content: "part one part two" }] }), "").key);
    });

    it("reads the responses wire — input as string and as message array", () => {
      const asString = conversationOf(JSON.stringify({ input: "fix the bug" }), "");
      const asArray = conversationOf(JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] }] }), "");
      expect(firstUserText(JSON.parse(JSON.stringify({ input: "fix the bug" })))).toBe("fix the bug");
      expect(asArray.title).toBe("fix the bug");
      expect(asString.key).toBe(asArray.key);
    });

    it("unidentifiable bodies → empty key (caller makes solo groups) and the fallback title", () => {
      expect(conversationOf("not json", "fb")).toEqual({ key: "", title: "fb" });
      expect(conversationOf(JSON.stringify({ messages: [{ role: "assistant", content: "only" }] }), "fb")).toEqual({ key: "", title: "fb" });
    });
  });
});
