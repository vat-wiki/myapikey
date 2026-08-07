import { vi, type Mock } from "vitest";

/** One recorded fetch() call, for assertions ("which upstream did we hit?"). */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** What a mocked upstream responds with. `body` may be a string or a plain
 *  object (objects are JSON.stringified); defaults give a 200 JSON response. */
export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch route. `match` accepts a call by URL substring, RegExp, or predicate.
 *  `response` is either a fixed spec or a function of (call, matchIndex) — the
 *  per-route counter makes failover scripts natural ("1st attempt → 500, 2nd → 200"). */
export interface Route {
  match: string | RegExp | ((c: RecordedCall) => boolean);
  response: MockResponseSpec | ((c: RecordedCall, matchIndex: number) => MockResponseSpec);
}

export interface FetchMock {
  /** Every recorded call, in order — across all routes. */
  calls: RecordedCall[];
  /** The real global fetch, captured at install time. */
  original: typeof fetch;
  /** Restore the real fetch. Call in afterEach. */
  restore: () => void;
}

function toResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  const body = spec.body ?? "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json", ...(spec.headers ?? {}) });
  // A real Response built from a string carries a proper ReadableStream body,
  // so the proxy's passThrough() (new Response(upstream.body, …)) flows through,
  // and .ok/.status/.headers/.text()/.clone() all behave like a live upstream.
  return new Response(text, { status, headers });
}

/**
 * Replace globalThis.fetch with a spy that dispatches to `routes` in order. The
 * first route whose `match` accepts a call wins. If NO route matches, the call
 * gets a loud 599 — an unexpected upstream hit should fail the test, not 404
 * silently. Call `restore()` in afterEach to put the real fetch back.
 */
export function mockFetch(routes: Route[]): FetchMock {
  const calls: RecordedCall[] = [];
  const counts = new Map<Route, number>();
  const original = globalThis.fetch;

  // `string | Request | URL` matches Node's global fetch input type (the DOM
  // `RequestInfo` alias isn't in scope under the ES2022-only lib).
  const spy = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw) {
      if (raw instanceof Headers) raw.forEach((v, k) => (headers[k] = v));
      else if (Array.isArray(raw)) for (const [k, v] of raw) headers[k] = String(v);
      else for (const [k, v] of Object.entries(raw)) headers[k] = String(v);
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? String(init.body) : "",
    };
    calls.push(call);
    for (const route of routes) {
      const matched =
        typeof route.match === "function"
          ? route.match(call)
          : typeof route.match === "string"
            ? call.url.includes(route.match)
            : route.match.test(call.url);
      if (!matched) continue;
      const i = counts.get(route) ?? 0;
      counts.set(route, i + 1);
      const spec = typeof route.response === "function" ? route.response(call, i) : route.response;
      return toResponse(spec);
    }
    return new Response(`no mock route matched: ${url}`, {
      status: 599,
      headers: { "content-type": "text/plain" },
    });
  }) as Mock;

  globalThis.fetch = spy as unknown as typeof fetch;
  return { calls, original, restore: () => { globalThis.fetch = original; } };
}

/** Return specs in order, then keep returning the last one. The classic failover
 *  script: `sequence([{ status: 500 }, { status: 200, body: {...} }])`. */
export function sequence(specs: MockResponseSpec[]): (c: RecordedCall, i: number) => MockResponseSpec {
  return (_c, i) => specs[Math.min(i, specs.length - 1)];
}
