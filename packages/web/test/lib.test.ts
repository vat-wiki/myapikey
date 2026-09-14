import { describe, it, expect } from "vitest";
import { cn } from "../src/lib/utils";
import { FMT_ACCENT, providerColor, type Fmt } from "../src/lib/format";
import { providerModelList } from "../src/lib/models";
import { analyzeRequest, assignConversationGroups, conversationGroupsOf } from "../src/lib/conv";

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

  describe("conversation grouping — containment of resent history", () => {
    /** chat wire; one user message per "turn". */
    const chat = (turns: string[], uid?: string) =>
      JSON.stringify({
        ...(uid ? { metadata: { user_id: uid } } : {}),
        messages: turns.map((content) => ({ role: "user", content })),
      });
    const groupsOf = (bodies: string[]) => new Set(assignConversationGroups(bodies.map(analyzeRequest))).size;

    it("later requests contain earlier ones → the whole conversation is ONE group", () => {
      expect(groupsOf([chat(["hello"]), chat(["hello", "hi"]), chat(["hello", "hi", "and more"])])).toBe(1);
    });

    it("different openings → different groups (containment never bridges them)", () => {
      expect(groupsOf([chat(["task one"]), chat(["task one", "continue"]), chat(["task two"])])).toBe(2);
    });

    it("a body TRUNCATED at the capture cap still joins its conversation via its raw-text prefix", () => {
      const full = chat(["hello", "second turn with some more text", "third turn with even more text in it"]);
      const cut = full.slice(0, Math.floor(full.length * 0.55));
      expect(JSON.parse.bind(null, cut)).toThrow(); // genuinely unparseable, like a capped capture
      expect(groupsOf([full, cut])).toBe(1);
      expect(analyzeRequest(cut).hashes.length).toBeGreaterThan(0); // leading messages still extracted
    });

    it("a moving cache_control breakpoint does not split a conversation", () => {
      const withCc = JSON.stringify({ messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }] });
      const withoutCc = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      expect(groupsOf([withCc, withoutCc])).toBe(1);
    });

    it("the same metadata.user_id unions even when content diverged (compaction)", () => {
      expect(groupsOf([chat(["rewritten context"], "sess_A"), chat(["different now"], "sess_A")])).toBe(1);
      expect(groupsOf([chat(["session one"], "sess_A"), chat(["session two"], "sess_B")])).toBe(2);
    });

    it("responses wire: string input and array input of the same text are the same prefix", () => {
      expect(
        groupsOf([
          JSON.stringify({ input: "fix the bug" }),
          JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] }] }),
          JSON.stringify({
            input: [
              { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
              { type: "message", role: "user", content: [{ type: "input_text", text: "still failing" }] },
            ],
          }),
        ]),
      ).toBe(1);
    });

    it("unidentifiable bodies stay solo; the title falls back", () => {
      expect(groupsOf(["not json", "also not json"])).toBe(2);
      expect(analyzeRequest("not json")).toEqual({ hashes: [], uid: "", title: "" });
    });

    it("title = first user message preview, whitespace-collapsed, capped at 80 chars", () => {
      expect(analyzeRequest(chat(["  hello   world "])).title).toBe("hello world");
      expect(analyzeRequest(chat(["a".repeat(120)])).title).toBe("a".repeat(80) + "…");
      const sysFirst = JSON.stringify({ messages: [{ role: "system", content: "sys prompt" }, { role: "user", content: "real ask" }] });
      expect(analyzeRequest(sysFirst).title).toBe("real ask");
    });

    it("title skips injected <system-reminder> chunks to the real prompt in the same message", () => {
      const cc = JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "<system-reminder>\nAs you answer the user's questions, you can use the following context.\n</system-reminder>" },
              { type: "text", text: "fix the login bug" },
            ],
          },
        ],
      });
      expect(analyzeRequest(cc).title).toBe("fix the login bug");
      // wrapper inline before the prompt in ONE string (Claude Code ide_selection style)
      const inline = JSON.stringify({
        messages: [{ role: "user", content: "<ide_selection>lines 119 to 131</ide_selection>\n\nrefactor this loop" }],
      });
      expect(analyzeRequest(inline).title).toBe("refactor this loop");
      // a message that is ONLY a wrapper → nothing left to title
      expect(analyzeRequest(JSON.stringify({ messages: [{ role: "user", content: "<system-reminder>only this</system-reminder>" }] })).title).toBe("");
    });

    it("conversationGroupsOf returns ids and shapes aligned with the input", () => {
      const { ids, shapes } = conversationGroupsOf([chat(["a"]), chat(["a", "b"]), "garbage"]);
      expect(ids).toHaveLength(3);
      expect(shapes).toHaveLength(3);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
      expect(shapes[0].title).toBe("a");
    });
  });
});
