import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server environment; tests are server-side.
      "server-only": fileURLToPath(new URL("./tests/support/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
    setupFiles: ["tests/support/load-env.ts"],
    // DB-backed tests share one Postgres; keep files serial for deterministic output.
    fileParallelism: false,
    // Structured logs are printed only for failing tests.
    silent: "passed-only",
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
