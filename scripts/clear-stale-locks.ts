#!/usr/bin/env -S tsx
/**
 * Operator command — DX-241 emergency cleanup. Walks every YAML in
 * `<repo>/.danxbot/issues/{open,closed}/` and edits any tracker
 * comment that carries the dispatch-lock marker into a "released"
 * form so the next poller tick reclaims it without waiting the 2h
 * TTL.
 *
 * Triggered manually via `make clear-stale-locks REPO=<n>`. NOT part
 * of the normal dispatch flow — the worker's normal release path
 * (dispatch onComplete + shutdown via `job.stop`) handles every
 * dispatch that exits cleanly. This script is the recovery hatch for
 * locks that pre-date DX-241, locks orphaned by an unclean exit
 * before the release path landed, or locks that survived a runtime
 * swap (docker→host) that confused the self-reclaim heuristic.
 *
 * Usage:
 *   make clear-stale-locks REPO=danxbot                         # apply
 *   DRY_RUN=1 make clear-stale-locks REPO=danxbot               # preview
 *   make clear-stale-locks REPO=danxbot DRY_RUN=1               # preview (alt)
 *   AGE_HOURS=4 make clear-stale-locks REPO=danxbot             # only locks ≥ 4h old
 *
 * The script reads the repo's tracker config the same way the
 * worker does (via `loadRepoContext` + `createIssueTracker`), so
 * `tracker: memory` repos run a no-op (memory tracker has no
 * persistent state outside the worker process) and Trello-backed
 * repos hit the real API. Failures on a single card are logged but
 * never abort the run — the script is idempotent and safe to re-run.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadRepoContext } from "../src/repo-context.js";
import { createIssueTracker, parseIssue } from "../src/issue-tracker/index.js";
import {
  parseLockComment,
  renderReleasedLockComment,
  LOCK_TTL_MS,
} from "../src/issue-tracker/lock.js";
import { LOCK_COMMENT_MARKER, findCommentByMarker } from "../src/issue-tracker/markers.js";
import type { IssueTracker } from "../src/issue-tracker/interface.js";

export interface ClearStaleLocksOutcome {
  externalId: string;
  cardId: string;
  status:
    | "released"
    | "skipped-no-lock"
    | "skipped-already-released"
    | "skipped-younger-than-min"
    | "error";
  detail?: string;
}

export async function processCardForClear(args: {
  tracker: IssueTracker;
  externalId: string;
  cardId: string;
  cardTitle: string;
  now: Date;
  minAgeMs: number;
  dryRun: boolean;
}): Promise<ClearStaleLocksOutcome> {
  const { tracker, externalId, cardId, cardTitle, now, minAgeMs, dryRun } = args;
  const comments = await tracker.getComments(externalId);
  const lockComment = findCommentByMarker(comments, LOCK_COMMENT_MARKER);
  if (!lockComment) {
    return { externalId, cardId, status: "skipped-no-lock" };
  }
  const parsed = parseLockComment(lockComment.text, lockComment.id);
  if (!parsed) {
    // Unparseable. The next acquire's existing legacy-corruption path
    // would overwrite it — leave it for that flow rather than stomping
    // here so the next acquire's audit trail is the single source.
    return {
      externalId,
      cardId,
      status: "error",
      detail: "lock comment unparseable (will be overwritten by next acquire)",
    };
  }
  if (parsed.releasedAt !== "") {
    return { externalId, cardId, status: "skipped-already-released" };
  }
  if (minAgeMs > 0) {
    const ageMs = now.getTime() - new Date(parsed.startedAt).getTime();
    if (ageMs < minAgeMs) {
      return {
        externalId,
        cardId,
        status: "skipped-younger-than-min",
        detail: `lock age ${Math.round(ageMs / 60000)}m < min ${Math.round(minAgeMs / 60000)}m`,
      };
    }
  }
  const releasedText = renderReleasedLockComment(parsed, now.toISOString());
  if (!dryRun) {
    await tracker.editComment(externalId, lockComment.id, releasedText);
  }
  return {
    externalId,
    cardId,
    status: "released",
    detail: `${parsed.holder}@${parsed.host} dispatchId=${parsed.dispatchId} title="${cardTitle}"`,
  };
}

function listYamls(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => resolve(dir, f));
}

async function main(): Promise<void> {
  const repoName = process.env.DANXBOT_REPO_NAME;
  if (!repoName) {
    console.error("DANXBOT_REPO_NAME required (set via `make clear-stale-locks REPO=<n>`)");
    process.exit(1);
  }
  const localPath = resolve(process.cwd(), "repos", repoName);
  const ctx = loadRepoContext({ name: repoName, url: "", localPath });
  const tracker = createIssueTracker(ctx);

  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const ageHoursRaw = process.env.AGE_HOURS;
  const minAgeMs = ageHoursRaw
    ? Math.max(0, Number.parseFloat(ageHoursRaw) * 3600 * 1000)
    : 0;
  const now = new Date();

  // Both `open/` and `closed/` get scanned — a card that was Done
  // mid-dispatch may have a stray lock comment too. Closed cards are
  // rarely re-polled so this is mostly belt-and-suspenders, but the
  // cost is negligible (one getComments call per closed card).
  const openDir = resolve(ctx.localPath, ".danxbot/issues/open");
  const closedDir = resolve(ctx.localPath, ".danxbot/issues/closed");
  const yamlPaths = [...listYamls(openDir), ...listYamls(closedDir)];

  console.log(
    `[clear-stale-locks] repo=${repoName} dryRun=${dryRun} minAgeMs=${minAgeMs} cards=${yamlPaths.length} ttlMs=${LOCK_TTL_MS}`,
  );

  const outcomes: ClearStaleLocksOutcome[] = [];
  for (const path of yamlPaths) {
    let issue;
    try {
      issue = parseIssue(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`  ${path} FAILED to parse:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!issue.external_id) continue; // memory-only / pre-create draft
    try {
      const outcome = await processCardForClear({
        tracker,
        externalId: issue.external_id,
        cardId: issue.id,
        cardTitle: issue.title,
        now,
        minAgeMs,
        dryRun,
      });
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        externalId: issue.external_id,
        cardId: issue.id,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const released = outcomes.filter((o) => o.status === "released");
  const errors = outcomes.filter((o) => o.status === "error");
  const skippedAlready = outcomes.filter((o) => o.status === "skipped-already-released");
  const skippedYounger = outcomes.filter((o) => o.status === "skipped-younger-than-min");
  const skippedNoLock = outcomes.filter((o) => o.status === "skipped-no-lock");

  if (released.length > 0) {
    console.log(`\n[released ${released.length}]`);
    for (const r of released) console.log(`  ${r.cardId.padEnd(8)} ${r.detail}`);
  }
  if (skippedAlready.length > 0) {
    console.log(`\n[already-released ${skippedAlready.length}]`);
    for (const r of skippedAlready) console.log(`  ${r.cardId.padEnd(8)} skipped`);
  }
  if (skippedYounger.length > 0) {
    console.log(`\n[younger-than-AGE_HOURS ${skippedYounger.length}]`);
    for (const r of skippedYounger) console.log(`  ${r.cardId.padEnd(8)} ${r.detail}`);
  }
  if (errors.length > 0) {
    console.log(`\n[errors ${errors.length}]`);
    for (const r of errors) console.log(`  ${r.cardId.padEnd(8)} ${r.detail}`);
  }
  console.log(
    `\ndone — released=${released.length} already=${skippedAlready.length} younger=${skippedYounger.length} no-lock=${skippedNoLock.length} errors=${errors.length}${dryRun ? " (DRY RUN — no edits applied)" : ""}`,
  );
}

// Only run main() when invoked as the CLI entrypoint. `import.meta.url
// === file://${process.argv[1]}` works for direct `tsx scripts/...`
// invocation; the explicit VITEST env-var guard prevents vitest workers
// from accidentally executing main() during test discovery, which would
// throw `Per-repo .env not found` and fail the file load before any
// test runs.
if (
  !process.env.VITEST &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
