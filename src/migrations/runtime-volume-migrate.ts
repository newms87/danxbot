/**
 * DX-682 — one-shot boot migration of worker bookkeeping files from
 * the consumed repo's `.danxbot/` into the worker-owned runtime
 * volume (`/var/lib/danxbot/<repo>/` in docker, `~/.local/share/danxbot/<repo>/`
 * on host, override via `DANX_RUNTIME_ROOT`).
 *
 * Scope (this commit): `CRITICAL_FAILURE` only. Subsequent phases
 * extend this module with `sync-root-state.json` + `logs/` once their
 * readers/writers route through the runtime-volume helper.
 *
 * Idempotency contract: every relocation function in this module is
 * safe to run on every worker boot. The decision tree per file:
 *
 *   - old absent + new absent → no-op (fresh install)
 *   - old absent + new present → no-op (already migrated)
 *   - old present + new absent → MOVE old → new
 *   - old present + new present → keep new, delete old (operator
 *     pre-populated the volume manually; the in-repo file is stale
 *     residue and would silently re-leak into `git status`)
 *
 * The rename is `renameSync(old, new)` to keep the move atomic — a
 * crash mid-rename leaves the file at exactly one location, never
 * partial. `mkdirSync({recursive: true})` on the target dir before
 * rename so the per-repo runtime dir is in place.
 *
 * Wired from `src/index.ts#startWorkerMode` immediately after
 * `ensurePortableRepoPath` (before any reader / writer of the
 * relocated files runs). See AC #5 on DX-682.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createLogger } from "../logger.js";
import {
  ensureRepoRuntimeDir,
  runtimeVolumePath,
} from "../runtime-volume.js";

const log = createLogger("runtime-volume-migrate");

export interface MigrationResult {
  /** Files moved from the old in-repo location to the new volume path. */
  moved: string[];
  /** Files that were already at the new path; old residue (if any) deleted. */
  alreadyMigrated: string[];
  /** Files absent from both locations — no action taken. */
  skipped: string[];
}

/**
 * Migrate `<repo>/.danxbot/CRITICAL_FAILURE` → runtime-volume path.
 *
 * Caller is the worker boot path. Returns the per-file outcome for
 * the boot log. Throws on filesystem errors other than the
 * expected absence cases (ENOENT on the source is already a NO-OP
 * before any FS verb fires).
 */
export function migrateRuntimeVolume(
  repoName: string,
  repoLocalPath: string,
): MigrationResult {
  ensureRepoRuntimeDir(repoName);

  const result: MigrationResult = {
    moved: [],
    alreadyMigrated: [],
    skipped: [],
  };

  migrateOneFile(
    "CRITICAL_FAILURE",
    resolve(repoLocalPath, ".danxbot", "CRITICAL_FAILURE"),
    runtimeVolumePath(repoName, "CRITICAL_FAILURE"),
    result,
  );

  if (result.moved.length > 0 || result.alreadyMigrated.length > 0) {
    log.info(
      `[${repoName}] Runtime-volume migration: ` +
        `moved=[${result.moved.join(",")}] ` +
        `alreadyMigrated=[${result.alreadyMigrated.join(",")}] ` +
        `skipped=[${result.skipped.join(",")}]`,
    );
  }

  return result;
}

function migrateOneFile(
  label: string,
  oldPath: string,
  newPath: string,
  result: MigrationResult,
): void {
  const oldExists = existsSync(oldPath);
  const newExists = existsSync(newPath);

  if (!oldExists && !newExists) {
    result.skipped.push(label);
    return;
  }

  if (!oldExists && newExists) {
    result.alreadyMigrated.push(label);
    return;
  }

  // oldExists is true here.
  const oldStat = statSync(oldPath);
  if (oldStat.isDirectory()) {
    // Defensive: this migration is for plain files (CRITICAL_FAILURE
    // flag JSON). A dir at the old path indicates a different
    // feature wrote there; refuse to touch to avoid data loss.
    log.warn(
      `[${label}] old path ${oldPath} is a directory — skipping migration (unexpected shape)`,
    );
    result.skipped.push(label);
    return;
  }

  mkdirSync(dirname(newPath), { recursive: true });

  if (newExists) {
    // Both present — keep new (truth source post-migration), drop
    // the in-repo residue so subsequent `git status` is clean.
    unlinkSync(oldPath);
    result.alreadyMigrated.push(label);
    return;
  }

  // oldExists && !newExists — atomic rename.
  renameSync(oldPath, newPath);
  result.moved.push(label);
}
