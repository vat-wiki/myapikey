import { resolveCreds, resolveUrl } from "./config";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Ctx {
  url: string;
  auth: string; // Basic header value
}

interface Opts {
  url?: string;
  user?: string;
  pass?: string;
}

/** Build a request context from flags → env → saved profile. */
export function makeCtx(opts: Opts = {}): Ctx {
  const url = resolveUrl(opts.url).replace(/\/+$/, "");
  const creds = resolveCreds(opts.user, opts.pass);
  if (!creds) {
    throw new Error(
      "No credentials found. Run `mygate serve` first, or set MYGATE_USER/MYGATE_PASS, or pass --user/--pass.",
    );
  }
  const auth = "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  return { url, auth };
}

export async function api<T = unknown>(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ctx.url}${path}`, {
    method,
    headers: {
      authorization: ctx.auth,
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
