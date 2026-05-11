/**
 * Vitest setup — load `<cwd>/.env` into `process.env` BEFORE any test
 * file runs.
 *
 * Why this exists: tests that transitively import `src/config.ts` (via
 * `src/db/connection.ts`, `src/poller/index.ts`, etc.) call
 * `required("DANXBOT_DB_USER")` at module-load time and throw
 * "Missing required environment variable" when the var isn't in
 * `process.env`. Vitest does NOT auto-load `.env`. Pre-DX-244, every
 * dispatched agent invoking `npx vitest run` from a fresh worktree had
 * to manually `set -a && source <repoRoot>/.env && set +a` before the
 * suite would boot.
 *
 * The companion fix in `src/agent/worktree-manager.ts` symlinks
 * `<worktree>/.env -> <repoRoot>/.env` at bootstrap time. With that
 * symlink + this setup file registered in `vitest.config.ts`, plain
 * `npx vitest run` from the worktree's cwd loads the env vars
 * automatically and the failing tests pass without operator preamble.
 *
 * Resolution: `<cwd>/.env`. Vitest's cwd is the directory the runner
 * is invoked from, so worktree dispatches resolve to the symlink and
 * repo-root invocations resolve to the canonical file. CI / fresh
 * clones with no `.env` get a silent no-op (the parser handles
 * missing files).
 */

import { resolve } from "node:path";
import { loadEnvFile } from "./src/__tests__/helpers/load-env-file.js";

loadEnvFile(resolve(process.cwd(), ".env"));
