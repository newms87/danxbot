/**
 * Worker-boot stale-/tmp-dir sweep — DX-44.
 *
 * Safety net for the leak class that no in-process cleanup hook can ever
 * cover: when the worker dies WITHOUT running its shutdown handler
 * (SIGKILL, OOM, host crash, process killed by the operator with -9),
 * every `/tmp/danxbot-{mcp,term,prompt}-*` dir that a live dispatch had
 * allocated stays behind. The per-spawn `_cleanup` paths (DX-44 main
 * fix) already handle every graceful-termination path; this module
 * sweeps the residue from the un-graceful ones.
 *
 * Contract:
 *   - Prefix-scoped to the three known per-spawn producers
 *     (`STALE_TMP_PREFIXES`). Workspace-mcp + workspace-settings dirs
 *     are out of scope: those are cleaned synchronously inside
 *     `dispatch()` (workspace-mcp) and `_cleanup` (workspace-settings).
 *   - Age-gated. The default threshold callers pass in is roughly 2 ×
 *     the longest single-dispatch timeout — anything older than that
 *     is provably not a live dispatch's working dir.
 *   - Best-effort per-dir. A single `rm` failure (EACCES on a host
 *     where the worker user lost access) is logged + counted but does
 *     NOT abort the sweep — the remaining dirs still get reaped.
 *   - Pure-helper friendly. Callers may inject a custom `rm` for
 *     tests; the production caller uses `node:fs.rmSync` directly.
 *
 * NOT thread-safe across multiple workers sharing one tmpdir — if two
 * workers boot at the same instant on the same host, they may both
 * decide to reap the same stale dir. `rm` with `force: true` makes the
 * second one a no-op, so the worst case is a duplicated log line. No
 * production setup runs two workers per repo on one host, so this is
 * theoretical.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("tmp-dir-sweep");

/**
 * Per-dispatch `mkdtemp` prefixes the sweep is allowed to reap. Keep
 * in lockstep with the producers:
 *   - `danxbot-mcp-*`                 — `src/dispatch/core.ts#writeMcpSettingsFile`
 *   - `danxbot-term-*`                — `src/agent/spawn-host-mode.ts`
 *   - `danxbot-prompt-*`              — `src/agent/claude-invocation.ts#buildClaudeInvocation`
 *   - `danxbot-workspace-settings-*`  — `src/workspace/resolve.ts#writeSubstitutedSettings`
 *   - `danxbot-workspace-mcp-*`       — `src/workspace/resolve.ts#writeMcpSettings`
 *
 * Workspace-settings + workspace-mcp dirs have their own graceful-
 * termination cleanup paths (`_cleanup`'s finally block for
 * workspace-settings; `dispatch()` body for workspace-mcp), so the
 * sweep is purely defensive for those — it only matters when a
 * SIGKILL / OOM / crash skipped the graceful path. Including them
 * here is harmless (graceful paths still own the cleanup) and closes
 * the symmetric leak class.
 *
 * Adding a new per-spawn prefix MUST update this list AND the
 * corresponding `_cleanup` wiring (`agent-cleanup.ts`).
 */
export const STALE_TMP_PREFIXES = [
  "danxbot-mcp",
  "danxbot-term",
  "danxbot-prompt",
  "danxbot-workspace-settings",
  "danxbot-workspace-mcp",
] as const;

export interface SweepStaleTmpDirsOptions {
  /** Root dir to walk (defaults to `os.tmpdir()` in the worker call site). */
  tmpRoot: string;
  /** Dirs older than this many milliseconds are removed. */
  maxAgeMs: number;
  /** Optional `rm` override for tests. */
  rm?: (path: string) => void;
}

export interface SweepResult {
  removed: string[];
  errors: Array<{ path: string; error: Error }>;
}

/**
 * Walk `tmpRoot` once, remove every direct entry whose name starts with
 * one of `STALE_TMP_PREFIXES` AND whose mtime is older than `maxAgeMs`.
 * Returns a summary the caller can log; never throws.
 */
export async function sweepStaleTmpDirs(
  options: SweepStaleTmpDirsOptions,
): Promise<SweepResult> {
  const { tmpRoot, maxAgeMs } = options;
  const rm =
    options.rm ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  const removed: string[] = [];
  const errors: SweepResult["errors"] = [];

  if (!existsSync(tmpRoot)) {
    return { removed, errors };
  }

  let entries: string[];
  try {
    entries = readdirSync(tmpRoot);
  } catch (err) {
    log.warn(
      `sweepStaleTmpDirs: readdir ${tmpRoot} failed`,
      err instanceof Error ? err.message : String(err),
    );
    return { removed, errors };
  }

  const cutoff = Date.now() - maxAgeMs;

  for (const name of entries) {
    if (!STALE_TMP_PREFIXES.some((prefix) => name.startsWith(`${prefix}-`))) {
      continue;
    }
    const path = join(tmpRoot, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Race: dir vanished between readdir and stat. Treat as already
      // reaped, do not error.
      continue;
    }
    if (mtimeMs > cutoff) continue;

    try {
      rm(path);
      removed.push(path);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push({ path, error });
      log.warn(
        `sweepStaleTmpDirs: rm ${path} failed`,
        error.message,
      );
    }
  }

  return { removed, errors };
}
