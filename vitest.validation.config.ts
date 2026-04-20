import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "src",
    restoreMocks: true,
    include: ["__tests__/validation/**/*.test.ts"],
    // Each validation test file has different mock requirements — isolate them
    // so fs/promises mocks in validation.test.ts don't leak into dispatch-validation.test.ts
    isolate: true,
    fileParallelism: false,
    // Auto-load .env so `ANTHROPIC_API_KEY` (and anything else in it) is
    // visible to `hasApiKey()` without requiring the caller to `source .env`
    // or `export` it into their shell.
    setupFiles: ["./__tests__/validation/load-env.ts"],
  },
});
