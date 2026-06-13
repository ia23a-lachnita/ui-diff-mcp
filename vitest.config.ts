import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "tests/live/**/*.test.ts", "tests/integration/**/*.test.ts"],
      thresholds: {
        statements: 85,
        branches: 68,
        functions: 85,
        lines: 85
      }
    }
  }
});
