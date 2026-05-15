/**
 * DX-563 (Phase 3 of DX-560 — Self-Repair): pure repair-card draft
 * builder. Takes a categorized `system_errors` row + the history of
 * prior `system_error_repairs` attempts and emits `{title, description}`
 * matching the Phase-3 template. No DB, no FS — the dispatcher
 * (`src/cron/jobs/self-repair-dispatch.ts`) wraps this in a draft YAML
 * that the synchronous `danx_issue_create` flow stamps with a real id.
 *
 * Why a separate module:
 *
 *  - The template is the agent's primary input — readable diffs on
 *    template changes are valuable, so the renderer lives in one place
 *    that the test suite pins line by line.
 *  - Keeps the cron job itself a thin orchestrator (pick, write,
 *    update) — the per-error-row presentation is a pure function.
 */

import type {
  SystemErrorRow,
  SystemErrorRepairRow,
  SystemErrorRepairVerdict,
} from "./types.js";
import { SELF_REPAIR_TITLE_PREFIX } from "./is-repair-card.js";

/** Cap on a prior-attempt's `report_md` excerpt rendered into the new card. */
const REPORT_EXCERPT_LIMIT = 200;

export interface BuildRepairCardDraftInput {
  errorRow: SystemErrorRow;
  /**
   * Every prior attempt for this `errorRow`. The renderer lists them in
   * ascending `attempt_n` order — caller is expected to sort, but the
   * renderer also tolerates an unsorted list (it does not re-sort
   * because tests would lose deterministic insertion order on tie).
   */
  priorAttempts: SystemErrorRepairRow[];
  /** 1-based attempt number for the NEW card the dispatcher is creating. */
  attemptN: number;
  /** The epic id the new card hangs under (e.g. `DX-560`). */
  epicId: string;
}

export interface RepairCardDraft {
  title: string;
  description: string;
}

export function buildRepairCardDraft(
  input: BuildRepairCardDraftInput,
): RepairCardDraft {
  const { errorRow, priorAttempts, attemptN, epicId } = input;

  // Producer side of the picker's routing contract (DX-564). Consumer
  // side is `isSelfRepairCard` in `is-repair-card.ts`; the title prefix
  // lives in one place so a rename surfaces as a one-line diff.
  const title =
    `${SELF_REPAIR_TITLE_PREFIX}${attemptN}: ${errorRow.category_key} ` +
    `(${errorRow.signature_hash})`;

  const samplePayloadJson = JSON.stringify(errorRow.sample_payload, null, 2);

  const priorBlock =
    priorAttempts.length === 0
      ? "(none)"
      : priorAttempts
          .map((p) => renderPriorAttempt(p))
          .join("\n");

  // NOTE: keeping the template verbatim (with the indented signature hash
  // backticks) so the agent's first read of its own card surfaces the
  // signature inline-coded — saves a `Bash` call to re-derive it.
  const description = [
    "## Repair Target",
    "",
    `Component: ${errorRow.component}`,
    `Category:  ${errorRow.category_key}`,
    `Count:     ${errorRow.count} ` +
      `(first seen ${errorRow.first_seen.toISOString()}, ` +
      `last seen ${errorRow.last_seen.toISOString()})`,
    `Signature: ${errorRow.signature_hash}`,
    "",
    "## Sample Payload",
    "",
    "```json",
    samplePayloadJson,
    "```",
    "",
    "## Prior Repair Attempts",
    "",
    priorBlock,
    "",
    "## Instructions",
    "",
    `You are the self-repair agent for system error signature \`${errorRow.signature_hash}\`.`,
    "Follow the `danxbot:self-repair` skill. Fix the deterministic problem,",
    "verify the originating error stops reproducing, write a `## Repair",
    `Report\` comment, then \`danxbot_complete\`.`,
    "",
    `Parent epic: ${epicId}.`,
    "",
  ].join("\n");

  return { title, description };
}

function renderPriorAttempt(p: SystemErrorRepairRow): string {
  const card = p.card_id ?? "(no-card)";
  const verdict: SystemErrorRepairVerdict | "pending" = p.verdict ?? "pending";
  const reportExcerpt = (p.report_md ?? "").slice(0, REPORT_EXCERPT_LIMIT);
  return (
    `- Attempt ${p.attempt_n} (${card}): verdict=${verdict}, ` +
    `report excerpt: ${reportExcerpt}`
  );
}
