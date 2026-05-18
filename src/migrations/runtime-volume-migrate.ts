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
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
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

  // DX-683 Phase 3b — split settings.json into contract (in-repo) +
  // drift (runtime volume). Partitions display/meta out of the
  // pre-split single-file shape; idempotent across boots.
  migrateSettingsSplit(repoName, repoLocalPath, result);

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

/**
 * DX-683 Phase 3b — settings.json contract/drift split.
 *
 * Pre-split: `<repo>/.danxbot/settings.json` carries every field
 * (overrides + display + agents + ... + meta).
 * Post-split: contract fields stay; `display` moves to the drift file
 * at `<runtime-volume>/<repo>/settings-runtime.json`. Per-file meta
 * blocks track each file's last writer.
 *
 * Decision tree (per repo, per boot):
 *
 *   - in-repo settings.json absent → no-op (fresh install; the worker's
 *     `syncSettingsFileOnBoot` will create the right shape on next boot).
 *   - in-repo file present, NO `display` field → already canonical (post-
 *     split shape OR pre-split that never received a display stamp); no-op.
 *   - in-repo file present, `display` present, drift file present →
 *     already migrated, but in-repo still carries display residue (a
 *     prior boot ran with the old code AFTER the drift file landed).
 *     Rewrite the in-repo file without `display`; leave the drift file
 *     alone (operator may have edited it). Idempotent on subsequent runs.
 *   - in-repo file present, `display` present, drift file absent →
 *     PARTITION. Write the drift file with `{display, meta}` from the
 *     in-repo blob, then rewrite the in-repo file without `display`.
 *
 * Atomicity: per-file tmp+rename for each rewrite. A crash mid-rename
 * leaves the file at exactly one location, never partial. The drift
 * file is written FIRST so a crash between the two writes leaves the
 * data preserved in BOTH locations — the next boot sees both-present
 * branch and tidies the in-repo residue.
 */
export function migrateSettingsSplit(
  repoName: string,
  repoLocalPath: string,
  result: MigrationResult,
): void {
  const inRepoPath = resolve(repoLocalPath, ".danxbot", "settings.json");
  const driftPath = runtimeVolumePath(repoName, "settings-runtime.json");
  const label = "settings.json";

  if (!existsSync(inRepoPath)) {
    result.skipped.push(label);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(inRepoPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    // Corrupt in-repo file — leave it alone for the operator to fix.
    // Worker's `readSettings` already fail-softs to defaults; the
    // migration's job is only to partition, not to repair.
    log.warn(
      `[${label}] in-repo settings.json failed to parse — skipping split migration. Reason:`,
      err,
    );
    result.skipped.push(label);
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, "display")) {
    // Already canonical — no display field in the contract file.
    result.skipped.push(label);
    return;
  }

  const display = parsed.display;
  // Use the in-repo file's existing meta as the seed for the drift file's
  // own meta — that meta represents the last writer of the combined file,
  // which was very likely a worker `syncSettingsFileOnBoot` (display
  // updates). Preserves the operator-visible "last updated" surface.
  const meta = parsed.meta;

  const driftPresent = existsSync(driftPath);

  if (!driftPresent) {
    // Atomic write of the drift file FIRST, then rewrite the in-repo
    // file without `display`. A crash between the two leaves data
    // preserved in both locations; next boot tidies the residue.
    mkdirSync(dirname(driftPath), { recursive: true });
    const driftShape: Record<string, unknown> = { display };
    if (meta !== undefined) driftShape.meta = meta;
    writeJsonAtomic(driftPath, driftShape);
  }

  // Rewrite in-repo file without `display`. Idempotent regardless of
  // whether the drift file was just written or already existed.
  const { display: _stripped, ...rest } = parsed;
  void _stripped;
  writeJsonAtomic(inRepoPath, rest);

  if (driftPresent) {
    result.alreadyMigrated.push(label);
  } else {
    result.moved.push(label);
  }
}

/**
 * Atomic JSON write: tmp + rename. Trailing newline matches
 * `writeSettings` (consumed-repo JSON convention).
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const body = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}
