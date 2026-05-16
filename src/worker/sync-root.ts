/**
 * DX-558 — Auto-sync the operator's root clone with `origin/main`.
 *
 * Why this exists: agent worktrees push to `origin/main` and reset
 * the agent branch, but the root clone's local `main` branch never
 * advances. Drift accumulates one commit per dispatch until the
 * operator manually `git pull`s.
 *
 * Two-process bridge: the worker owns the in-memory error map (single
 * source of truth for the per-tick retry gate) and mirrors it onto
 * `<repoRoot>/.danxbot/sync-root-state.json` on every transition. The
 * dashboard chokidars that file (`src/dashboard/sync-root-watcher.ts`)
 * and re-publishes `repo-root-sync:error` / `repo-root-sync:clear`
 * onto its own eventBus → SSE. Pattern matches the
 * `<repo>/.danxbot/CRITICAL_FAILURE` flag.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger("sync-root");

export type RepoRootSyncReason = "dirty" | "rebase-conflict";

export interface RepoRootSyncError {
  /** Stable category for the banner template's branching. */
  reason: RepoRootSyncReason;
  /** Human-readable detail — operator reads this on the banner. */
  detail: string;
  /** First time this error state was observed (preserved across re-tries while error persists). */
  since: string;
  /** Most recent retry attempt time — updates every sync that lands in this state. */
  lastTriedAt: string;
}

/** Subset of a `child_process.spawn` result we care about. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Exec seam. Production binds `defaultGitExec` (spawn-based, no shell).
 * Tests inject a deterministic stub. The args array is passed verbatim
 * to git — no shell interpolation anywhere — so callsites can pass
 * paths/refs without quoting concerns.
 */
export type ExecGitFn = (args: string[], cwd: string) => Promise<ExecResult>;

const STATE_FILE_NAME = ".danxbot/sync-root-state.json";

/**
 * Single source of truth for per-repo error state on the worker.
 * Module-level Map so the cron tick + the post-dispatch hook + the
 * `/api/sync-root` route all read/write the same record.
 *
 * Mirrored to `<repoRoot>/.danxbot/sync-root-state.json` on every
 * transition for the dashboard chokidar to pick up.
 */
const errors = new Map<string, RepoRootSyncError>();

export function getRepoRootSyncError(repoName: string): RepoRootSyncError | null {
  return errors.get(repoName) ?? null;
}

export function hasRepoRootSyncError(repoName: string): boolean {
  return errors.has(repoName);
}

/** Shared guard for SSE/file payloads. Used by the dashboard watcher + the SPA composable. */
export function isRepoRootSyncError(v: unknown): v is RepoRootSyncError {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.reason === "dirty" || r.reason === "rebase-conflict") &&
    typeof r.detail === "string" &&
    typeof r.since === "string" &&
    typeof r.lastTriedAt === "string"
  );
}

/** Test-only — clears the in-memory map. State files are not cleaned (tests use temp dirs). */
export function _resetForTesting(): void {
  errors.clear();
}

export interface SyncRepoRootInput {
  repoName: string;
  repoLocalPath: string;
  /** Override exec; defaults to a spawn-based git runner. */
  exec?: ExecGitFn;
  /** Override the state-file path; defaults to `<repoLocalPath>/.danxbot/sync-root-state.json`. */
  stateFilePath?: string;
  /** Inject the clock for deterministic tests. */
  now?: () => string;
}

export type SyncRepoRootStatus = "synced" | "dirty" | "rebase-conflict";

export interface SyncRepoRootResult {
  status: SyncRepoRootStatus;
  error: RepoRootSyncError | null;
}

/**
 * Run one sync cycle against the root clone. Never throws — every
 * failure mode lands in either `dirty` or `rebase-conflict`. The
 * caller observes the state via the returned result + the in-memory
 * map; the dashboard observes via the mirrored state file.
 */
