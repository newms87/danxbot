/**
 * DX-365 (Phase 2 of DX-363) — strike accumulator + atomic 3-strike
 * broken transition for the per-agent fault model.
 *
 * Contract — strike-or-not by dispatch terminal status (locked w/ user
 * in the DX-365 description):
 *
 *   | terminal status | strike? | notes                                   |
 *   |-----------------|---------|-----------------------------------------|
 *   | completed       | NO      | success; does NOT reset count            |
 *   | cancelled       | NO      | operator interrupt — not the agent       |
 *   | failed          | YES     | agent did not put card/env in valid state|
 *   | recovered       | YES     | API-error auto-recover ⇒ unstable session|
 *   | throttled       | YES     | rate-limit kill counts                   |
 *   | future values   | YES     | whitelist non-strikes explicitly         |
 *
 * Behavior:
 *
 *   1. Atomic increment via `mutateAgents` (per-file lock + in-process
 *      queue) so concurrent failed dispatches against the same agent
 *      cannot double-count (AC #5).
 *   2. History capped at the last `STRIKES_HISTORY_CAP = 3` entries —
 *      older entries are silently pruned; the evaluator (Phase 4) only
 *      needs the 3 strikes that triggered broken (AC #4).
 *   3. Count caps at `STRIKES_MAX = 3` (the validator rejects higher
 *      values). 4th strike when already at the cap rotates history but
 *      leaves count at 3 (AC #4).
 *   4. On the strike that lands count at `STRIKES_MAX` AND the agent's
 *      `broken` is null, the mutator stamps:
 *        broken = {
 *          reason: DEFAULT_BROKEN_REASON,
 *          set_at: now ISO,
 *          evaluator_status: "pending",
 *          evaluator_dispatch_id: null,
 *          suggested_steps: [],
 *        }
 *      and the helper emits a `broken-transition` event AFTER the lock
 *      releases so Phase 4's evaluator dispatcher can act on it. The
 *      event fires EXACTLY once per `null → populated` transition; a
 *      4th strike when already broken does NOT re-emit (AC #4).
 *
 * Strikes do NOT reset on `completed` — the counter is durable across
 * the agent's lifetime until a human clears it via the dashboard
 * (Phase 6). This is the load-bearing assumption that makes 3 strikes
 * mean "this agent is failing across cards", not "this card is hard."
 *
 * `agent_blocked` and `critical_failure` agent-side complete signals
 * collapse to `failed` at the dispatch row's terminal status (see
 * `mapCompleteToTerminalStatus` in `src/mcp/danxbot-server.ts`). They
 * therefore DO strike under the Phase 2 contract — the strike decision
 * tree fires on the row's DispatchStatus, not the agent's intent.
 * Refining this (e.g. carving `agent_blocked` out as a non-strike)
 * is Phase 4+ scope; Phase 2 ships the row-status mechanic literally.
 */

import { createLogger } from "../logger.js";
import {
  type AgentRecord,
  type AgentStrikeEntry,
  type AgentStrikeTerminalStatus,
  AGENT_STRIKE_TERMINAL_STATUSES,
  mutateAgents,
  STRIKES_HISTORY_CAP,
  STRIKES_MAX,
  validateStrikes,
} from "../settings-file.js";
import { dispatchEvents } from "../dispatch/events.js";
import type { DispatchStatus } from "../dashboard/dispatches.js";

const log = createLogger("strikes");

/**
 * Default reason stamped on `agent.broken` at the strike-3 transition
 * BEFORE the Phase 4 evaluator overwrites it with the real root-cause
 * summary. If the evaluator dispatch itself fails, this string is what
 * the operator sees in the banner (Phase 6).
 */
export const DEFAULT_BROKEN_REASON =
  "Agent dispatch failing — investigation pending";

/**
 * Subset of `DispatchStatus` values that COUNT as a strike. Derived from
 * `AGENT_STRIKE_TERMINAL_STATUSES` (the schema enum) so the two stay in
 * lockstep — a future addition to the strike set lands in one place.
 */
const STRIKE_ELIGIBLE: ReadonlySet<string> = new Set(
  AGENT_STRIKE_TERMINAL_STATUSES,
);

/** True iff the dispatch status increments the agent's strike counter. */
export function isStrikeEligible(
  status: DispatchStatus,
): status is AgentStrikeTerminalStatus {
  return STRIKE_ELIGIBLE.has(status);
}

export interface StrikeInput {
  dispatchId: string;
  /**
   * Issue id (`<PREFIX>-N`) the dispatch was bound to — REQUIRED.
   * Strikes are an agent-scoped fault model for multi-worker dispatches,
   * which are ALWAYS card-bound. Slack / ideator / external-launch
   * dispatches carry `agent_name === null` and do not strike at all,
   * so callers MUST gate on `agentName != null` BEFORE invoking this
   * helper, and at that gate `issueId` is guaranteed non-null too.
   * The schema validator (`validateStrikeEntry`) rejects an empty
   * `issue_id`, so passing it here would fail-loud at write time
   * anyway — surfacing the contract here instead keeps the error
   * close to the caller's mistake.
   */
  issueId: string;
  terminalStatus: AgentStrikeTerminalStatus;
  /**
   * Up to ~200 chars from the dispatch row's `error` column; empty
   * string allowed. Sliced caller-side so the slice policy lives at
   * the data source and this helper stays storage-agnostic.
   */
  rawError: string;
  /** ISO 8601 timestamp the strike landed (`new Date().toISOString()`). */
  timestamp: string;
}

