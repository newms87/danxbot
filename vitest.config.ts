import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    // DX-310: pin worker pool to `forks` + cap fork count so the five
    // subprocess-spawning test files (list-target-repos.test.ts,
    // api-error-recover.test.ts, danxbot-mcp-server.test.ts,
    // capture-server-cli.test.ts, mcp-server-probe.test.ts) don't race
    // each other for CPU under
    // the default 22-way (`availableParallelism()`) parallelism. With
    // the default `threads` pool, every worker shares the V8 event
    // loop of its host vitest process, and spawned `npx tsx` children
    // inside tests fight workers' microtasks — `it()` bodies (and
    // hardcoded 5-15s inner timeouts inside `sendMessage` /
    // `waitForRequest`) miss their deadlines.
    //
    // - `pool: "forks"` runs each worker in a fresh Node process so
    //   the test body's event loop is OS-isolated from sibling
    //   workers. Cold-start cost is ~200ms higher per worker than
    //   threads but the suite stops thrashing on CPU contention.
    // - `maxWorkers: 4` (vitest 4's renamed-from-`poolOptions.forks.maxForks`
    //   knob) keeps total parallelism (workers + their spawned tsx
    //   children) under the 22-cpu ceiling on this host. Default
    //   `availableParallelism()`-many workers reintroduces the flake.
    //   Reviewers bumping this back up should re-verify three
    //   consecutive full runs on a 16+ cpu host.
    //
    // Pair with the `sendMessage` / `waitForRequest` inner-timeout
    // bumps in `src/__tests__/unit/danxbot-mcp-server.test.ts` and
    // `src/__tests__/integration/api-error-recover.test.ts` — those
    // hardcoded 5s/15s deadlines are inside the test bodies, not the
    // vitest-level testTimeout, so the config alone cannot rescue
    // them under contention.
    // - `testTimeout: 15_000` (up from vitest's 5_000) absorbs
    //   cold-spawn `npx tsx <script>` handshake latency (~1-3s warm,
    //   higher under load) in the list-target-repos suite where the
    //   failure mode was "it() body never starts".
    // - `hookTimeout: 15_000` (up from vitest's 10_000) lets
    //   `beforeEach` chains that boot MCP servers + capture servers
    //   settle under contention.
    //
    // Removing this cap reintroduces the DX-310 flake. Reviewers
    // bumping `maxForks` back up should run the full suite three
    // times on a 16+ cpu host before merging.
    pool: "forks",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    maxWorkers: 4,
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
