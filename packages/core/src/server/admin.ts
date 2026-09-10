import { Hono, type MiddlewareHandler } from "hono";
import { newProviderId, newApiKey, trimBase } from "../shared/config";
import type { ChainSlot, Format, FormatEntry, LogEntry, ModelEntry, Provider, RouteKey } from "../shared/types";
import type { Store } from "./store";
import { shortError, anthropicAuthHeaders, upstreamTarget, upstreamHeaders } from "./proxy";
import { networkInterfaces } from "node:os";

/** Best-effort LAN IPv4 of this host — the address an agent on another machine
 *  can actually reach (localhost is useless to it). */
function detectLanIp(): string | null {
  const candidates: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const n of list) {
      if (n.family !== "IPv4" || n.internal) continue;
      if (n.address.startsWith("169.254.")) continue; // link-local
      candidates.push(n.address);
    }
  }
  const pick = candidates.find((a) => a.startsWith("192.168.") || a.startsWith("10."));
  return pick ?? candidates[0] ?? null;
}

function mask(key: string): string {
  if (!key) return "";
  return key.length <= 4 ? "••••" : "••••" + key.slice(-4);
}

/** Order-insensitive signature of a formats list, for change detection. */
function formatsKey(f: Format[]): string {
  return [...f].sort().join(",");
}

/** Coerce an RPM cap to a positive integer, or undefined (0/blank/invalid =
 *  unlimited). Accepts a number or a numeric string (form fields send strings). */
function coerceRpm(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Whether a provider is a valid source for a routing slot: openai/anthropic
 *  require that wire format; responses requires supportsResponses. */
function providerSpeaks(p: Provider, key: RouteKey): boolean {
  return key === "responses" ? !!p.supportsResponses : p.formats.includes(key);
}

/** Inverse of proxy's encodeTag: the probe's x-myapikey-provider header carries
 *  a %-encoded provider name (HTTP headers are Latin-1, so a name like "商汤"
 *  can't travel raw). Decode it back for display; fall back to the raw value if
 *  it wasn't encoded (older gateway / already-ASCII). */
function decodeTag(v: string | null): string | undefined {
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Drop every slot for a provider id from a routing slot — used when a provider
 *  is deleted outright or removed from this model's chain. A provider may occupy
 *  more than one slot (each mapped to a different upstream model); all go. */
function purgeProvider(fe: FormatEntry, pid: string): void {
  fe.providers = fe.providers.filter((s) => s.id !== pid);
}

/** Project provider for API responses: hide the full key. */
function toPublic(p: Provider) {
  return {
    id: p.id,
    name: p.name,
    baseUrlOpenai: p.baseUrlOpenai,
    baseUrlAnthropic: p.baseUrlAnthropic,
    formats: p.formats,
    supportsResponses: p.supportsResponses ?? false,
    apiKey: mask(p.apiKey),
    rpm: p.rpm ?? 0,
    discoveredModels: p.discoveredModels ?? [],
    extraModels: p.extraModels ?? [],
    discoveredAt: p.discoveredAt ?? null,
    createdAt: p.createdAt,
  };
}

async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Fetch a provider's model list. Tries OpenAI-style first, then Anthropic-style. */
export async function discoverModels(p: Provider): Promise<string[]> {
  const tryFetch = async (base: string, suffix: string, headers: Record<string, string>) => {
    const res = await fetch(`${trimBase(base)}/${suffix}`, { method: "GET", headers });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: string }[] };
    if (Array.isArray(json.data)) return json.data.map((m) => m.id).filter((x): x is string => !!x);
    return null;
  };
  // Each format probes its own base + suffix. OpenAI lists at /models; Anthropic
  // at /v1/models (its base excludes /v1). Both return the {data:[{id}]} shape.
  const attempts: { base: string; suffix: string; headers: Record<string, string> }[] = [];
  if (p.formats.includes("openai"))
    attempts.push({ base: p.baseUrlOpenai, suffix: "models", headers: { authorization: `Bearer ${p.apiKey}` } });
  if (p.formats.includes("anthropic"))
    attempts.push({ base: p.baseUrlAnthropic, suffix: "v1/models", headers: anthropicAuthHeaders(p.apiKey, "2023-06-01") });
  if (!attempts.length)
    attempts.push({ base: p.baseUrlOpenai, suffix: "models", headers: { authorization: `Bearer ${p.apiKey}` } });

  for (const a of attempts) {
    const ids = await tryFetch(a.base, a.suffix, a.headers);
    if (ids && ids.length) return ids;
  }
  return [];
}

/**
 * Re-run discovery for a provider and persist the result.
 * Network fetch happens OUTSIDE store.update so the write-chain isn't held open.
 * Returns the discovered model ids; on fetch failure returns [] but still
 * records the attempt (discoveredAt), so the UI can tell it was tried.
 */
async function refreshDiscovery(store: Store, id: string): Promise<string[]> {
  const p = store.get().providers.find((x) => x.id === id);
  if (!p) return [];
  let models: string[] = [];
  let failed = false;
  try {
    models = await discoverModels(p);
  } catch {
    failed = true;
  }
  await store.update((d) => {
    const pp = d.providers.find((x) => x.id === id);
    if (pp) {
      pp.discoveredModels = failed ? pp.discoveredModels ?? [] : models;
      pp.discoveredAt = Date.now();
    }
  });
  return failed ? (store.get().providers.find((x) => x.id === id)?.discoveredModels ?? []) : models;
}

