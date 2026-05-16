/**
 * `cleanupWorktreeArtifacts` — symmetric inverse of
 * `provisionWorktreeArtifacts` in `worktree-manager.ts`.
 *
 * Drops per-worktree Postgres DB + role (Laravel-pgsql consumer repos),
 * frees the port-registry offset, removes the persisted DB password
 * secret, and rms the worktree directory. Every step is idempotent
 * and FAIL-SOFT — a failure in one step logs + records the error on
 * the result but never throws, so the caller (bootstrap rollback,
 * teardown) gets a single boolean per artifact and a never-throws
 * contract.
 *
 * Git-side cleanup (`git worktree remove --force` + branch deletion)
 * stays in `WorktreeManager.teardown` since it depends on the manager's
 * git runner abstraction. This helper covers the non-git artifacts that
 * provisionWorktreeArtifacts creates.
 */

import { existsSync, rmSync } from "node:fs";
import { createLogger } from "../logger.js";
import {
  defaultPgClientFactory,
  defaultSecretStore,
  dropWorktreeDatabase,
  type PgClientFactory,
  type WorktreeSecretStore,
} from "./worktree-database.js";
import { releaseWorktreePorts } from "./worktree-ports.js";

const log = createLogger("worktree-cleanup");

export interface CleanupDeps {
  pgClientFactory?: PgClientFactory;
  secretStore?: WorktreeSecretStore;
  /** Host-mode operator override — same shape as provision side. */
  pgHostOverride?: string;
  pgPortOverride?: number;
}

export interface CleanupResult {
  databaseDropped: boolean;
  roleDropped: boolean;
  databaseError?: string;
  portsReleased: boolean;
  portsError?: string;
  secretRemoved: boolean;
  secretError?: string;
  worktreeRemoved: boolean;
  worktreeError?: string;
}

export async function cleanupWorktreeArtifacts(
  repoRoot: string,
  worktreePath: string,
  worktreeName: string,
  deps: CleanupDeps = {},
): Promise<CleanupResult> {
  const result: CleanupResult = {
    databaseDropped: false,
    roleDropped: false,
    portsReleased: false,
    secretRemoved: false,
    worktreeRemoved: false,
  };

  const pgHostOverride =
    deps.pgHostOverride ?? process.env.DANXBOT_PLATFORM_DB_HOST ?? undefined;
  const pgPortOverride =
    deps.pgPortOverride ??
    (process.env.DANXBOT_PLATFORM_DB_PORT
      ? Number(process.env.DANXBOT_PLATFORM_DB_PORT)
      : undefined);

  const secretStore = deps.secretStore ?? defaultSecretStore;

  // 1) DB drop — also handles its own secret-file removal AFTER the
  //    DDL succeeds. If the DB step throws (network, auth, missing
  //    parent .env), we fall through to the explicit secret remove
  //    below to keep the post-condition consistent.
  try {
    const drop = await dropWorktreeDatabase({
      repoRoot,
      worktreeName,
      pgClientFactory: deps.pgClientFactory ?? defaultPgClientFactory,
      secretStore,
      pgHostOverride,
      pgPortOverride,
    });
    if (drop.kind === "dropped") {
      result.databaseDropped = drop.dropped.database;
      result.roleDropped = drop.dropped.role;
      // dropWorktreeDatabase already called secretStore.remove on
      // success. Mark explicitly so callers don't double-remove.
      result.secretRemoved = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.databaseError = msg;
    log.warn(
      `cleanupWorktreeArtifacts(${worktreeName}): DB drop failed — continuing: ${msg}`,
    );
  }

  // 2) Defensive secret remove — covers the case where dropWorktreeDatabase
  //    threw before reaching its own remove call.
  if (!result.secretRemoved) {
    try {
      secretStore.remove(repoRoot, worktreeName);
      result.secretRemoved = true;
    } catch (err) {
      result.secretError = err instanceof Error ? err.message : String(err);
      log.warn(
        `cleanupWorktreeArtifacts(${worktreeName}): secret remove failed: ${result.secretError}`,
      );
    }
  }

  // 3) Port-registry release.
  try {
    result.portsReleased = releaseWorktreePorts(repoRoot, worktreeName);
  } catch (err) {
    result.portsError = err instanceof Error ? err.message : String(err);
    log.warn(
      `cleanupWorktreeArtifacts(${worktreeName}): port release failed: ${result.portsError}`,
    );
  }

  // 4) Worktree directory removal (defense-in-depth — git worktree
  //    remove --force from teardown should have done this already, but
  //    bootstrap-rollback may call cleanup when the worktree dir was
  //    created via mkdirSync alone without ever being a real git
  //    worktree).
  try {
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
      result.worktreeRemoved = true;
    }
  } catch (err) {
    result.worktreeError = err instanceof Error ? err.message : String(err);
    log.warn(
      `cleanupWorktreeArtifacts(${worktreeName}): worktree dir rm failed: ${result.worktreeError}`,
    );
  }

  log.info(
    `cleanupWorktreeArtifacts(${worktreeName}): ` +
      `db=${result.databaseDropped} role=${result.roleDropped} ports=${result.portsReleased} ` +
      `secret=${result.secretRemoved} worktree=${result.worktreeRemoved}`,
  );

  return result;
}
