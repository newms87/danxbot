/**
 * DX-593 — boot-time schema migration sweep.
 *
 * Walks every connected repo's `<repo>/.danxbot/issues/{open,closed}/*.yml`
 * once at worker boot and brings every YAML on disk to `KNOWN_SCHEMA_MAX`.
 * Two file classes:
 *
 *   - `open/*.yml`: raw-parse → if `schema_version < KNOWN_SCHEMA_MAX` run
 *     `migrateForward` → re-serialize → atomic temp+rename.
 *   - `closed/*.yml`: if mtime > 48h ago, `unlink` (no parse, no migrate —
 *     the worker only needs closed YAMLs for the recent-history window).
 *     Otherwise: same migrate path as open.
 *
 * Per-file failures (broken YAML, missing `schema_version`, migration
 * registry throws) are COLLECTED into `result.failed[]` — the sweep never
 * throws on per-file failure. The caller (`src/index.ts`) owns the boot
 * decision: any non-empty `failed[]` is fatal — the worker MUST NOT serve
 * dispatches with mixed-version disk because P3 strips the validator's
 * inline tolerance branches, so a missed migration cascades into every
 * downstream reader.
 *
 * Operator escape hatch: `DANXBOT_SKIP_BOOT_MIGRATION_SWEEP=1` short-
 * circuits the sweep entirely (empty result, loud warn-level log). Use
 * exclusively as an emergency bypass — after P3, this env var amounts to
 * a self-destruct button because legacy reader branches are gone.
 *
 * Wired into `src/index.ts` AFTER repo context resolution and BEFORE
 * `startIssuesMirror` (chokidar), `startWorkerCronLoop` (poller arm), and
 * `startWorkerServer` (HTTP listener). The repo-level ordering test at
 * `src/__tests__/worker/migrate-on-boot-order.test.ts` pins that order.
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYamlText, stringify as stringifyYaml } from "yaml";
import { healV10MissingFields } from "../issue-tracker/heal-v10.js";
import { healBlockedReferences } from "../issue-tracker/migrations/v11-to-v12.js";
import { migrateForward } from "../issue-tracker/migrations/registry.js";
import { KNOWN_SCHEMA_MAX } from "../issue-tracker/schema-versions.js";
import { createLogger } from "../logger.js";

/**
 * Narrow input shape — interface-segregation. The sweep reads ONLY
 * `localPath`; widening this to the full `RepoContext` would force
 * test fixtures into an `as unknown as RepoContext` cast. Production
 * callers pass a real `RepoContext` (structurally compatible).
 */
export interface BootSweepRepo {
  localPath: string;
}

const log = createLogger("migrate-on-boot");

const CLOSED_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface BootSweepFailure {
  path: string;
  error: string;
}

export interface BootSweepResult {
  migrated: number;
  healed: number;
  unchanged: number;
  deletedClosed: number;
  failed: BootSweepFailure[];
}

export interface BootSweepOptions {
  /**
   * Wall-clock override for the closed-mtime gate. Defaults to
   * `Date.now()`. Test-only — production callers omit it.
   */
  nowMs?: number;
  /**
   * Test-only override for `process.env.DANXBOT_SKIP_BOOT_MIGRATION_SWEEP`.
   * When `"1"`, the sweep short-circuits and returns an empty result.
   */
  envSkip?: string;
}

export async function runBootMigrationSweep(
  repos: BootSweepRepo[],
  options: BootSweepOptions = {},
): Promise<BootSweepResult> {
  const skip = options.envSkip ?? process.env.DANXBOT_SKIP_BOOT_MIGRATION_SWEEP;
  if (skip === "1") {
    log.warn(
      `DANXBOT_SKIP_BOOT_MIGRATION_SWEEP=1 — boot migration sweep BYPASSED. ` +
        `The worker assumes legacy reader branches still exist; reads of ` +
        `pre-v${KNOWN_SCHEMA_MAX} YAMLs will fail once P3 strips them.`,
    );
    return { migrated: 0, healed: 0, unchanged: 0, deletedClosed: 0, failed: [] };
  }

  const result: BootSweepResult = {
    migrated: 0,
    healed: 0,
    unchanged: 0,
    deletedClosed: 0,
    failed: [],
  };
  const nowMs = options.nowMs ?? Date.now();

  for (const repo of repos) {
    const issuesDir = resolve(repo.localPath, ".danxbot", "issues");
    await sweepDir(resolve(issuesDir, "open"), "open", nowMs, result);
    await sweepDir(resolve(issuesDir, "closed"), "closed", nowMs, result);
  }
  return result;
}