/** One model's public projection (GET /models entries and the upsert response). */
function projectModel(name: string, e: ModelEntry, byId: Map<string, Provider>) {
  const proj = (fe: FormatEntry) => ({
    enabled: fe.enabled,
    providers: fe.providers.map((s) => ({
      id: s.id,
      name: byId.get(s.id)?.name ?? "?",
      // Upstream model name this slot rewrites the request to (undefined =
      // send the public model name verbatim). Carried inline on each slot so
      // a provider can appear more than once with different upstream names.
      model: s.model,
      // Default thinking level for this slot (undefined = pure passthrough).
      thinking: s.thinking,
    })),
  });
  return {
    name,
    openai: proj(e.openai),
    anthropic: proj(e.anthropic),
    responses: proj(e.responses),
    paceRpm: e.paceRpm ?? 0,
    debugCapture: e.debugCapture === true,
  };
}

export function adminApi(store: Store, auth: MiddlewareHandler, openai: Hono, anthropic: Hono): Hono {
  const app = new Hono();
  app.use("*", auth);

  // --- account ---
  app.get("/account", (c) => {
    const a = store.get().account;
    return c.json({ username: a.username, password: a.password });
  });

  // Update username and/or password. Either field is optional (omit to keep the
  // current value), mirroring the provider PUT "blank = keep" convention.
  // The auth middleware reads the account live from the store, so a change takes
  // effect immediately without a restart. (The call itself is authed with the
  // old credentials; web clients must refresh their cached creds afterward.)
  app.put("/account", async (c) => {
    const body = await readJson<{ username?: string; password?: string }>(c.req.raw);
    if (!body) return c.json({ error: { message: "username and/or password required" } }, 400);
    const username = body.username?.trim();
    const password = body.password;
    if (body.username !== undefined && !username) {
      return c.json({ error: { message: "username must not be empty" } }, 400);
    }
    if (password !== undefined && password.length < 8) {
      return c.json({ error: { message: "password must be at least 8 characters" } }, 400);
    }
    if (username === undefined && password === undefined) {
      return c.json({ error: { message: "nothing to update" } }, 400);
    }
    await store.update((d) => {
      if (username !== undefined) d.account.username = username;
      if (password !== undefined) d.account.password = password;
    });
    return c.json({ ok: true });
  });

  // --- api key (separate from the account password; what /v1 checks) ---
  app.get("/api-key", (c) => c.json({ apiKey: store.get().apiKey }));
  app.get("/connection", (c) => c.json({ lanIp: detectLanIp() }));

  app.post("/api-key/rotate", async (c) => {
    const apiKey = newApiKey();
    await store.update((d) => {
      d.apiKey = apiKey;
    });
    return c.json({ apiKey });
  });

  // --- providers ---
  app.get("/providers", (c) => c.json({ providers: store.get().providers.map(toPublic) }));

  app.post("/providers", async (c) => {
    const body = await readJson<{ name?: string; baseUrlOpenai?: string; baseUrlAnthropic?: string; apiKey?: string; formats?: Format[]; supportsResponses?: boolean; rpm?: number }>(c.req.raw);
    const formats = body?.formats ?? [];
    const needOpenai = formats.includes("openai");
    const needAnthropic = formats.includes("anthropic");
    if (!body?.name || !body?.apiKey || !formats.length) {
      return c.json({ error: { message: "name, apiKey, formats are required" } }, 400);
    }
    if ((needOpenai && !body.baseUrlOpenai) || (needAnthropic && !body.baseUrlAnthropic)) {
      return c.json({ error: { message: "a base URL is required for each selected format" } }, 400);
    }
    const id = newProviderId();
    const baseUrlOpenai = trimBase(body.baseUrlOpenai ?? "");
    const baseUrlAnthropic = trimBase(body.baseUrlAnthropic ?? "");
    const rpm = coerceRpm(body!.rpm);
    await store.update((d) => {
      d.providers.push({
        id,
        name: body.name!,
        baseUrlOpenai,
        baseUrlAnthropic,
        apiKey: body.apiKey!,
        formats,
        supportsResponses: body.supportsResponses === true,
        ...(rpm ? { rpm } : {}),
        createdAt: Date.now(),
      });
    });
    // Auto-discover so the user immediately sees what this source offers.
    const discovered = await refreshDiscovery(store, id).catch(() => [] as string[]);
    const created = store.get().providers.find((x) => x.id === id)!;
    return c.json({ provider: toPublic(created), discovered }, 201);
  });

  app.put("/providers/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readJson<{ name?: string; baseUrlOpenai?: string; baseUrlAnthropic?: string; apiKey?: string; formats?: Format[]; supportsResponses?: boolean; rpm?: number }>(c.req.raw);
    const formats = body?.formats ?? [];
    const needOpenai = formats.includes("openai");
    const needAnthropic = formats.includes("anthropic");
    if (!body?.name || !formats.length) {
      return c.json({ error: { message: "name, formats are required" } }, 400);
    }
    if ((needOpenai && !body.baseUrlOpenai) || (needAnthropic && !body.baseUrlAnthropic)) {
      return c.json({ error: { message: "a base URL is required for each selected format" } }, 400);
    }
    const baseUrlOpenai = trimBase(body.baseUrlOpenai ?? "");
    const baseUrlAnthropic = trimBase(body.baseUrlAnthropic ?? "");
    let rediscover = false;
    await store.update((d) => {
      const p = d.providers.find((x) => x.id === id);
      if (!p) return;
      // apiKey is optional on edit: omit to keep the existing key (we only ever
      // expose a masked key to clients, so they can't send the real one back).
      const newKey = body.apiKey ? body.apiKey : p.apiKey;
      rediscover =
        p.baseUrlOpenai !== baseUrlOpenai ||
        p.baseUrlAnthropic !== baseUrlAnthropic ||
        (!!body.apiKey && p.apiKey !== body.apiKey) ||
        formatsKey(p.formats) !== formatsKey(formats);
      p.name = body.name!;
      p.baseUrlOpenai = baseUrlOpenai;
      p.baseUrlAnthropic = baseUrlAnthropic;
      p.apiKey = newKey;
      p.formats = formats;
      if (body.supportsResponses !== undefined) p.supportsResponses = body.supportsResponses;
      // rpm: present in the body → set (0/invalid clears to unlimited); absent → keep.
      if (body!.rpm !== undefined) {
        const rpm = coerceRpm(body!.rpm);
        if (rpm) p.rpm = rpm;
        else delete p.rpm;
      }
    });
    const found = store.get().providers.find((x) => x.id === id);
    if (!found) return c.json({ error: { message: "provider not found" } }, 404);
    if (rediscover) await refreshDiscovery(store, id).catch(() => {});
    return c.json({ provider: toPublic(store.get().providers.find((x) => x.id === id)!) });
  });

  app.delete("/providers/:id", async (c) => {
    const id = c.req.param("id");
    let found = false;
    await store.update((d) => {
      found = d.providers.some((p) => p.id === id);
      d.providers = d.providers.filter((p) => p.id !== id);
      for (const m of Object.values(d.models)) {
        purgeProvider(m.openai, id);
        purgeProvider(m.anthropic, id);
        purgeProvider(m.responses, id);
      }
    });
    if (!found) return c.json({ error: { message: "provider not found" } }, 404);
    return c.json({ ok: true });
  });

  app.post("/providers/:id/discover", async (c) => {
    const id = c.req.param("id");
    const p = store.get().providers.find((x) => x.id === id);
    if (!p) return c.json({ error: { message: "provider not found" } }, 404);
    try {
      const models = await refreshDiscovery(store, id);
      return c.json({ models });
    } catch (e) {
      return c.json({ error: { message: `discovery failed: ${(e as Error).message}`, models: [] } }, 502);
    }
  });

  // Manual supplement to discovery: upstream model ids a backend's /models list
  // doesn't include but that still work (delisted, unlisted, behind a different
  // endpoint). Wholesale replace — same one-shot-save convention as PUT
  // /admin/models/:name. Discovery refreshes only ever rewrite
  // `discoveredModels`, so anything stored here survives every re-scan.
  app.put("/providers/:id/extra-models", async (c) => {
    const id = c.req.param("id");
    const body = await readJson<{ models?: unknown }>(c.req.raw);
    if (!body || !Array.isArray(body.models) || body.models.some((m) => typeof m !== "string")) {
      return c.json({ error: { message: "models (string[]) is required" } }, 400);
    }
    // Canonical form: trimmed, deduped, case-insensitively sorted for scanning.
    const models = [...new Set((body.models as string[]).map((m) => m.trim()).filter(Boolean))].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    let found = false;
    await store.update((d) => {
      const p = d.providers.find((x) => x.id === id);
      if (!p) return;
      found = true;
      if (models.length) p.extraModels = models;
      else delete p.extraModels;
    });
    if (!found) return c.json({ error: { message: "provider not found" } }, 404);
    return c.json({ provider: toPublic(store.get().providers.find((x) => x.id === id)!) });
  });

  // Test a SOURCE directly: one minimal ping per selected protocol, straight to
  // the upstream with this source's own key + base URL. Unlike the model tests
  // (which loop back through dispatch) this needs no routing config, so an
  // unrouted source can be checked too — and it takes no routing side-effects
  // (no logs, no circuit, no pacing). ?model= is the upstream name sent
  // verbatim; ?format= (repeatable) narrows the protocols, defaulting to every
  // one the source supports (responses only when supportsResponses).
  app.post("/providers/:id/test", async (c) => {
    const p = store.get().providers.find((x) => x.id === c.req.param("id"));
    if (!p) return c.json({ error: { message: "provider not found" } }, 404);
    const model = (c.req.query("model") ?? "").trim();
    if (!model) return c.json({ error: { message: "?model= (upstream model name) is required" } }, 400);
    const wanted = (c.req.queries("format") ?? []).filter(
      (f): f is RouteKey => f === "openai" || f === "anthropic" || f === "responses",
    );
    const formats: RouteKey[] = wanted.length
      ? wanted
      : [...p.formats, ...(p.supportsResponses ? ["responses" as const] : [])];
    const results = await Promise.all(
      formats.map(async (format) => {
        if (format === "responses" ? !p.supportsResponses : !p.formats.includes(format as Format)) {
          return { format, ok: false, status: 0, ms: 0, error: "source does not speak this format" };
        }
        const start = Date.now();
        try {
          // /responses takes `input`, not `messages` (same probe bodies as the
          // model tests); max_tokens: 1 keeps the ping cheap.
          const body =
            format === "responses"
              ? { model, input: "ping", stream: false }
              : { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
          const res = await fetch(upstreamTarget(p, format).url, {
            method: "POST",
            headers: upstreamHeaders(p, format === "responses" ? "openai" : format),
            body: JSON.stringify(body),
          });
          const ms = Date.now() - start;
          // Drain so the connection is released; the text feeds the error line.
          const txt = await res.text().catch(() => "");
          return res.ok
            ? { format, ok: true, status: res.status, ms }
            : { format, ok: false, status: res.status, ms, error: shortError(txt) || `HTTP ${res.status}` };
        } catch (e) {
          return { format, ok: false, status: 0, ms: Date.now() - start, error: `network error: ${(e as Error).message}` };
        }
      }),
    );
    return c.json({ results });
  });

  // --- models ---
  app.get("/models", (c) => {
    const d = store.get();
    const byId = new Map(d.providers.map((p) => [p.id, p]));
    // Where each model's traffic ACTUALLY landed most recently: the latest
    // successful call per (model, format) from the log tail (newest first,
    // so the first hit wins). The UI shows this as the model's in-use slot —
    // after a failover the chip follows the source that really served.
    // Companion map for FAILURES (latest 4xx/5xx per model+format) so the
    // chain popover can flag the slots that recently errored.
    // Legacy rows carry only the provider NAME; resolve it to the stable id
    // so they can still match a slot.
    const byName = new Map(d.providers.map((p) => [p.name, p.id]));
    const okLog = new Map<string, Map<string, LogEntry>>();
    const badLog = new Map<string, Map<string, LogEntry>>();
    for (const row of store.getLogs()) {
      const pid = row.providerId ?? (row.provider ? byName.get(row.provider) : undefined);
      if (!pid) continue;
      const target = row.status >= 200 && row.status < 400 ? okLog : badLog;
      let perFmt = target.get(row.model);
      if (!perFmt) target.set(row.model, (perFmt = new Map()));
      if (!perFmt.has(row.format)) perFmt.set(row.format, row);
    }
    const lastEntries = (src: Map<string, Map<string, LogEntry>>, name: string) =>
      [...src.get(name)?.entries() ?? []];
    const models = Object.entries(d.models).map(([name, e]) => ({
      ...projectModel(name, e, byId),
      lastRoute: lastEntries(okLog, name).map(([format, row]) => ({
        format,
        providerId: row.providerId ?? byName.get(row.provider) ?? "",
        // The upstream name that was actually forwarded (a per-slot rewrite,
        // or the public name sent verbatim).
        model: row.upstreamModel ?? row.model,
        ts: row.ts,
      })),
      lastFail: lastEntries(badLog, name).map(([format, row]) => ({
        format,
        providerId: row.providerId ?? byName.get(row.provider) ?? "",
        model: row.upstreamModel ?? row.model,
        status: row.status,
        error: row.error,
        ts: row.ts,
      })),
    }));
    return c.json({ models });
  });

  // Enable a model on ONE routing slot (and optionally seed its chain). Creates
  // the entry if absent (all slots start disabled); never touches other slots.
  // Every requested provider must exist and be compatible with the slot.
  app.post("/models", async (c) => {
    const body = await readJson<{ name?: string; format?: RouteKey; providers?: string[] }>(c.req.raw);
    if (!body?.name) return c.json({ error: { message: "name is required" } }, 400);
    if (!body.format) return c.json({ error: { message: "format is required (openai, anthropic, or responses)" } }, 400);
    const name = body.name;
    const key = body.format;
    const cfg = store.get();
    const requested = body.providers ?? [];
    for (const pid of requested) {
      const p = cfg.providers.find((x) => x.id === pid);
      if (!p) return c.json({ error: { message: `provider not found: ${pid}` } }, 400);
      if (!providerSpeaks(p, key))
        return c.json({ error: { message: `provider ${p.name} does not serve ${key}` } }, 400);
    }
    await store.update((d) => {
      const entry = (d.models[name] ??= {
        openai: { enabled: false, providers: [] },
        anthropic: { enabled: false, providers: [] },
        responses: { enabled: false, providers: [] },
      });
      const fe = entry[key];
      // Enable/seed dedupes by provider id: re-enabling must not pile up
      // duplicate slots. (Use POST /:name/providers to intentionally add a
      // second occurrence of a provider for per-model failover.)
      for (const pid of requested) if (!fe.providers.some((s) => s.id === pid)) fe.providers.push({ id: pid });
      fe.enabled = true;
    });
    return c.json({ ok: true }, 201);
  });

  // Upsert a model's WHOLE routing config in one call — the "name it, build its
  // chains, save once" flow the web editor is built around. Each format key
  // present in the body REPLACES that FormatEntry wholesale; keys absent from
  // the body are left untouched (a fresh entry seeds them disabled + empty).
  // Every slot's provider must exist and speak that slot's format (responses
  // additionally requires supportsResponses), mirroring the granular endpoints.
  // The response carries the projected model (GET /models shape) so clients can
  // update in place without a refetch.
  app.put("/models/:name", async (c) => {
    const name = (c.req.param("name") ?? "").trim();
    if (!name) return c.json({ error: { message: "name is required" } }, 400);
    // Names live in URL path params on every granular endpoint — a "/" would
    // make those routes unreachable for this model.
    if (name.includes("/")) return c.json({ error: { message: "model name must not contain '/'" } }, 400);
    const body = await readJson<{
      openai?: { enabled?: boolean; slots?: unknown };
      anthropic?: { enabled?: boolean; slots?: unknown };
      responses?: { enabled?: boolean; slots?: unknown };
      paceRpm?: number;
    }>(c.req.raw);
    if (!body) return c.json({ error: { message: "body required" } }, 400);

    const cfg = store.get();
    const existed = !!cfg.models[name];
    // Parse + validate every provided format BEFORE writing: an invalid slot
    // anywhere must not leave a half-replaced config behind.
    const parsed: Partial<Record<RouteKey, FormatEntry>> = {};
    for (const key of ["openai", "anthropic", "responses"] as RouteKey[]) {
      const raw = body[key];
      if (!raw) continue;
      const chain: ChainSlot[] = [];
      for (const s of Array.isArray(raw.slots) ? raw.slots : []) {
        const slot = s as { id?: unknown; model?: unknown; thinking?: unknown };
        const pid = typeof slot?.id === "string" ? slot.id : "";
        const p = cfg.providers.find((x) => x.id === pid);
        if (!p) return c.json({ error: { message: `provider not found: ${pid || "(empty)"}` } }, 400);
        if (!providerSpeaks(p, key))
          return c.json({ error: { message: `provider ${p.name} does not serve ${key}` } }, 400);
        const model = typeof slot.model === "string" ? slot.model.trim() : "";
        const thinkRaw = slot.thinking === undefined || slot.thinking === null ? "" : String(slot.thinking).trim();
        if (thinkRaw && key === "anthropic" && (!/^\d+$/.test(thinkRaw) || Number(thinkRaw) < 1))
          return c.json({ error: { message: "anthropic thinking default must be a positive integer (thinking budget tokens, e.g. 8192)" } }, 400);
        if (thinkRaw && key !== "anthropic" && thinkRaw.length > 32)
          return c.json({ error: { message: "thinking default too long (max 32 chars)" } }, 400);
        const cs: ChainSlot = { id: pid };
        if (model) cs.model = model;
        if (thinkRaw) cs.thinking = key === "anthropic" ? String(Number(thinkRaw)) : thinkRaw;
        chain.push(cs);
      }
      parsed[key] = { enabled: raw.enabled !== false, providers: chain };
    }
    const pace = body.paceRpm !== undefined ? coerceRpm(body.paceRpm) : undefined;

    await store.update((d) => {
      const entry = (d.models[name] ??= {
        openai: { enabled: false, providers: [] },
        anthropic: { enabled: false, providers: [] },
        responses: { enabled: false, providers: [] },
      });
      for (const key of ["openai", "anthropic", "responses"] as RouteKey[]) {
        if (parsed[key]) entry[key] = parsed[key]!;
      }
      if (body.paceRpm !== undefined) {
        if (pace) entry.paceRpm = pace;
        else delete entry.paceRpm;
      }
    });
    const byId = new Map(store.get().providers.map((p) => [p.id, p]));
    return c.json({ model: projectModel(name, store.get().models[name], byId) }, existed ? 200 : 201);
  });

  // Rename a model - changes the ROUTING KEY, the name clients request. The
  // config entry (enabled slots, chains, upstream mappings) moves as-is, so
  // an unmapped slot now forwards the NEW name upstream (that's the point of
  // renaming); slots with an explicit upstream mapping keep it. Renaming to
  // an existing name is rejected; key order in data.json is preserved.
  app.post("/models/:name/rename", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ name?: string }>(c.req.raw);
    const next = body?.name?.trim();
    if (!next) return c.json({ error: { message: "name is required" } }, 400);
    if (next === name) return c.json({ error: { message: "new name is the same as the current one" } }, 400);
    const cfg = store.get();
    if (!cfg.models[name]) return c.json({ error: { message: "model not found" } }, 404);
    if (cfg.models[next]) return c.json({ error: { message: `model already exists: ${next}` } }, 409);
    store.clearCaptures(name); // captured bodies keyed by the old name are unreachable now
    await store.update((d) => {
      const rebuilt: typeof d.models = {};
      for (const [k, v] of Object.entries(d.models)) rebuilt[k === name ? next : k] = v;
      d.models = rebuilt;
    });
    return c.json({ ok: true });
  });

  app.post("/models/:name/providers", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ format?: RouteKey; providerId?: string; model?: string }>(c.req.raw);
    if (!body?.format) return c.json({ error: { message: "format is required" } }, 400);
    if (!body?.providerId) return c.json({ error: { message: "providerId is required" } }, 400);
    const cfg = store.get();
    const p = cfg.providers.find((x) => x.id === body.providerId);
    if (!p) return c.json({ error: { message: "provider not found" } }, 400);
    if (!providerSpeaks(p, body.format))
      return c.json({ error: { message: `provider ${p.name} does not serve ${body.format}` } }, 400);
    // No dedupe guard: appending a SECOND occurrence of a provider is the whole
    // point (failover across its models). An optional `model` sets the new
    // slot's upstream name at attach time (add + map in one call).
    const upstream = body.model?.trim();
    const slot = upstream ? { id: body.providerId!, model: upstream } : { id: body.providerId! };
    let errStatus = 0;
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        return;
      }
      entry[body.format!].providers.push(slot);
    });
    if (errStatus === 404) return c.json({ error: { message: "model not found; enable it first" } }, 404);
    return c.json({ ok: true });
  });

  // Remove a SINGLE chain slot at `index` (the web's per-row remove). Distinct
  // from the id-based delete below, which removes every slot for a provider.
  app.delete("/models/:name/providers", async (c) => {
    const name = c.req.param("name");
    const format = c.req.query("format") as RouteKey | undefined;
    const index = Number(c.req.query("index"));
    if (!format) return c.json({ error: { message: "?format=openai|anthropic|responses is required" } }, 400);
    if (!Number.isInteger(index) || index < 0)
      return c.json({ error: { message: "?index= (non-negative integer) is required" } }, 400);
    let errStatus = 0;
    await store.update((d) => {
      const fe = d.models[name]?.[format];
      if (!fe) {
        errStatus = 404;
        return;
      }
      if (index >= fe.providers.length) {
        errStatus = 400;
        return;
      }
      fe.providers.splice(index, 1);
    });
    if (errStatus === 404) return c.json({ error: { message: "model not found" } }, 404);
    if (errStatus === 400) return c.json({ error: { message: "index out of range" } }, 400);
    return c.json({ ok: true });
  });

  app.delete("/models/:name/providers/:providerId", async (c) => {
    const name = c.req.param("name");
    const pid = c.req.param("providerId");
    const format = c.req.query("format") as RouteKey | undefined;
    if (!format) return c.json({ error: { message: "?format=openai|anthropic|responses is required" } }, 400);
    await store.update((d) => {
      const entry = d.models[name];
      if (entry) purgeProvider(entry[format], pid);
    });
    return c.json({ ok: true });
  });

  app.put("/models/:name/priority", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ format?: RouteKey; order?: number[] }>(c.req.raw);
    if (!body?.format) return c.json({ error: { message: "format is required" } }, 400);
    if (!Array.isArray(body?.order) || !body.order.every((n) => Number.isInteger(n)))
      return c.json({ error: { message: "order[] (integers) required" } }, 400);
    const format = body.format;
    let errStatus = 0;
    let errMsg = "";
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        return;
      }
      const fe = entry[format];
      const n = fe.providers.length;
      // Reorder only: `order` must be a permutation of [0..n-1] (the current
      // slot positions). Indices — not provider ids — because a provider may now
      // occupy several slots. Use add-provider / remove-provider to change membership.
      if (
        body.order!.length !== n ||
        new Set(body.order).size !== n ||
        !body.order!.every((i) => i >= 0 && i < n)
      ) {
        errStatus = 400;
        errMsg = "order must be a reordering of the current chain (no add/drop)";
        return;
      }
      fe.providers = body.order!.map((i) => fe.providers[i]);
    });
    if (errStatus === 404) return c.json({ error: { message: "model not found" } }, 404);
    if (errStatus === 400) return c.json({ error: { message: errMsg } }, 400);
    return c.json({ ok: true });
  });

  // Set (or clear) the per-model even-pacing limit: `rpm` requests/min spread
  // evenly (one every 60/rpm seconds; excess calls queue at the gateway, capped
  // at a 60s wait). 0/blank/invalid clears. Model-wide - shared by all three
  // route slots - and independent of the per-source Provider.rpm spill-over.
  app.put("/models/:name/pace", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ rpm?: number }>(c.req.raw);
    const rpm = coerceRpm(body?.rpm);
    let errStatus = 0;
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        return;
      }
    if (rpm) entry.paceRpm = rpm;
    else delete entry.paceRpm;
  });
  if (errStatus === 404) return c.json({ error: { message: "model not found" } }, 404);
  return c.json({ ok: true, paceRpm: rpm ?? 0 });
});

