import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    include: [
      "src/**/*.test.ts",
      "deploy/**/*.test.ts",
      "mcp-servers/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/__tests__/validation/**", "**/node_modules/**"],
    // DX-244: load <cwd>/.env so tests transitively importing
    // `src/config.ts` see DANXBOT_DB_* without the operator running
    // `set -a && source .env`. Pairs with the worktree-manager
    // `.env` symlink so dispatched agents in fresh worktrees inherit
    // the same behavior as repo-root invocations.
    setupFiles: ["./vitest.setup.ts"],
  },
});
