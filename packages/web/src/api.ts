const KEY = "mygate.creds";

export interface Creds {
  user: string;
  pass: string;
}

export function getCreds(): Creds | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.user && j.pass) return { user: j.user, pass: j.pass };
  } catch {
    /* ignore */
  }
  return null;
}

export function setCreds(user: string, pass: string): void {
  localStorage.setItem(KEY, JSON.stringify({ user, pass }));
}

export function clearCreds(): void {
  localStorage.removeItem(KEY);
}

/** Authed JSON request to the gateway (admin API or proxy). */
export async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const c = getCreds();
  if (!c) throw new Error("Not authenticated");
  const res = await fetch(path, {
    method,
    headers: {
      authorization: "Basic " + btoa(`${c.user}:${c.pass}`),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep as text */
  }
  if (!res.ok) {
    const msg =
      (json as { error?: { message?: string } } | null)?.error?.message ?? text ?? res.statusText;
    throw new Error(String(msg));
  }
  return json as T;
}

export interface ProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  formats: string[];
  apiKey: string;
  createdAt: number;
}

export interface ModelProvider {
  id: string;
  name: string;
}
export interface ModelView {
  name: string;
  enabled: boolean;
  providers: ModelProvider[];
}
