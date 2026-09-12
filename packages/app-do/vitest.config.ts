import { defineConfig } from "vitest/config";

// 実機の workerd を起動するので、既定の 5s では起動だけで足りない。
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
