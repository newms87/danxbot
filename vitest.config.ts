import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    include: [
      "src/**/*.test.ts",
      "deploy/**/*.test.ts",
      "mcp-servers/**/*.test.ts",
    ],
    exclude: ["**/__tests__/validation/**", "**/node_modules/**"],
  },
});
