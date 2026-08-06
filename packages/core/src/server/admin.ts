import { Hono, type MiddlewareHandler } from "hono";
import { newProviderId, newApiKey, trimBase } from "../shared/config";
import type { Format, FormatEntry, Provider, RouteKey } from "../shared/types";
import type { Store } from "./store";
import { probeModel } from "./proxy";
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

/** Whether a provider is a valid source for a routing slot: openai/anthropic
 *  require that wire format; responses requires supportsResponses. */
function providerSpeaks(p: Provider, key: RouteKey): boolean {
  return key === "responses" ? !!p.supportsResponses : p.formats.includes(key);
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
    discoveredModels: p.discoveredModels ?? [],
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
    attempts.push({ base: p.baseUrlAnthropic, suffix: "v1/models", headers: { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" } });
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

export function adminApi(store: Store, auth: MiddlewareHandler): Hono {
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
    const body = await readJson<{ name?: string; baseUrlOpenai?: string; baseUrlAnthropic?: string; apiKey?: string; formats?: Format[]; supportsResponses?: boolean }>(c.req.raw);
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
    await store.update((d) => {
      d.providers.push({
        id,
        name: body.name!,
        baseUrlOpenai,
        baseUrlAnthropic,
        apiKey: body.apiKey!,
        formats,
        supportsResponses: body.supportsResponses === true,
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
    const body = await readJson<{ name?: string; baseUrlOpenai?: string; baseUrlAnthropic?: string; apiKey?: string; formats?: Format[]; supportsResponses?: boolean }>(c.req.raw);
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
        m.openai.providers = m.openai.providers.filter((pid) => pid !== id);
        m.anthropic.providers = m.anthropic.providers.filter((pid) => pid !== id);
        m.responses.providers = m.responses.providers.filter((pid) => pid !== id);
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

  // --- models ---
  app.get("/models", (c) => {
    const d = store.get();
    const byId = new Map(d.providers.map((p) => [p.id, p]));
    const proj = (fe: FormatEntry) => ({
      enabled: fe.enabled,
      providers: fe.providers.map((pid) => ({ id: pid, name: byId.get(pid)?.name ?? "?" })),
    });
    const models = Object.entries(d.models).map(([name, e]) => ({
      name,
      openai: proj(e.openai),
      anthropic: proj(e.anthropic),
      responses: proj(e.responses),
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
      for (const pid of requested) if (!fe.providers.includes(pid)) fe.providers.push(pid);
      fe.enabled = true;
    });
    return c.json({ ok: true }, 201);
  });

  app.post("/models/:name/providers", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ format?: RouteKey; providerId?: string }>(c.req.raw);
    if (!body?.format) return c.json({ error: { message: "format is required" } }, 400);
    if (!body?.providerId) return c.json({ error: { message: "providerId is required" } }, 400);
    const cfg = store.get();
    const p = cfg.providers.find((x) => x.id === body.providerId);
    if (!p) return c.json({ error: { message: "provider not found" } }, 400);
    if (!providerSpeaks(p, body.format))
      return c.json({ error: { message: `provider ${p.name} does not serve ${body.format}` } }, 400);
    let errStatus = 0;
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        return;
      }
      if (!entry[body.format!].providers.includes(body.providerId!)) entry[body.format!].providers.push(body.providerId!);
    });
    if (errStatus === 404) return c.json({ error: { message: "model not found; enable it first" } }, 404);
    return c.json({ ok: true });
  });

  app.delete("/models/:name/providers/:providerId", async (c) => {
    const name = c.req.param("name");
    const pid = c.req.param("providerId");
    const format = c.req.query("format") as RouteKey | undefined;
    if (!format) return c.json({ error: { message: "?format=openai|anthropic|responses is required" } }, 400);
    await store.update((d) => {
      const entry = d.models[name];
      if (entry) entry[format].providers = entry[format].providers.filter((x) => x !== pid);
    });
    return c.json({ ok: true });
  });

  app.put("/models/:name/priority", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ format?: RouteKey; providers?: string[] }>(c.req.raw);
    if (!body?.format) return c.json({ error: { message: "format is required" } }, 400);
    if (!Array.isArray(body?.providers)) return c.json({ error: { message: "providers[] required" } }, 400);
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
      // Reorder only: the submitted list must be a permutation of the current
      // chain (use add-provider / remove-provider to change membership).
      const cur = new Set(fe.providers);
      if (body.providers!.length !== cur.size || body.providers!.some((pid) => !cur.has(pid))) {
        errStatus = 400;
        errMsg = "providers must be a reordering of the current chain (no add/drop)";
        return;
      }
      fe.providers = body.providers!;
    });
    if (errStatus === 404) return c.json({ error: { message: "model not found" } }, 404);
    if (errStatus === 400) return c.json({ error: { message: errMsg } }, 400);
    return c.json({ ok: true });
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

  // Probe a model end-to-end: a minimal real call through its routing chain.
  // Reports whether it actually works right now (ground truth — works for
  // sources like Ark that don't expose /models, unlike the discovery heuristic).
  app.post("/models/:name/test", async (c) => {
    const name = c.req.param("name");
    if (!store.get().models[name]) return c.json({ error: { message: "model not found" } }, 404);
    try {
      const format = c.req.query("format") as RouteKey | undefined;
      const result = await probeModel(store, name, format);
      return c.json({ result });
    } catch (e) {
      return c.json({ error: { message: `probe failed: ${(e as Error).message}` } }, 502);
    }
  });

  app.delete("/models/:name", async (c) => {
    const name = c.req.param("name");
    await store.update((d) => {
      delete d.models[name];
    });
    return c.json({ ok: true });
  });

  // --- logs ---
  app.get("/logs", (c) => c.json({ logs: store.logs.slice().reverse() }));

  return app;
}
