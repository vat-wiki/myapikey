import { defineConfig } from "vitest/config";

/**
 * Gateway (Node) + web test suite. The default environment is Node; web tests that
 * touch `localStorage`/`document` opt into jsdom with a leading
 * `// @vitest-environment jsdom` line. Vitest resolves the extensionless `.ts`
 * source imports via its own (vite) resolver, so no compile step is needed — the
 * same property that lets `tsx serve` run the gateway directly.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/web/test/**/*.test.ts"],
    // No globals: every test explicitly imports describe/it/expect/vi. Matches
    // the codebase's explicit-import style and avoids a tsconfig "types" dance.
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/server/**/*.ts", "src/shared/**/*.ts", "src/web/src/**/*.ts"],
      exclude: [
        "src/web/src/components/ui/**", // vendored shadcn-vue primitives
        "src/web/src/main.ts", // bootstrap only
        "src/web/src/env.d.ts",
      ],
    },
  },
});
