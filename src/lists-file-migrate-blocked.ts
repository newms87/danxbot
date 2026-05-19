/**
 * DX-658 / Phase 2 of "Blocked becomes a dispatch gate, not a status"
 * (parent epic DX-656).
 *
 * One-shot per-repo migration: strip any `type: "blocked"` list from
 * `<repo>/.danxbot/lists.yaml`, tombstone the id so it can never be
 * recreated, and re-save. Idempotent — re-running on a clean file is
 * a no-op (the read finds no `type: "blocked"` entries).
 *
 * Runs once per repo at worker boot, immediately AFTER `ensureListsFile`
 * has seeded the default 6-list taxonomy for fresh repos. Existing repos
 * boot with the 7-list taxonomy on disk; this pass removes the now-
 * orphan Blocked list and persists the cleaned shape.
 *
 * Reads the YAML directly (NOT via `readLists`) because `readLists` runs
 * the `isValidListShape` validator which uses the post-DX-658 `LIST_TYPES`
 * set — pre-migration files carrying `type: "blocked"` would be filtered
 * out at read time and the migration would never see them. The raw-read
 * path here keeps the legacy shape visible long enough to record its id
 * in the tombstone list.
 *
 * Failure handling: any IO / parse error logs at warn and returns. The
 * next boot retries; a corrupt `lists.yaml` already routes through
 * `readLists`'s degrade-to-seed branch elsewhere, so this migration
 * never makes the situation worse.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  backfillListColors,
  listsFilePath,
  writeLists,
  type ListsFile,
  type List,
} from "./lists-file.js";
import { createLogger } from "./logger.js";

const log = createLogger("lists-migrate-blocked");

interface RawList {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  order?: unknown;
  is_default_for_type?: unknown;
  color?: unknown;
}

interface RawListsFile {
  lists?: unknown;
  tombstone_ids?: unknown;
}

/**
 * Run the DX-658 lists.yaml migration for one repo. Returns
 * `{migrated, removedIds}` for logging — `migrated: false` covers
 * both "file not present" and "no Blocked list to remove" outcomes
 * (the read normalizes both to "nothing to do").
 */
export async function migrateListsFileForDx658(
  localPath: string,
): Promise<{ migrated: boolean; removedIds: string[] }> {
  const path = listsFilePath(localPath);
  if (!existsSync(path)) return { migrated: false, removedIds: [] };

  let raw: RawListsFile;
  try {
    raw = parseYaml(readFileSync(path, "utf-8")) as RawListsFile;
  } catch (err) {
    log.warn(`Failed to read ${path} during DX-658 migration`, err);
    return { migrated: false, removedIds: [] };
  }
  if (!raw || typeof raw !== "object") {
    return { migrated: false, removedIds: [] };
  }

  const rawLists = Array.isArray(raw.lists) ? (raw.lists as RawList[]) : [];
  const rawTombstones = Array.isArray(raw.tombstone_ids)
    ? raw.tombstone_ids.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];

  const removedIds: string[] = [];
  const kept: List[] = [];
  for (const entry of rawLists) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "blocked") {
      if (typeof entry.id === "string" && entry.id.length > 0) {
        removedIds.push(entry.id);
      }
      continue;
    }
    // Non-blocked entry — trust the existing validator at write time
    // to reject anything else malformed. Pass through verbatim.
    kept.push(entry as unknown as List);
  }

  if (removedIds.length === 0) {
    return { migrated: false, removedIds: [] };
  }

  const tombstone_ids = [
    ...rawTombstones,
    ...removedIds.filter((id) => !rawTombstones.includes(id)),
  ];
  // Backfill `color` on any pre-DX-601 entries before write-side
  // validation. `writeLists` runs the strict `isValidListShape` check,
  // which rejects entries missing `color`. The read-side `normalize()`
  // already does the same backfill — sharing the helper keeps the
  // two surfaces in agreement.
  const kept_with_colors = backfillListColors(kept) as List[];
  const next: ListsFile = { lists: kept_with_colors, tombstone_ids };

  try {
    await writeLists(localPath, next);
  } catch (err) {
    log.warn(`Failed to persist DX-658 lists.yaml migration at ${path}`, err);
    return { migrated: false, removedIds: [] };
  }

  log.info(
    `DX-658 lists.yaml migration: removed ${removedIds.length} "blocked"-type list(s) from ${path} [ids=${removedIds.join(", ")}]`,
  );
  return { migrated: true, removedIds };
}