// Debug capture switch (pure debugging aid — see ModelEntry.debugCapture).
// ON: dispatch records every upstream attempt for this model (exact forwarded
// request + response bodies) into an in-memory ring buffer, last 50. OFF: the
// buffer is cleared immediately — captured conversations shouldn't outlive the
// debugging session. Independently, FAILED attempts always land in a global
// in-memory net (last 50 across all models) so an error can be inspected even
// when the switch was never on; `failures` here is that net filtered to this
// model. The switch is config state (persists in data.json); the captured
// bodies do not (in-memory only, restart clears them too).
app.get("/models/:name/debug", (c) => {
  const name = c.req.param("name");
  if (!store.get().models[name]) return c.json({ error: { message: "model not found" } }, 404);
  return c.json({ enabled: store.isDebug(name), captures: store.getCaptures(name), failures: store.getFailCaptures(name) });
});

app.put("/models/:name/debug", async (c) => {
  const name = c.req.param("name");
  const body = await readJson<{ enabled?: unknown }>(c.req.raw);
  const enabled = body?.enabled === true;
  let errStatus = 0;
  await store.update((d) => {
    const entry = d.models[name];
    if (!entry) {
      errStatus = 404;
      return;
    }
    if (enabled) entry.debugCapture = true;
    else delete entry.debugCapture;
  });
  if (errStatus === 404) return c.json({ error: { message: "model not found" } }, 404);
  if (!enabled) store.clearCaptures(name);
  return c.json({ ok: true, enabled });
});

