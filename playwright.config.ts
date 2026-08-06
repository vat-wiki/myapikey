import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  reporters: [["list"]],
});