async function sweepDir(
  dir: string,
  kind: "open" | "closed",
  nowMs: number,
  result: BootSweepResult,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of entries) {
    if (!name.endsWith(".yml")) continue;
    const path = join(dir, name);
    try {
      if (kind === "closed") {
        const s = await stat(path);
        if (nowMs - s.mtimeMs > CLOSED_MAX_AGE_MS) {
          await unlink(path);
          result.deletedClosed++;
          continue;
        }
      }
      await migrateOne(path, result);
    } catch (err) {
      result.failed.push({
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function migrateOne(path: string, result: BootSweepResult): Promise<void> {
  const text = await readFile(path, "utf-8");
  const raw = parseYamlText(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("YAML root is not a plain object");
  }
  const version = (raw as Record<string, unknown>).schema_version;
  if (typeof version !== "number") {
    throw new Error(
      `schema_version missing or not a number (got ${JSON.stringify(version)})`,
    );
  }
  // At-MAX path: file already on canonical version; only thing left to
  // do is heal missing required-with-default fields + remap any stale
  // `"Blocked"` references on top-level `status` or `history[].from/to`
  // (DX-700 — the v1 of the v11→v12 migration only remapped top-level
  // `status`; history entries with `to: "Blocked"` survived into v12
  // and now fail the strict-enum validator on every read). Both heals
  // are idempotent — a clean canonical file returns identical
  // references and we exit through unchanged++ without writing.
  if (version === KNOWN_SCHEMA_MAX) {
    const obj = raw as Record<string, unknown>;
    const heal = healV10MissingFields(obj);
    const blockedHealed = healBlockedReferences(heal.value);
    // Reference-equality is the no-op signal both helpers guarantee:
    // `healV10MissingFields` returns `value === obj` when `applied`
    // is empty, and `healBlockedReferences` returns its input by
    // reference when no `"Blocked"` literal needs remapping. A future
    // heal helper that clones-on-no-op would silently break the
    // unchanged++ branch — keep the no-op fast-path contract.
    if (heal.applied.length === 0 && blockedHealed === heal.value) {
      result.unchanged++;
      return;
    }
    const body = stringifyYaml(blockedHealed, { lineWidth: 0 });
    await atomicWriteYaml(path, body);
    result.healed++;
    const fieldsNote =
      heal.applied.length > 0
        ? `filled missing required field(s) [${heal.applied.join(", ")}]`
        : "";
    const blockedNote =
      blockedHealed === heal.value
        ? ""
        : "remapped stale \"Blocked\" references on status/history";
    const parts = [fieldsNote, blockedNote].filter(Boolean).join("; ");
    log.warn(`[boot-sweep] healed ${path}: ${parts}`);
    return;
  }
  // Below-MAX path: registry migrates → heal pass catches any field the
  // migration's `pickExisting` table doesn't cover (e.g. `v9-to-v10`
  // only fills the five v10-new fields). Single sink for "what counts
  // as canonical for a missing field".
  const migrated = migrateForward(raw);
  if (!isPlainObject(migrated)) {
    throw new Error("migrateForward returned a non-object value");
  }
  const heal = healV10MissingFields(migrated);
  const finalValue = heal.value;
  const body = stringifyYaml(finalValue, { lineWidth: 0 });
  await atomicWriteYaml(path, body);
  result.migrated++;
  if (heal.applied.length > 0) {
    log.warn(
      `[boot-sweep] migrated + healed ${path}: filled missing required field(s) [${heal.applied.join(", ")}] with canonical defaults`,
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function atomicWriteYaml(path: string, body: string): Promise<void> {
  // Per-pid + random-suffix temp lives in the SAME directory as the
  // destination so `rename(2)` is atomic on every supported fs. The
  // sweep runs BEFORE chokidar starts so there is no `awaitWriteFinish`
  // debounce in play — single rename is the only event downstream
  // observers will ever see for this file.
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, body, "utf-8");
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* tmp may not exist if writeFile threw — swallow */
    }
    throw err;
  }
}
