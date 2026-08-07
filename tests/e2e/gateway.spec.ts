import { expect, test } from "@playwright/test";
import { startWorld, type World } from "./world";

// One shared topology for the whole file: the real gateway + its mock upstream
// live for the suite's lifetime (Playwright is pinned to a single worker).
let world: World;
test.beforeAll(async () => {
  world = await startWorld();
});
test.afterAll(async () => {
  await world.stop();
});

const basic = (w: World) => "Basic " + Buffer.from(`${w.account.username}:${w.account.password}`).toString("base64");
const bearer = (w: World) => `Bearer ${w.apiKey}`;
const json = (r: { json: () => Promise<unknown> }) => r.json() as Promise<Record<string, unknown>>;

test.describe("gateway end-to-end", () => {
  test("health is public (no auth)", async ({ request }) => {
    const r = await request.get(`${world.gatewayUrl}/health`);
    expect(r.ok()).toBe(true);
    expect((await json(r)).ok).toBe(true);
  });

  test("account Basic works on /admin", async ({ request }) => {
    const r = await request.get(`${world.gatewayUrl}/admin/account`, { headers: { authorization: basic(world) } });
    expect(r.status()).toBe(200);
    expect((await json(r)).username).toBe("admin");
  });

  test("the /v1 api key is REJECTED on /admin (cross-secret isolation)", async ({ request }) => {
    const r = await request.get(`${world.gatewayUrl}/admin/account`, { headers: { authorization: bearer(world) } });
    expect(r.status()).toBe(401);
  });

  test("account Basic is REJECTED on /v1 (Basic carries account creds, not the api key)", async ({ request }) => {
    const r = await request.post(`${world.gatewayUrl}/v1/chat/completions`, {
      headers: { authorization: basic(world) },
      data: { model: "ping", messages: [] },
    });
    expect(r.status()).toBe(401);
  });

  test("/v1/chat/completions forwards to the upstream and returns its body", async ({ request }) => {
    world.mock.reset();
    world.mock.set("/primary/v1/chat/completions", {
      status: 200,
      body: { id: "chatcmpl-1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "pong" } }] },
    });
    const r = await request.post(`${world.gatewayUrl}/v1/chat/completions`, {
      headers: { authorization: bearer(world) },
      data: { model: "ping", messages: [{ role: "user", content: "hi" }] },
    });
    expect(r.status()).toBe(200);
    const body = await json(r);
    expect((body.choices as Array<{ message: { content: string } }>)[0].message.content).toBe("pong");
    expect(world.mock.requests.some((m) => m.url.includes("/primary/v1/chat/completions"))).toBe(true);
  });

  test("failover: primary 503 → fallback answers (same model, next provider)", async ({ request }) => {
    world.mock.reset();
    world.mock.set("/primary/v1/chat/completions", { status: 503, body: { error: { message: "down" } } });
    world.mock.set("/fallback/v1/chat/completions", {
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "from-fallback" } }] },
    });
    const r = await request.post(`${world.gatewayUrl}/v1/chat/completions`, {
      headers: { authorization: bearer(world) },
      data: { model: "ha", messages: [{ role: "user", content: "hi" }] },
    });
    expect(r.status()).toBe(200);
    const body = await json(r);
    expect((body.choices as Array<{ message: { content: string } }>)[0].message.content).toBe("from-fallback");
    // Exactly one attempt at each provider (primary failed, fallback succeeded).
    expect(world.mock.requests.filter((m) => m.url.includes("/primary/"))).toHaveLength(1);
    expect(world.mock.requests.filter((m) => m.url.includes("/fallback/"))).toHaveLength(1);
  });

  test("/v1/models advertises only openai-enabled models", async ({ request }) => {
    world.mock.reset();
    const r = await request.get(`${world.gatewayUrl}/v1/models`, { headers: { authorization: bearer(world) } });
    expect(r.status()).toBe(200);
    const ids = ((await json(r)).data as Array<{ id: string }>).map((m) => m.id).sort();
    // ping + ha are openai-enabled; both upstream hits are mocked-no-op for GET.
    expect(ids).toEqual(["ha", "ping"]);
  });
});
