/**
 * DX-563 (Phase 3 of DX-560 — Self-Repair): in-worker cron job that
 * scans `system_errors` for a repair-eligible target and creates a
 * `<PREFIX>-N` card under the epic the standard picker dispatches.
 * Fires every 60s alongside the orphan reaper and SFC-deps jobs.
 *
 * # Order of operations (per tick, on a hit)
 *
 *  1. `ensureSelfRepairDisplayMirror` — idempotent mirror of
 *     `selfRepair.threshold` → `display.selfRepair` for the dashboard.
 *     Common case: a no-op file read.
 *  2. `getCandidate` — top open error for this repo whose count
 *     clears `threshold` AND has < 3 prior attempts AND no in-flight
 *     repair row. Pure SQL.
 *  3. `getPriorAttempts` — full history (any verdict) so the new
 *     card's description renders prior verdicts + report excerpts.
 *  4. `insertRepairAttempt` — INSERT a row with `card_id = null` +
 *     `ended_at = null` BEFORE the card is created. A crash mid-create
 *     leaves the row in flight; the next tick's pick query treats the
 *     error as `r2.ended_at IS NULL` (skipped). Reconciliation of the
 *     stranded row is a future Phase concern.
 *  5. `writeYaml` — render the draft via `card-factory.ts` +
 *     `createEmptyIssue` and write it to disk WITHOUT an id. The
 *     synchronous create flow (`danx_issue_create`) stamps the next
 *     `<PREFIX>-N` and renames the file.
 *  6. `danxIssueCreate` — production calls the in-process
 *     `createInProcessIssue` helper (in `src/system-repair/`) which
 *     allocates the next `<PREFIX>-N` via `nextIssueId`, stamps the
 *     draft, writes `open/<id>.yml`, and removes the draft file. The
 *     self-HTTP loop to `/api/issue-create/<id>` is intentionally
 *     skipped — the dispatcher already runs in the worker, so the
 *     round-trip is unnecessary overhead. Test overrides return
 *     `{created: true, id: "DX-900"}` without touching the FS.
 *  7. `setCard` — UPDATE the repair row's `card_id` with the assigned
 *     id once the card exists. Idempotent.
 *  8. `flipStatus` — UPDATE the `system_errors.status` to `repairing`
 *     so the next tick's pick query skips this error until the agent
 *     finalizes.
 *
 * # Why so many seams
 *
 * Every step in the chain has a real failure mode (DB query, file
 * write, worker HTTP call, status flip). The dispatcher exposes each
 * step as a typed dependency so tests can pin the orchestration order
 * without booting Postgres + a real `danxbot_worker_*` HTTP listener.
 * The integration test (`self-repair-dispatch.integration.test.ts`)
 * binds the production defaults.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../../logger.js";
import { ensureIssuesDirs, issuePath } from "../../issue-tracker/paths.js";
import { nextIssueId } from "../../issue-tracker/id-generator.js";
import {
  createEmptyIssue,
  serializeIssue,
} from "../../issue-tracker/yaml.js";
import { getPool } from "../../db/connection.js";
import {
  flipErrorStatus as defaultFlipErrorStatus,
  getDispatchCandidate as defaultGetDispatchCandidate,
  getPriorAttempts as defaultGetPriorAttempts,
  insertRepairAttempt as defaultInsertRepairAttempt,
  setRepairAttemptCard as defaultSetRepairAttemptCard,
} from "../../system-repair/dispatch-pick.js";
import { buildRepairCardDraft } from "../../system-repair/card-factory.js";
import {
  ensureSelfRepairDisplayMirror as defaultEnsureMirror,
  getSelfRepairThreshold,
} from "../../system-repair/settings.js";
import type {
  SystemErrorRepairRow,
  SystemErrorRow,
} from "../../system-repair/types.js";
import type { CronJob, CronJobContext } from "../types.js";

const log = createLogger("self-repair-dispatch");

/** Parent epic id the repair cards hang under. Matches DX-560. */
export const DEFAULT_SELF_REPAIR_EPIC = "DX-560";

export type RunSelfRepairDispatchResult =
  | { kind: "no-context" }
  | { kind: "no-candidate" }
  | { kind: "create-failed"; errors: string[] }
  | { kind: "dispatched"; attemptN: number; cardId: string; errorId: number };

export interface DanxIssueCreateResult {
  created: boolean;
  id?: string;
  errors?: string[];
}

export interface RunSelfRepairDispatchInput {
  ctx: CronJobContext | undefined;
  epicId?: string;
  readThreshold?: (repoLocalPath: string) => number;
  ensureDisplayMirror?: (repoLocalPath: string) => Promise<void>;
  getCandidate?: (args: { repo: string; threshold: number }) => Promise<SystemErrorRow | null>;
  getPrior?: (args: { errorId: number }) => Promise<SystemErrorRepairRow[]>;
  insertAttempt?: (args: { errorId: number; attemptN: number }) => Promise<SystemErrorRepairRow>;
  writeYaml?: (args: { repoRoot: string; filename: string; content: string }) => void;
  danxIssueCreate?: (args: { repoRoot: string; filename: string }) => Promise<DanxIssueCreateResult>;
  setCard?: (args: { attemptId: number; cardId: string }) => Promise<void>;
  flipStatus?: (args: { errorId: number; status: "repairing" }) => Promise<void>;
}

