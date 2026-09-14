import { defineConfig } from "vitest/config";

// src/index.test.ts が実機の workerd（gateway と data-api の2つ）を起動するので、既定の 5s では起動だけで足りない（data-api と同じ）。
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
