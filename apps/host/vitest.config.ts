import { defineConfig } from "vitest/config";

// これが無いと vitest は vite.config.ts（vite-plugin と TanStack Start）を読み込んでしまう。
// src/worker/index.test.ts が host を実際にビルドし、実機の workerd（host・gateway・data-api の3つ）を起動するので、
// 既定の 5s では足りない（gateway と同じ）。
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
  },
});
