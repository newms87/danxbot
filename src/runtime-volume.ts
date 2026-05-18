/**
 * DX-682 — worker-owned runtime volume root.
 *
 * Worker bookkeeping files (CRITICAL_FAILURE, sync-root-state.json,
 * future settings-runtime.json) live under this volume root rather
 * than `<repo>/.danxbot/`, so the consumed repo's `.danxbot/` stays
 * contract-only: clean `git status` after every dispatch cycle, no
 * accidental commits of worker drift, no operator confusion over
 * what's "the contract" vs "what the worker wrote".
 *
 * Root resolution order:
 *   1. `DANX_RUNTIME_ROOT` env override — tests + operator-specified
 *      relocations.
 *   2. Docker runtime (`!config.isHost`): `/var/lib/danxbot` — backed
 *      by the named volume `danxbot-runtime-<repo>` declared in each
 *      per-repo `<repo>/.danxbot/config/compose.yml`.
 *   3. Host runtime (`config.isHost`): `${XDG_DATA_HOME:-$HOME/.local/share}/danxbot`
 *      — user-writable, no sudo needed.
 *
 * Per-repo layout: `<root>/<repoName>/<file>`. The worker boot path
 * calls `ensureRepoRuntimeDir(repoName)` once per managed repo so
 * readers + writers can resolve paths without per-call mkdir
 * round-trips.
 *
 * Boot-time migration of pre-existing in-repo state lives in
 * `src/migrations/runtime-volume-migrate.ts`; readers + writers in
 * this codebase route through `runtimeVolumePath(repoName, ...)` so
 * the migration is the ONLY thing that knows the old in-repo path.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Resolve the volume root, honoring the `DANX_RUNTIME_ROOT` override.
 * The override is read on every call (NOT memoized) so tests can flip
 * it between cases via `process.env.DANX_RUNTIME_ROOT = tmpDir`
 * without restarting the process. The docker / host branches are
 * decided by `config.isHost`, which is itself memoized at module
 * load via `/.dockerenv` presence.
 */
export function runtimeVolumeRoot(): string {
  const override = process.env.DANX_RUNTIME_ROOT;
  if (override) return override;
  if (!config.isHost) return "/var/lib/danxbot";
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "danxbot");
  return join(homedir(), ".local", "share", "danxbot");
}

export function repoRuntimeDir(repoName: string): string {
  return join(runtimeVolumeRoot(), repoName);
}

export function runtimeVolumePath(
  repoName: string,
  ...segments: string[]
): string {
  return join(repoRuntimeDir(repoName), ...segments);
}

/**
 * Ensure the per-repo runtime dir exists. Called once per managed
 * repo at worker boot before any reader / writer resolves a path.
 * `recursive: true` makes it safe to call concurrently from multiple
 * worker init paths.
 */
export function ensureRepoRuntimeDir(repoName: string): void {
  mkdirSync(repoRuntimeDir(repoName), { recursive: true });
}
