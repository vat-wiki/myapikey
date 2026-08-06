import { resolveApiKey, resolveCreds, resolveUrl } from "./config";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Ctx {
  url: string;
  auth: string; // Basic header value ("" if no account creds) — for /admin
  apiKey?: string; // Bearer token for /v1
}

interface Opts {
  url?: string;
  user?: string;
  pass?: string;
  apiKey?: string;
}

/** Build a request context from flags → env → saved profile. */
export function makeCtx(opts: Opts = {}): Ctx {
  const url = resolveUrl(opts.url).replace(/\/+$/, "");
  const creds = resolveCreds(opts.user, opts.pass);
  const apiKey = resolveApiKey(opts.apiKey);
  const auth = creds ? "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64") : "";
  return { url, auth, apiKey };
}

export async function api<T = unknown>(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const isV1 = path.startsWith("/v1");
  // /v1 takes the API key (Bearer); everything else (/admin) takes account Basic.
  if (isV1 && !ctx.apiKey) {
    throw new Error("No API key for /v1. Run `myapikey serve`, set MYAPIKEY_API_KEY, or pass --api-key.");
  }
  if (!isV1 && !ctx.auth) {
    throw new Error("No account credentials for /admin. Run `myapikey serve`, set MYAPIKEY_USER/MYAPIKEY_PASS, or pass --user/--pass.");
  }
  const res = await fetch(`${ctx.url}${path}`, {
    method,
    headers: {
      authorization: isV1 ? `Bearer ${ctx.apiKey}` : ctx.auth,
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
      (json as { error?: { message?: string } } | null)?.error?.message ??
      text ??
      res.statusText;
    throw new ApiError(res.status, String(msg));
  }
  return json as T;
}
