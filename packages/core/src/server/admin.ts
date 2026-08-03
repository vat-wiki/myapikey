import { Hono, type MiddlewareHandler } from "hono";
import { newProviderId, trimBase } from "../shared/config";
import type { Format, Provider } from "../shared/types";
import type { Store } from "./store";

function mask(key: string): string {
  if (!key) return "";
  return key.length <= 4 ? "••••" : "••••" + key.slice(-4);
}

/** Project provider for API responses: hide the full key. */
function toPublic(p: Provider) {
  return { id: p.id, name: p.name, baseUrl: p.baseUrl, formats: p.formats, apiKey: mask(p.apiKey), createdAt: p.createdAt };
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
  const base = trimBase(p.baseUrl);
  const tryFetch = async (headers: Record<string, string>) => {
    const res = await fetch(`${base}/models`, { method: "GET", headers });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: string }[] };
    if (Array.isArray(json.data)) return json.data.map((m) => m.id).filter((x): x is string => !!x);
    return null;
  };
  const headersList: Record<string, string>[] = [];
  if (p.formats.includes("openai")) headersList.push({ authorization: `Bearer ${p.apiKey}` });
  if (p.formats.includes("anthropic"))
    headersList.push({ "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" });
  if (!headersList.length) headersList.push({ authorization: `Bearer ${p.apiKey}` });

  for (const h of headersList) {
    const ids = await tryFetch(h);
    if (ids && ids.length) return ids;
  }
  return [];
}

export function adminApi(store: Store, auth: MiddlewareHandler): Hono {
  const app = new Hono();
  app.use("*", auth);

  // --- account ---
  app.get("/account", (c) => {
    const a = store.get().account;
    return c.json({ username: a.username, password: a.password });
  });

  // --- providers ---
  app.get("/providers", (c) => c.json({ providers: store.get().providers.map(toPublic) }));

  app.post("/providers", async (c) => {
    const body = await readJson<{ name?: string; baseUrl?: string; apiKey?: string; formats?: Format[] }>(c.req.raw);
    if (!body?.name || !body?.baseUrl || !body?.apiKey || !body?.formats?.length) {
      return c.json({ error: { message: "name, baseUrl, apiKey, formats are required" } }, 400);
    }
    const cfg = await store.update((d) => {
      d.providers.push({
        id: newProviderId(),
        name: body.name!,
        baseUrl: trimBase(body.baseUrl!),
        apiKey: body.apiKey!,
        formats: body.formats!,
        createdAt: Date.now(),
      });
    });
    const created = cfg.providers[cfg.providers.length - 1];
    return c.json({ provider: toPublic(created) }, 201);
  });

  app.delete("/providers/:id", async (c) => {
    const id = c.req.param("id");
    let found = false;
    await store.update((d) => {
      found = d.providers.some((p) => p.id === id);
      d.providers = d.providers.filter((p) => p.id !== id);
      for (const m of Object.values(d.models)) m.providers = m.providers.filter((pid) => pid !== id);
    });
    if (!found) return c.json({ error: { message: "provider not found" } }, 404);
    return c.json({ ok: true });
  });

  app.post("/providers/:id/discover", async (c) => {
    const p = store.get().providers.find((x) => x.id === c.req.param("id"));
    if (!p) return c.json({ error: { message: "provider not found" } }, 404);
    try {
      const models = await discoverModels(p);
      return c.json({ models });
    } catch (e) {
      return c.json({ error: { message: `discovery failed: ${(e as Error).message}`, models: [] } }, 502);
    }
  });

  // --- models ---
  app.get("/models", (c) => {
    const d = store.get();
    const byId = new Map(d.providers.map((p) => [p.id, p]));
    const models = Object.entries(d.models).map(([name, e]) => ({
      name,
      enabled: e.enabled,
      providers: e.providers.map((pid) => ({ id: pid, name: byId.get(pid)?.name ?? "?" })),
    }));
    return c.json({ models });
  });

  app.post("/models", async (c) => {
    const body = await readJson<{ name?: string; providerId?: string }>(c.req.raw);
    if (!body?.name) return c.json({ error: { message: "name is required" } }, 400);
    const name = body.name;
    const cfg = store.get();
    if (body.providerId && !cfg.providers.some((p) => p.id === body.providerId)) {
      return c.json({ error: { message: "provider not found" } }, 400);
    }
    await store.update((d) => {
      const existing = d.models[name];
      d.models[name] = {
        enabled: true,
        providers: existing?.providers ?? (body.providerId ? [body.providerId] : []),
      };
    });
    return c.json({ ok: true }, 201);
  });

  app.post("/models/:name/providers", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ providerId?: string }>(c.req.raw);
    if (!body?.providerId) return c.json({ error: { message: "providerId is required" } }, 400);
    let errStatus = 0;
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        return;
      }
      if (!d.providers.some((p) => p.id === body.providerId)) {
        errStatus = 400;
        return;
      }
      if (!entry.providers.includes(body.providerId!)) entry.providers.push(body.providerId!);
    });
    if (errStatus === 404) return c.json({ error: { message: "model not found; enable it first" } }, 404);
    if (errStatus === 400) return c.json({ error: { message: "provider not found" } }, 400);
    return c.json({ ok: true });
  });

  app.delete("/models/:name/providers/:providerId", async (c) => {
    const name = c.req.param("name");
    const pid = c.req.param("providerId");
    await store.update((d) => {
      const entry = d.models[name];
      if (entry) entry.providers = entry.providers.filter((x) => x !== pid);
    });
    return c.json({ ok: true });
  });

  app.put("/models/:name/priority", async (c) => {
    const name = c.req.param("name");
    const body = await readJson<{ providers?: string[] }>(c.req.raw);
    if (!Array.isArray(body?.providers)) return c.json({ error: { message: "providers[] required" } }, 400);
    let errStatus = 0;
    await store.update((d) => {
      const entry = d.models[name];
      if (!entry) {
        errStatus = 404;
        return;
      }
      entry.providers = body.providers!;
    });
    if (errStatus === 404) return c.json({ error: { message: "model not found" } }, 404);
    return c.json({ ok: true });
  });

  app.post("/models/:name/disable", async (c) => {
    const name = c.req.param("name");
    await store.update((d) => {
      if (d.models[name]) d.models[name].enabled = false;
    });
    return c.json({ ok: true });
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
