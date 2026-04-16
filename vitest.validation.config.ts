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
  },
});
