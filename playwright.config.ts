import { defineConfig } from "@playwright/test";

// Port the e2e gateway listens on (shared with tests/e2e/world.ts). The mock
// upstream lives on the next port up.
const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT ?? 7807);

export default defineConfig({
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    // The spec owns server lifecycle (tests/e2e/world.ts boots a real
    // `myapikey serve` + a scripted mock upstream); baseURL is just a convenience.
    baseURL: `http://localhost:${GATEWAY_PORT}`,
  },
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1, // shared gateway + mock-upstream processes
  retries: 0,
  timeout: 60000,
  reporters: [["list"]],
});