// Manual scrub of this model's rows in the always-on failure net (the switch
// only governs the per-model buffer; failures age out of the global ring on
// their own — this drops them now).
app.delete("/models/:name/debug/fails", (c) => {
  const name = c.req.param("name");
  if (!store.get().models[name]) return c.json({ error: { message: "model not found" } }, 404);
  store.clearFailCaptures(name);
  return c.json({ ok: true });
});

  // Set (or clear) the upstream-model mapping for ONE chain slot (addressed by
  // `index`). An empty `model` clears it (back to identity — send the public
  // name). Index-addressed because a provider may occupy several slots, each
  // with its own upstream model.
  app.put("/models/:name/map", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ format?: RouteKey; index?: number; model?: string }>(c.req.raw);
    if (!body?.format) return c.json({ error: { message: "format is required" } }, 400);
    if (!Number.isInteger(body?.index) || (body?.index ?? -1) < 0)
      return c.json({ error: { message: "index (non-negative integer) is required" } }, 400);
    const format = body.format;
    const index = body.index!;
    const upstream = (body.model ?? "").trim();
    let errStatus = 0;
    let errMsg = "";
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        errMsg = "model not found";
        return;
      }
      const fe = entry[format];
      if (index >= fe.providers.length) {
        errStatus = 400;
        errMsg = "index out of range for this model's chain";
        return;
      }
      if (upstream) fe.providers[index].model = upstream;
      else delete fe.providers[index].model;
    });
    if (errStatus === 404) return c.json({ error: { message: errMsg } }, 404);
    if (errStatus === 400) return c.json({ error: { message: errMsg } }, 400);
    return c.json({ ok: true });
  });

  // Set (or clear) the default thinking level for ONE chain slot (addressed by
  // `index`, like /map above). The value is whatever the slot's wire format
  // takes natively: an effort token ("low"/"medium"/"high"/…) on openai/
  // responses slots; a thinking budget in TOKENS (positive integer) on
  // anthropic slots (Anthropic has no named levels). When set, dispatch
  // applies it IN PLACE OF whatever thinking parameters the request carried
  // (the gateway's level wins); an empty value clears it (pure passthrough).
  app.put("/models/:name/thinking", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ format?: RouteKey; index?: number; thinking?: string | number }>(c.req.raw);
    if (!body?.format) return c.json({ error: { message: "format is required" } }, 400);
    if (!Number.isInteger(body?.index) || (body?.index ?? -1) < 0)
      return c.json({ error: { message: "index (non-negative integer) is required" } }, 400);
    const format = body.format;
    const index = body.index!;
    const raw = body.thinking === undefined ? "" : String(body.thinking).trim();
    if (raw && format === "anthropic" && (!/^\d+$/.test(raw) || Number(raw) < 1)) {
      return c.json({ error: { message: "anthropic thinking default must be a positive integer (thinking budget tokens, e.g. 8192)" } }, 400);
    }
    if (raw && format !== "anthropic" && raw.length > 32) {
      return c.json({ error: { message: "thinking default too long (max 32 chars)" } }, 400);
    }
    const value = raw && format === "anthropic" ? String(Number(raw)) : raw;
    let errStatus = 0;
    let errMsg = "";
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        errMsg = "model not found";
        return;
      }
      const fe = entry[format];
      if (index >= fe.providers.length) {
        errStatus = 400;
        errMsg = "index out of range for this model's chain";
        return;
      }
      if (value) fe.providers[index].thinking = value;
      else delete fe.providers[index].thinking;
    });
    if (errStatus === 404) return c.json({ error: { message: errMsg } }, 404);
    if (errStatus === 400) return c.json({ error: { message: errMsg } }, 400);
    return c.json({ ok: true, thinking: value || undefined });
  });

  app.post("/models/:name/disable", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ format?: RouteKey }>(c.req.raw);
    if (!body?.format) return c.json({ error: { message: "format is required" } }, 400);
    const format = body.format;
    await store.update((d) => {
      if (d.models[name]) d.models[name][format].enabled = false;
    });
    return c.json({ ok: true });
  });

  // Probe a model end-to-end by driving the REAL /v1 path: an in-process
  // loopback through the proxy sub-app (api-key auth → dispatch → upstream →
  // failover) with the gateway's own api key. It runs the same code a real agent
  // call runs — no mirrored dispatch logic — so the result is true ground truth,
  // it shows up in recent calls like any real call, and it catches a
  // broken/rotated gateway key (which a direct-upstream probe could not).
  // dispatch reports which provider answered via x-myapikey-provider.
  app.post("/models/:name/test", async (c) => {
    const name = c.req.param("name");
    const cfg = store.get();
    if (!cfg.models[name]) return c.json({ error: { message: "model not found" } }, 404);
    let format = c.req.query("format") as RouteKey | undefined;
    if (!format) {
      // No slot requested: pick the first one the model is enabled on.
      const entry = cfg.models[name];
      for (const k of ["openai", "anthropic", "responses"] as RouteKey[]) if (entry[k]?.enabled) { format = k; break; }
    }
    if (!format) {
      return c.json({ result: { ok: false, status: 0, format: "openai", error: "model not enabled on any routing slot" } });
    }
    // Route the loopback to the matching surface: anthropic → the anthropic
    // sub-app (/messages); openai/responses → the openai sub-app (the openai
    // family lives there, including /responses).
    const sub = format === "anthropic" ? anthropic : openai;
    const path = format === "anthropic" ? "/messages" : format === "responses" ? "/responses" : "/chat/completions";
    // /responses is the OpenAI Responses API — it takes `input`, not `messages`.
    const body =
      format === "responses"
        ? { model: name, input: "ping", stream: false }
        : { model: name, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
    let res: Response;
    try {
      res = await sub.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, "x-myapikey-probe": "1" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return c.json({ result: { ok: false, status: 0, format, error: `gateway loopback failed: ${(e as Error).message}` } });
    }
    const provider = decodeTag(res.headers.get("x-myapikey-provider"));
    // Drain the loopback body so a SUCCESSFUL probe's log row is actually
    // written: the success log lives in the response stream's completion
    // callback (observedBody's onSettle), which only fires once the body is
    // consumed — a 200 at the headers is committed before the body flows, so
    // returning here without reading would silently drop the log. The text is
    // reused for the failure message below.
    const txt = await res.text().catch(() => "");
    if (res.ok) return c.json({ result: { ok: true, status: res.status, provider, format } });
    return c.json({ result: { ok: false, status: res.status, provider, format, error: shortError(txt) || `HTTP ${res.status}` } });
  });

  // Probe a SINGLE chain slot for a model+format: the same end-to-end loopback as
  // the whole-model /test above, but dispatch is pinned to this one slot (via the
  // x-myapikey-probe-slot header carrying the slot index), so there is no failover
  // and no circuit-breaker impact — a manual "is THIS source up?" check that
  // reports the slot's real upstream status (the slot's own mapped model name).
  // Slot-indexed (not provider-id) because a provider may occupy several slots,
  // each mapped to a different upstream model. Validation misses come back as a
  // ProbeResult body, not an HTTP error, so the caller reads `result` uniformly.
  app.post("/models/:name/providers/test", async (c) => {
    const name = c.req.param("name");
    const cfg = store.get();
    const entry = cfg.models[name];
    if (!entry) return c.json({ error: { message: "model not found" } }, 404);
    const index = Number(c.req.query("index"));
    let format = c.req.query("format") as RouteKey | undefined;
    if (!format) {
      // No slot requested: pick the first one the model is enabled on.
      for (const k of ["openai", "anthropic", "responses"] as RouteKey[]) if (entry[k]?.enabled) { format = k; break; }
    }
    if (!format || !entry[format]?.enabled) {
      return c.json({ result: { ok: false, status: 0, format: format ?? "openai", error: "model not enabled on that routing slot" } });
    }
    if (!Number.isInteger(index) || index < 0 || index >= entry[format].providers.length) {
      return c.json({ result: { ok: false, status: 0, format, error: "slot index out of range for this route" } });
    }
    const pid = entry[format].providers[index].id;
    const provider = cfg.providers.find((p) => p.id === pid);
    if (!provider || !providerSpeaks(provider, format)) {
      return c.json({ result: { ok: false, status: 0, format, error: "source does not speak this format" } });
    }
    const sub = format === "anthropic" ? anthropic : openai;
    const path = format === "anthropic" ? "/messages" : format === "responses" ? "/responses" : "/chat/completions";
    // /responses is the OpenAI Responses API — it takes `input`, not `messages`.
    const body =
      format === "responses"
        ? { model: name, input: "ping", stream: false }
        : { model: name, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
    let res: Response;
    try {
      res = await sub.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, "x-myapikey-probe": "1", "x-myapikey-probe-slot": String(index) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return c.json({ result: { ok: false, status: 0, format, error: `gateway loopback failed: ${(e as Error).message}` } });
    }
    const answeredBy = decodeTag(res.headers.get("x-myapikey-provider"));
    // Drain the loopback body (see /test above) so a successful pinned probe's
    // log row is written — the success log fires only when the body is consumed.
    const txt = await res.text().catch(() => "");
    if (res.ok) return c.json({ result: { ok: true, status: res.status, provider: answeredBy, format } });
    return c.json({ result: { ok: false, status: res.status, provider: answeredBy, format, error: shortError(txt) || `HTTP ${res.status}` } });
  });

  app.delete("/models/:name", async (c) => {
    const name = c.req.param("name");
    await store.update((d) => {
      delete d.models[name];
    });
    store.clearCaptures(name);
    return c.json({ ok: true });
  });

  // --- logs ---
  app.get("/logs", (c) => c.json({ logs: store.getLogs() }));

  // --- stats (aggregate over the retained call history; never polled) ---
  app.get("/stats", (c) => {
    const r = c.req.query("range") ?? "7d";
    const DAY = 24 * 60 * 60 * 1000;
    const rangeMs =
      r === "24h" ? DAY : r === "7d" ? 7 * DAY : r === "30d" ? 30 * DAY : r === "90d" ? 90 * DAY : 0; // 0 = "all"
    return c.json(store.getStats(rangeMs));
  });

  // --- storage (read-only: where data.json + logs.jsonl live) ---
  app.get("/storage", (c) => c.json(store.getPaths()));

  // --- circuit breaker (read-only snapshot + manual reset) ---
  app.get("/circuit", (c) => c.json({ providers: store.circuitState() }));
  app.post("/circuit/:id/reset", (c) => {
    store.resetCircuit(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
