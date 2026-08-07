import { defineConfig } from "vitest/config";

/**
 * Core (Node) + web test suite. The default environment is Node; web tests that
 * touch `localStorage`/`document` opt into jsdom with a leading
 * `// @vitest-environment jsdom` line. Vitest resolves the extensionless `.ts`
 * source imports via its own (vite) resolver, so no compile step is needed — the
 * same property that lets `tsx serve` run the gateway directly.
 *
 * E2E tests live under ./e2e and run under Playwright (see playwright.config.ts),
 * NOT here, so the two runners never collide.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/core/test/**/*.test.ts", "packages/web/test/**/*.test.ts"],
    // No globals: every test explicitly imports describe/it/expect/vi. Matches
    // the codebase's explicit-import style and avoids a tsconfig "types" dance.
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/core/src/**/*.ts", "packages/web/src/**/*.ts"],
      exclude: [
        "packages/web/src/components/ui/**", // vendored shadcn-vue primitives
        "packages/web/src/main.ts", // bootstrap only
        "packages/web/src/env.d.ts",
      ],
    },
  },
});