export interface StrikeResult {
  /** Final strike count after this call (0..STRIKES_MAX). */
  count: number;
  /**
   * True iff this call flipped `agent.broken` from `null` to populated
   * AND emitted a `broken-transition` event. Always false on subsequent
   * calls against an already-broken agent.
   */
  brokenTransitionEmitted: boolean;
}

export interface RecordStrikeDeps {
  /** `<repo>/.danxbot` parent — same arg shape as `mutateAgents`. */
  localPath: string;
  /** Repo name carried in the `broken-transition` event. */
  repoName: string;
  /** Agent key in `settings.agents` map. Throws if not found on disk. */
  agentName: string;
}

/**
 * Atomically record one strike for the named agent. Returns the
 * post-write `{count, brokenTransitionEmitted}` so callers can log /
 * surface the outcome without re-reading settings.
 *
 * Throws when the agent does not exist on disk — same fail-loud
 * semantics as `setAgentBroken`. Callers MUST guard with
 * `dispatch.agentName != null` before invoking; non-agent dispatches
 * (Slack router, ideator) carry `agent_name === null` and do not
 * accumulate strikes.
 */
export async function recordStrike(
  input: StrikeInput,
  deps: RecordStrikeDeps,
): Promise<StrikeResult> {
  if (input.timestamp.length === 0) {
    throw new TypeError("recordStrike: input.timestamp must be non-empty");
  }
  if (input.dispatchId.length === 0) {
    throw new TypeError("recordStrike: input.dispatchId must be non-empty");
  }
  if (input.issueId.length === 0) {
    throw new TypeError("recordStrike: input.issueId must be non-empty");
  }

  let resultCount = 0;
  let resultEmitted = false;

  await mutateAgents(
    deps.localPath,
    (current) => {
      const record = current[deps.agentName];
      if (!record) {
        throw new Error(
          `recordStrike: agent "${deps.agentName}" not found in roster`,
        );
      }

      const nextStrikes = appendStrike(record, input);
      const wasBroken = record.broken !== null;
      const reachedCap = nextStrikes.count >= STRIKES_MAX;
      const shouldStampBroken = reachedCap && !wasBroken;

      const nextRecord: AgentRecord = {
        ...record,
        strikes: nextStrikes,
        broken: shouldStampBroken
          ? {
              reason: DEFAULT_BROKEN_REASON,
              suggested_steps: [],
              set_at: input.timestamp,
              // Phase 2 stamps `pending` directly — Phase 4's evaluator
              // dispatcher subscribes to `broken-transition` and walks
              // the field through `pending` → `running` → `completed`/
              // `failed`. NOT spread from `defaultBrokenEvaluator()` —
              // that helper stamps the legacy back-fill default
              // (`completed`) and a spread-then-override is fragile to
              // object-literal reordering.
              evaluator_status: "pending",
              evaluator_dispatch_id: null,
            }
          : record.broken,
        updated_at: input.timestamp,
      };

      // Defense-in-depth — re-validate the strikes block at the write
      // surface. The schema cap (count <= STRIKES_MAX) catches
      // counter-arithmetic bugs as a TypeError instead of silently
      // shipping a malformed record (the read-side normalizer would
      // degrade-to-default and the strike history would vanish).
      validateStrikes(nextRecord.strikes);

      current[deps.agentName] = nextRecord;
      resultCount = nextStrikes.count;
      resultEmitted = shouldStampBroken;
      return current;
    },
    "worker",
  );

  if (resultEmitted) {
    log.info(
      `[strikes] ${deps.repoName}:${deps.agentName} reached ${STRIKES_MAX} strikes — emitting broken-transition`,
    );
    dispatchEvents.emit("broken-transition", {
      repoName: deps.repoName,
      agentName: deps.agentName,
    });
  }

  return { count: resultCount, brokenTransitionEmitted: resultEmitted };
}

/**
 * Pure helper that produces the next `strikes` block from the current
 * record + the new entry. Caps count at `STRIKES_MAX` (so a 4th strike
 * against an already-capped agent rotates history without violating
 * the validator) and rotates history to keep the LAST
 * `STRIKES_HISTORY_CAP` entries.
 */
function appendStrike(
  record: AgentRecord,
  input: StrikeInput,
): AgentRecord["strikes"] {
  const entry: AgentStrikeEntry = {
    dispatch_id: input.dispatchId,
    issue_id: input.issueId,
    terminal_status: input.terminalStatus,
    timestamp: input.timestamp,
    raw_error: input.rawError,
  };
  const nextHistory = [...record.strikes.history, entry].slice(
    -STRIKES_HISTORY_CAP,
  );
  const nextCount = Math.min(record.strikes.count + 1, STRIKES_MAX);
  return { count: nextCount, history: nextHistory };
}