export async function runSelfRepairDispatch(
  input: RunSelfRepairDispatchInput,
): Promise<RunSelfRepairDispatchResult> {
  const ctx = input.ctx;
  if (!ctx) return { kind: "no-context" };

  const epicId = input.epicId ?? DEFAULT_SELF_REPAIR_EPIC;
  const readThreshold = input.readThreshold ?? getSelfRepairThreshold;
  const ensureMirror = input.ensureDisplayMirror ?? defaultEnsureMirror;
  const getCandidate = input.getCandidate ?? defaultGetCandidate;
  const getPrior = input.getPrior ?? defaultGetPrior;
  const insertAttempt = input.insertAttempt ?? defaultInsertAttempt;
  const writeYaml = input.writeYaml ?? defaultWriteYaml;
  const danxIssueCreate = input.danxIssueCreate ?? defaultDanxIssueCreate;
  const setCard = input.setCard ?? defaultSetCard;
  const flipStatus = input.flipStatus ?? defaultFlipStatus;

  await ensureMirror(ctx.repoRoot);

  const threshold = readThreshold(ctx.repoRoot);

  const candidate = await getCandidate({ repo: ctx.repoName, threshold });
  if (candidate === null) return { kind: "no-candidate" };

  const priorAttempts = await getPrior({ errorId: candidate.id });
  const attemptN = priorAttempts.length + 1;

  const repairRow = await insertAttempt({ errorId: candidate.id, attemptN });

  const draft = buildRepairCardDraft({
    errorRow: candidate,
    priorAttempts,
    attemptN,
    epicId,
  });

  // Build the draft Issue via `createEmptyIssue` so every required
  // field passes the strict validator inside `handleIssueCreate`.
  // `id` and `external_id` stay empty — the create flow allocates the
  // next `<PREFIX>-N`. The single AC is intentionally generic — the
  // agent skill (Phase 4) refines it inside the dispatch.
  const issue = createEmptyIssue({
    status: "ToDo",
    type: "Bug",
    title: draft.title,
    description: draft.description,
  });
  issue.parent_id = epicId;
  issue.ac = [
    {
      check_item_id: "",
      title:
        "Repair signature `" +
        candidate.signature_hash +
        "` reproduced + fix landed; originating error stops firing.",
      checked: false,
    },
  ];

  // Filename includes the repair row id — DB-unique so two ticks for
  // the same signature cannot collide on disk even if the clock skews.
  const filename = `self-repair-${candidate.signature_hash}-attempt${attemptN}-r${repairRow.id}`;
  writeYaml({
    repoRoot: ctx.repoRoot,
    filename,
    content: serializeIssue(issue),
  });

  const created = await danxIssueCreate({
    repoRoot: ctx.repoRoot,
    filename,
  });
  if (!created.created || !created.id) {
    log.warn(
      `[${ctx.repoName}] danx_issue_create returned non-success for self-repair attempt ${attemptN} of error ${candidate.id}: ${(created.errors ?? []).join(", ")}`,
    );
    return { kind: "create-failed", errors: created.errors ?? [] };
  }

  await setCard({ attemptId: repairRow.id, cardId: created.id });
  await flipStatus({ errorId: candidate.id, status: "repairing" });

  log.info(
    `[${ctx.repoName}] self-repair dispatch — error ${candidate.id} (${candidate.signature_hash}) attempt ${attemptN} card ${created.id}`,
  );

  return {
    kind: "dispatched",
    attemptN,
    cardId: created.id,
    errorId: candidate.id,
  };
}

async function defaultGetCandidate(args: { repo: string; threshold: number }) {
  return defaultGetDispatchCandidate({ db: getPool(), ...args });
}

async function defaultGetPrior(args: { errorId: number }) {
  return defaultGetPriorAttempts({ db: getPool(), errorId: args.errorId });
}

async function defaultInsertAttempt(args: { errorId: number; attemptN: number }) {
  return defaultInsertRepairAttempt({ db: getPool(), ...args });
}

async function defaultSetCard(args: { attemptId: number; cardId: string }) {
  return defaultSetRepairAttemptCard({ db: getPool(), ...args });
}

async function defaultFlipStatus(args: { errorId: number; status: "repairing" }) {
  return defaultFlipErrorStatus({ db: getPool(), errorId: args.errorId, status: args.status });
}

function defaultWriteYaml(args: { repoRoot: string; filename: string; content: string }) {
  ensureIssuesDirs(args.repoRoot);
  const path = resolve(args.repoRoot, ".danxbot", "issues", "open", `${args.filename}.yml`);
  writeFileSync(path, args.content, "utf-8");
}

/**
 * Production create path. Delegates to `createInProcessIssue` (the
 * in-worker bridge to `nextIssueId` + the issue-tracker writer).
 * Lazily imported so unit tests that override `danxIssueCreate` skip
 * the worker-route module-load tax entirely.
 */
async function defaultDanxIssueCreate(args: {
  repoRoot: string;
  filename: string;
}): Promise<DanxIssueCreateResult> {
  const { createInProcessIssue } = await import(
    "../../system-repair/in-process-create.js"
  );
  return createInProcessIssue(args);
}

/**
 * Cron-registry entry. Fires every 60s. The job body reads `ctx` from
 * the dispatcher (`worker-loop.ts`); unit tests reach `runSelfRepairDispatch`
 * directly.
 */
export const selfRepairDispatch: CronJob = {
  name: "self-repair-dispatch",
  intervalSec: 60,
  async run(ctx) {
    await runSelfRepairDispatch({ ctx });
  },
};
