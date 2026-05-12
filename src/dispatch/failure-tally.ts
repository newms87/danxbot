/**
 * Per-card consecutive-failure tally + auto-escalate to Blocked.
 *
 * Replaces the legacy per-poller failure counter deleted by DX-242.
 * The retired counter lived in poller-tick memory:
 *
 *   - Reset every worker boot (token-burn protection lost across restarts).
 *   - Global per-poller (one stuck card halted every card).
 *   - Tick-bounded (escalation could not happen mid-tick).
 *
 * The replacement is per-card and derives the count from the durable
 * `dispatches` table (DB) so it survives restart, and runs at the
 * scheduler's per-dispatch stop callback so escalation lands the
 * moment the threshold is hit — not at the next tick.
 *
 * Threshold: {@link DEFAULT_FAILURE_THRESHOLD} consecutive `failed`
 * statuses since the last `completed`. At threshold the orchestrator
 * stamps `status: "Blocked"` + `blocked: {reason, timestamp}` + a
 * `## Stuck-card recovery` comment on the YAML and pushes a
 * `recordSystemError({source: "stuck-card"})` event so the dashboard
 * banner surfaces the escalation.
 *
 * AC #1 of DX-221. See {@link escalateOnRepeatedFailures} for the
 * scheduler-side entry point.
 */

import type { Dispatch } from "../dashboard/dispatches.js";

/**
 * Default trailing `failed` count that triggers escalation.
 *
 * 3 picked empirically — the legacy in-memory threshold was also 3 and
 * the production data shows that 2 failures often resolve naturally
 * (transient claude-auth blip, brief MCP server reload) while 3 in a
 * row is consistent with an env-level or card-specific blocker that
 * needs an operator look. Configurable per call-site so the system
 * test suite can drop it to 2 for fast assertions.
 */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Walk a newest-first dispatch list and count the trailing run of
 * `failed` statuses. Stops at the first non-`failed` row (any
 * intervening `completed` resets the counter — recovery means the
 * card unstuck itself).
 *
 * `cancelled` and `recovered` do NOT count as failures and do NOT
 * reset the counter — they are mid-flight aborts, not card-progress
 * signals. They are skipped (do not increment, do not stop). A
 * `running` or `queued` row is ALSO skipped (caller may have included
 * the still-active dispatch; we only care about terminal-failed runs).
 *
 * Pure for testability — caller fetches via
 * `listDispatchesByIssueId` and passes the resulting array (which is
 * already newest-first).
 */
export function countTrailingFailures(
  rows: Pick<Dispatch, "status">[],
): number {
  let n = 0;
  for (const row of rows) {
    if (row.status === "failed") {
      n += 1;
      continue;
    }
    if (row.status === "completed") {
      return n;
    }
    // queued / running / cancelled / recovered — skip without
    // affecting the count or breaking the run. The next `completed`
    // (or end of list) still terminates.
  }
  return n;
}

/**
 * Build the YAML mutation strings for the escalation. Pure so a
 * test can pin the rendered markdown without filesystem side-effects.
 *
 * `commentText` is the body of the comment appended to `comments[]`.
 * `blockedReason` is the value to stamp into `blocked.reason`. The
 * orchestrator wires both into a single YAML write.
 */
export function buildEscalationText(args: {
  cardId: string;
  cardTitle: string;
  failureCount: number;
  recentFailures: Array<
    Pick<Dispatch, "id" | "completedAt" | "summary" | "error">
  >;
}): { commentText: string; blockedReason: string } {
  const failureLines = args.recentFailures
    .slice(0, args.failureCount)
    .map((d, i) => {
      const completedAt = d.completedAt
        ? new Date(d.completedAt).toISOString()
        : "(unknown)";
      const oneLine = (d.summary || d.error || "(no summary)")
        .split("\n")[0]
        .slice(0, 200);
      return `${i + 1}. \`${d.id}\` @ ${completedAt} — ${oneLine}`;
    })
    .join("\n");

  const blockedReason =
    `Auto-escalated after ${args.failureCount} consecutive failed dispatches — operator investigation required.`;

  const commentText =
    `<!-- danxbot -->\n\n` +
    `## Stuck-card recovery — auto-escalated to Blocked\n\n` +
    `**Reason:** ${args.failureCount} consecutive failed dispatches against ${args.cardId} (${args.cardTitle}) ` +
    `with no intervening success. The scheduler stopped retrying to prevent a token-burn loop.\n\n` +
    `**Recent failures (newest first):**\n\n${failureLines}\n\n` +
    `**Next steps:** Investigate the failure summaries in the dashboard; clear by moving the card off Blocked once the underlying problem is fixed.`;

  return { commentText, blockedReason };
}
