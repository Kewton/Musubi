import { defineConfig } from "vitest/config";

// src/index.test.ts が実機の workerd を起動するので、既定の 5s では起動だけで足りない（app-do と同じ）。
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
