import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "src",
    restoreMocks: true,
    include: ["__tests__/validation/**/*.test.ts"],
  },
});
