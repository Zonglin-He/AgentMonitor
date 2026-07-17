import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      TZ: "UTC",
    },
    // API integration files share PostgreSQL and can contend under parallel
    // workers. Keep a finite budget while avoiding false 5-second timeouts on
    // otherwise 1-2 second database-heavy tests during full-suite load.
    testTimeout: 20_000,
    setupFiles: ["./src/__tests__/env-stub.ts", "./src/__tests__/setup.ts"],
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
    benchmark: {
      include: ["src/**/__benches__/**/*.bench.ts"],
      includeSamples: true,
      reporters: ["default", "./scripts/bench-p90-reporter.ts"],
    },
  },
});
