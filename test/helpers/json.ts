/** Typed JSON body reader for tests.
 *
 *  `await res.json()` is typed `Promise<unknown>`, which forces a cast at every
 *  property access and trips TS2571/TS18046 across the suite. This helper
 *  centralizes the cast so a test declares the expected shape up front:
 *
 *    const body = await json<{ apiKey: string }>(res);
 *
 *  It accepts either a `Response` or a `Promise<Response>` so the common
 *  `(await (await app.request(...)).json())` shape collapses to
 *  `await json<T>(app.request(...))`. Runtime is identical to `await res.json()`. */
export async function json<T = unknown>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  return (await r.json()) as T;
}