export async function syncRepoRoot(
  input: SyncRepoRootInput,
): Promise<SyncRepoRootResult> {
  const git = input.exec ?? defaultGitExec;
  const clock = input.now ?? (() => new Date().toISOString());
  const stateFile =
    input.stateFilePath ?? resolve(input.repoLocalPath, STATE_FILE_NAME);

  // Step 1 — fetch. If this fails the rest cannot run.
  const fetched = await git(["fetch", "origin", "main", "--quiet"], input.repoLocalPath);
  if (fetched.code !== 0) {
    return recordError(
      input.repoName,
      stateFile,
      clock(),
      "rebase-conflict",
      `git fetch origin main failed: ${trimErr(fetched)}`,
    );
  }

  // Step 2 — dirty probe. We use `status --porcelain` and parse
  // ourselves so untracked-inside-`.danxbot/` files (per-repo state
  // we maintain) can be ignored without disabling the whole check.
  const probed = await git(["status", "--porcelain"], input.repoLocalPath);
  if (probed.code !== 0) {
    return recordError(
      input.repoName,
      stateFile,
      clock(),
      "rebase-conflict",
      `git status failed: ${trimErr(probed)}`,
    );
  }
  const dirty = parseDirty(probed.stdout);
  if (dirty.length > 0) {
    return recordError(
      input.repoName,
      stateFile,
      clock(),
      "dirty",
      `working tree dirty: ${summarizeDirty(dirty)}`,
    );
  }

  // Step 3 — fast-forward pull. Common path: there is nothing to do
  // OR `origin/main` advanced and we ff-update. Both succeed code 0.
  const pulled = await git(["pull", "--ff-only", "origin", "main"], input.repoLocalPath);
  if (pulled.code === 0) {
    return clearError(input.repoName, stateFile);
  }

  // Step 4 — non-ff. Try a rebase (covers the rare case where the
  // root clone has a local commit not on `origin/main`).
  const rebased = await git(["rebase", "origin/main"], input.repoLocalPath);
  if (rebased.code === 0) {
    return clearError(input.repoName, stateFile);
  }

  // Step 5 — rebase produced conflicts. Abort and record. The root
  // clone is not the right place to resolve them; the next agent's
  // prep skill on its own worktree is. Abort errors are non-fatal —
  // the recorded state is the same either way (operator must clean up).
  await git(["rebase", "--abort"], input.repoLocalPath);
  return recordError(
    input.repoName,
    stateFile,
    clock(),
    "rebase-conflict",
    `rebase against origin/main produced conflicts; aborted. ${trimErr(rebased).slice(0, 240)}`,
  );
}

/**
 * Default git exec — no shell, no quoting concerns. Captures
 * stdout + stderr from the child. `code` defaults to 1 on signal /
 * spawn error so callers always see a non-zero failure.
 */
const defaultGitExec: ExecGitFn = (args, cwd) =>
  new Promise<ExecResult>((res) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => res({ code: 1, stdout, stderr: stderr || err.message }));
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });

function recordError(
  repoName: string,
  stateFile: string,
  now: string,
  reason: RepoRootSyncReason,
  detail: string,
): SyncRepoRootResult {
  const prior = errors.get(repoName);
  // Preserve `since` across same-reason retries so the banner shows
  // how long the operator has been on the hook. Reason transitions
  // (dirty → rebase-conflict) reset `since` because the underlying
  // condition changed.
  const next: RepoRootSyncError = {
    reason,
    detail,
    since: prior && prior.reason === reason ? prior.since : now,
    lastTriedAt: now,
  };
  errors.set(repoName, next);
  writeStateFile(stateFile, next);
  return { status: reason, error: next };
}

function clearError(repoName: string, stateFile: string): SyncRepoRootResult {
  if (errors.has(repoName)) {
    errors.delete(repoName);
    removeStateFile(stateFile);
  }
  return { status: "synced", error: null };
}

/**
 * Parse `git status --porcelain` output, ignoring untracked-inside-`.danxbot/`
 * paths (those are danxbot's own per-repo state — agent worktrees,
 * issues store, settings) so the dirty gate doesn't false-positive on
 * danxbot's own writes. Tracked-file modifications in `.danxbot/` DO
 * count — those represent actual edits to committed danxbot files.
 */
function parseDirty(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    // Porcelain format: two-char status, space, path. Path may include spaces.
    const status = raw.slice(0, 2);
    const path = raw.slice(3);
    if (status === "??" && path.startsWith(".danxbot/")) continue;
    out.push(`${status} ${path}`);
  }
  return out;
}

function summarizeDirty(entries: string[]): string {
  if (entries.length <= 5) return entries.join(", ");
  return `${entries.slice(0, 5).join(", ")} (+${entries.length - 5} more)`;
}

function trimErr(r: ExecResult): string {
  const text = r.stderr.trim() || r.stdout.trim();
  return text || `exit ${r.code}`;
}

function writeStateFile(path: string, err: RepoRootSyncError): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(err, null, 2), "utf8");
  } catch (e) {
    log.warn(`Failed to write sync-root state file at ${path}`, e);
  }
}

function removeStateFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (e) {
    log.warn(`Failed to remove sync-root state file at ${path}`, e);
  }
}
