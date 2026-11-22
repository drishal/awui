import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/evals/**/*.test.ts", "tests/smoke/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: "forks",
    // A fresh module registry and V8 context per file costs more than the tests: this is
    // 47 s → 31 s on an 8-core box, with the same failures. Files share a worker's
    // registry, so a new test that writes process.env or spells out a module-level
    // singleton has to undo it (or say why it needs isolation).
    isolate: false,
  },
});
