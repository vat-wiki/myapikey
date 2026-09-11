/** Conversation grouping for the debug-capture list. Agent surfaces resend the
 *  whole history on every turn, so one conversation shows up as many captured
 *  attempts — this derives a stable per-conversation key from the request body:
 *  `metadata.user_id` when the agent sends one (Claude Code's embeds the
 *  session id), else a hash of the FIRST user message (constant within a
 *  conversation, differs across them). Pure + client-side — capture bodies are
 *  already in gateway memory, the server stays out of it. */

export interface Conversation {
  /** Stable group key; "" when nothing identifiable (caller makes it a solo group). */
  key: string;
  /** Human title: preview of the first user message (or the caller's fallback). */
  title: string;
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Text of a message content — a plain string, or a parts array where only the
 *  text parts matter (images/tool blocks contribute nothing). */
function contentText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(contentText).join(" ");
  if (v && typeof v === "object") {
    const t = (v as Record<string, unknown>).text;
    if (typeof t === "string") return t;
  }
  return "";
}

/** First user-message text across the three wires: chat/anthropic `messages`
 *  and responses `input` (string or message array). "" when absent. */
export function firstUserText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  if (typeof b.input === "string") return b.input.trim();
  const msgs = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : [];
  for (const m of msgs) {
    if (m && typeof m === "object" && (m as Record<string, unknown>).role === "user") {
      const txt = contentText((m as Record<string, unknown>).content).trim();
      if (txt) return txt;
    }
  }
  return "";
}

const TITLE_MAX = 80;

function preview(txt: string): string {
  const flat = txt.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
}

export function conversationOf(request: string, fallbackTitle: string): Conversation {
  let body: unknown;
  try {
    body = JSON.parse(request);
  } catch {
    body = null;
  }
  const uid =
    body && typeof body === "object"
      ? (body as Record<string, any>).metadata?.user_id
      : undefined;
  const txt = firstUserText(body);
  if (typeof uid === "string" && uid) return { key: `u:${hashStr(uid)}`, title: txt ? preview(txt) : fallbackTitle };
  if (txt) {
    // Key hashes the normalized title (not raw text) — part-array joins and
    // formatting differences must not split one conversation in two.
    const title = preview(txt);
    return { key: `m:${hashStr(title)}`, title };
  }
  return { key: "", title: fallbackTitle };
}
