/**
 * Shared low-level persist helper for the reconcile tracker push paths.
 *
 * Lives in its own module so both `pushTrelloDiff` (the reconcile step 7
 * push) and `retry-queue.ts`'s timer callback can import without a
 * circular dependency: `trello.ts` imports `enqueueRetry` from
 * `retry-queue.ts`, and `retry-queue.ts` would otherwise need
 * `persistIfDifferent` from `trello.ts` to land tracker-side mutations
 * after a successful retry.
 *
 * The helper writes `updatedLocal` back to disk only if the serialized
 * bytes differ from the current on-disk content. Idempotent: same bytes
 * back → zero filesystem writes. Locates the file in `open/` first,
 * then `closed/` (the bucket is set by reconcile step 5 before step 7
 * runs).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { issuePath } from "../../issue-tracker/paths.js";
import { serializeIssue } from "../../issue-tracker/yaml.js";
import type { Issue } from "../../issue-tracker/interface.js";
import type { Logger } from "../../logger.js";

export function persistIfDifferent(
  repoLocalPath: string,
  id: string,
  updatedLocal: Issue,
  logger: Logger,
): void {
  const openPath = issuePath(repoLocalPath, id, "open");
  const closedPath = issuePath(repoLocalPath, id, "closed");
  const path = existsSync(openPath)
    ? openPath
    : existsSync(closedPath)
      ? closedPath
      : null;
  if (path === null) {
    logger.warn(
      `persistIfDifferent: no YAML on disk for ${id} — tracker-side mutation lost`,
    );
    return;
  }
  const newBytes = serializeIssue(updatedLocal);
  let oldBytes: string;
  try {
    oldBytes = readFileSync(path, "utf-8");
  } catch (err) {
    logger.warn(
      `persistIfDifferent: read failed for ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    writeFileSync(path, newBytes);
    return;
  }
  if (newBytes === oldBytes) return;
  writeFileSync(path, newBytes);
}
