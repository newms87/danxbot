/**
 * Scheduler-side orchestrator for the per-card consecutive-failure
 * tally → auto-escalate-to-Blocked flow.
 *
 * Pure helpers (the counter + the rendered comment text) live in
 * {@link import("./failure-tally.js") `failure-tally.ts`}. This module
 * glues them to the DB + YAML I/O — the multi-agent picker's
 * `onComplete` callback invokes {@link escalateOnRepeatedFailures}
 * after a failed dispatch.
 *
 * Flow on failure:
 *
 *   1. {@link listDispatchesByIssueId} fetches every dispatch row for
 *      this card, newest-first.
 *   2. {@link countTrailingFailures} computes the run of failed
 *      statuses since the last `completed`.
 *   3. If `count < threshold` → return; no action.
 *   4. Otherwise — read the YAML; if already `status: "Blocked"`,
 *      return (idempotent, do not re-stamp). Else:
 *        - stamp `status: "Blocked"`,
 *        - stamp `blocked: { reason, timestamp }`,
 *        - append a `## Stuck-card recovery` comment via
 *          `buildEscalationText`,
 *        - persist via `writeIssue`,
 *        - call `recordSystemError({source: "stuck-card"})` so the
 *          dashboard banner shows the escalation.
 *
 * AC #1 of DX-221.
 */

import { randomUUID } from "node:crypto";
import { listDispatchesByIssueId } from "../dashboard/dispatches-db.js";
import { recordSystemError } from "../dashboard/system-errors.js";
import { writeIssue } from "../poller/yaml-lifecycle.js";
import { createLogger } from "../logger.js";
import type { Issue } from "../issue-tracker/interface.js";
import {
  buildEscalationText,
  countTrailingFailures,
  DEFAULT_FAILURE_THRESHOLD,
} from "./failure-tally.js";

const log = createLogger("failure-escalation");

export interface EscalateOnRepeatedFailuresInput {
  repoName: string;
  repoLocalPath: string;
  /** Internal id (`<PREFIX>-N`) — the DB's `dispatches.issue_id` column. */
  internalIssueId: string;
  /** Loaded YAML (caller's existing `loadLocal` result). */
  card: Issue;
  /**
   * Override threshold. Defaults to {@link DEFAULT_FAILURE_THRESHOLD}.
   * The system-test suite passes `2` for fast assertions.
   */
  threshold?: number;
  now?: Date;
  /** Test seam. Defaults to the production `listDispatchesByIssueId`. */
  listDispatches?: typeof listDispatchesByIssueId;
  /** Test seam. Defaults to the production `writeIssue`. */
  writeIssueFn?: typeof writeIssue;
  /** Test seam. Defaults to the production `recordSystemError`. */
  recordSystemErrorFn?: typeof recordSystemError;
}

export interface EscalateResult {
  /** Number of trailing failed dispatches at decision time. */
  failureCount: number;
  /** True when the threshold was reached AND the card was newly stamped Blocked. */
  escalated: boolean;
  /**
   * Reason the call short-circuited without escalating (when
   * `escalated === false`). One of:
   *   - `below-threshold` — count < threshold.
   *   - `already-blocked` — count >= threshold but card was already at
   *     `status: "Blocked"` (idempotent).
   */
  skipReason?: "below-threshold" | "already-blocked";
}

/**
 * Top-level entry point. See module header for the contract.
 *
 * The function NEVER throws — every error path logs + returns a safe
 * `{escalated: false}` shape. Dispatch-completion is not the right
 * place to throw: the dispatch has already ended; an uncaught here
 * leaks into the picker's `onComplete` async chain and stalls the
 * next tick. The DB-query path falls open (treats list failure as
 * `count: 0`) so a transient DB blip cannot park a working card.
 */
export async function escalateOnRepeatedFailures(
  input: EscalateOnRepeatedFailuresInput,
): Promise<EscalateResult> {
  const threshold = input.threshold ?? DEFAULT_FAILURE_THRESHOLD;
  const listDispatches = input.listDispatches ?? listDispatchesByIssueId;
  const writeIssueFn = input.writeIssueFn ?? writeIssue;
  const recordSystemErrorFn =
    input.recordSystemErrorFn ?? recordSystemError;
  const now = input.now ?? new Date();

  let rows;
  try {
    rows = await listDispatches(input.internalIssueId);
  } catch (err) {
    log.error(
      `[${input.repoName}] escalation: listDispatches threw for ${input.internalIssueId} — treating as 0 failures`,
      err,
    );
    return { failureCount: 0, escalated: false, skipReason: "below-threshold" };
  }

  const failureCount = countTrailingFailures(rows);
  if (failureCount < threshold) {
    return {
      failureCount,
      escalated: false,
      skipReason: "below-threshold",
    };
  }

  if (input.card.status === "Blocked" && input.card.blocked !== null) {
    log.info(
      `[${input.repoName}] escalation: ${input.internalIssueId} already Blocked — skipping idempotent re-stamp`,
    );
    return {
      failureCount,
      escalated: false,
      skipReason: "already-blocked",
    };
  }

  const recentFailures = rows
    .filter((r) => r.status === "failed")
    .slice(0, failureCount);

  const { commentText, blockedReason } = buildEscalationText({
    cardId: input.internalIssueId,
    cardTitle: input.card.title,
    failureCount,
    recentFailures,
  });

  const timestamp = now.toISOString();
  const updated: Issue = {
    ...input.card,
    status: "Blocked",
    blocked: { reason: blockedReason, timestamp },
    comments: [
      ...input.card.comments,
      {
        id: randomUUID(),
        author: "danxbot",
        timestamp,
        text: commentText,
      },
    ],
  };

  try {
    await writeIssueFn(input.repoLocalPath, updated);
  } catch (err) {
    log.error(
      `[${input.repoName}] escalation: writeIssue threw for ${input.internalIssueId} — escalation skipped`,
      err,
    );
    return {
      failureCount,
      escalated: false,
      skipReason: "below-threshold",
    };
  }

  try {
    recordSystemErrorFn({
      source: "stuck-card",
      severity: "error",
      repo: input.repoName,
      message: `Card ${input.internalIssueId} auto-escalated to Blocked after ${failureCount} consecutive failures`,
      details: {
        title: input.card.title,
        threshold,
        failureCount,
      },
    });
  } catch (err) {
    log.warn(
      `[${input.repoName}] escalation: recordSystemError threw for ${input.internalIssueId}`,
      err,
    );
    // Escalation already persisted on YAML — the banner miss is a
    // non-fatal observability gap, not a workflow failure.
  }

  log.warn(
    `[${input.repoName}] escalation: ${input.internalIssueId} moved to Blocked after ${failureCount} consecutive failed dispatches`,
  );
  return { failureCount, escalated: true };
}
