/**
 * Multi-worker pick algorithm helpers (DX-200 / DX-158 epic Phase 5).
 *
 * Two pure functions:
 *
 *  - `pickFreeAgent(roster, busy, now)` — find the first agent in
 *    `roster` that is enabled, has the `issue-worker` capability,
 *    is in-schedule for `now`, and is not in the `busy` set. Returns
 *    `null` when no candidate qualifies. Stable: with two equally-
 *    eligible agents, returns the one whose name sorts first.
 *
 *  - `pickCardForAgent(cards, agent, assigned)` — find the first card
 *    in `cards` whose `assigned_agent` is either null or matches the
 *    candidate agent's name (re-claim). Returns `null` when every card
 *    is owned by another agent. Caller is responsible for sorting
 *    `cards` first (the dispatchable list comes pre-sorted by ICE total
 *    DESC + priority DESC + FIFO from `listDispatchableYamls`).
 *
 * Both helpers are pure — no DB queries, no filesystem reads. The
 * caller (`src/cron/sync-and-audit.ts`) builds `roster` from `readAgents(ctx)`,
 * `busy` from `busyAgents(repoName)`, and `assigned` from
 * `assignedCards(repoName)`. Pure helpers let tests cover every branch
 * with cheap fixture inputs and no env-loading config chain.
 *
 * Why "stable by name" tiebreak in pickFreeAgent: rotational pick
 * fairness (round-robin) is operator-visible behaviour we'd want a
 * separate design pass for. Today's "first by name" is good enough for
 * Phase 5's "are concurrent dispatches working" milestone — and is the
 * easiest behaviour to reason about in tests. A future card can revisit
 * if operators report load-imbalance complaints.
 */

import { isAgentBroken, type AgentRecordWithName } from "../settings-file.js";
import {
  isAgentInSchedule,
  type ScheduleCheckAgent,
} from "../agent/agent-schedule.js";
import type { Issue } from "../issue-tracker/interface.js";
import { createLogger } from "../logger.js";

const log = createLogger("pick-agent");

export interface PickFreeAgentInput {
  roster: readonly AgentRecordWithName[];
  busy: ReadonlySet<string>;
  now: Date;
  /**
   * Repo name used for the debug-log prefix on a broken-skip. Optional
   * so existing tests that don't care about the log line don't have to
   * thread the value through. Production callers (`tryMultiAgentDispatch`)
   * should always pass it so operator log scans surface the right repo.
   */
  repoName?: string;
}

/**
 * Return the first agent that's eligible to take a new dispatch, or
 * null when no agent qualifies. Filters in this order:
 *
 *   1. `enabled === true` (operator paused agents are always skipped).
 *   2. `capabilities` includes `"issue-worker"` (Slack-only or
 *      api-only agents don't process cards).
 *   3. `broken === null` (DX-292 — a prep dispatch that ended in
 *      `abort` marks the agent unrecoverable; the operator clears the
 *      field via the dashboard once the worktree is healthy again).
 *   4. NOT in `busy` — no in-flight dispatch on this repo.
 *   5. `isAgentInSchedule(agent, now)` — the agent's tz + per-day
 *      windows say it's working hours.
 *
 * Tiebreak: when multiple agents pass, return the one whose `name`
 * sorts first (lexicographic). Stable across ticks; tests can assert
 * the deterministic pick.
 */
export function pickFreeAgent(
  input: PickFreeAgentInput,
): AgentRecordWithName | null {
  const { roster, busy, now, repoName } = input;
  // Filter chain ordered cheapest-first:
  //   1. enabled flag (object property read)
  //   2. capability membership (3-element array contains)
  //   3. busy set (Set.has — O(1))
  //   4. broken state (object property read — DX-292)
  //   5. schedule check (Intl.DateTimeFormat allocation + parse)
  // The Intl call is the expensive predicate; running it last lets a
  // disabled / busy / wrong-capability / broken agent skip it entirely.
  // Busy is filtered BEFORE broken so an agent that's both broken AND
  // mid-dispatch does NOT emit the broken-skip log line every tick —
  // the underlying problem is one of two, and the busy-skip path is
  // silent so log volume scales with the broken set, not busy×broken.
  const candidates = roster.filter((a) => {
    if (!a.enabled) return false;
    if (!a.capabilities.includes("issue-worker")) return false;
    if (busy.has(a.name)) return false;
    if (isAgentBroken(a)) {
      // The reason can be long (operator-facing prose); slice to keep
      // the log line scannable. `set_at` lets operators correlate to
      // the prep dispatch that flagged the worktree. `log.debug` (not
      // `info`) — operators paging through worker logs for an
      // operational concern can opt in via `LOG_LEVEL=debug`; default
      // log volume stays clean while broken-state lingers.
      const reason = a.broken?.reason ?? "";
      const prefix = repoName ? `[${repoName}] ` : "";
      log.debug(
        `${prefix}pick: skipping agent ${a.name} — broken (set_at=${
          a.broken?.set_at ?? ""
        }, reason=${reason.slice(0, 80)})`,
      );
      return false;
    }
    const checkInput: ScheduleCheckAgent = {
      enabled: a.enabled,
      schedule: a.schedule,
    };
    if (!isAgentInSchedule(checkInput, now)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates[0];
}

export interface PickCardForAgentInput {
  /**
   * Pre-sorted list of dispatchable cards. `listDispatchableYamls`
   * already returns them in canonical pick order (ICE total DESC +
   * priority DESC + FIFO); this helper preserves that order and just
   * filters out cards another agent owns.
   */
  cards: readonly Issue[];
  agentName: string;
  /**
   * Map of `<PREFIX>-N` → agent name. Comes from `assignedCards()`.
   * A card whose entry maps to a DIFFERENT agent name is skipped.
   * Cards absent from the map are unclaimed (eligible for any agent).
   * Cards whose entry matches `agentName` are eligible for re-claim by
   * the same agent (orphan-resume + multi-tick continuation).
   */
  assigned: ReadonlyMap<string, string>;
}

/**
 * Return the first card the agent can take, or null when every card is
 * claimed by another agent. The pre-sorted order is preserved — this
 * function doesn't re-rank, only filters.
 *
 * Ownership resolution: a card is considered owned by another agent
 * when EITHER the DB-backed `assigned` map OR the YAML's own
 * `assigned_agent` field names a different agent. Both sources are
 * consulted because they can disagree briefly during the chokidar
 * mirror's read-your-writes window — being conservative here (skip if
 * EITHER source dissents) prevents two agents from picking the same
 * card on adjacent ticks.
 */
export function pickCardForAgent(input: PickCardForAgentInput): Issue | null {
  const { cards, agentName, assigned } = input;
  for (const c of cards) {
    const dbOwner = assigned.get(c.id) ?? null;
    const yamlOwner = c.assigned_agent ?? null;
    const ownedByOther =
      (dbOwner !== null && dbOwner !== agentName) ||
      (yamlOwner !== null && yamlOwner !== agentName);
    if (!ownedByOther) return c;
  }
  return null;
}

/**
 * DX-360 — resolve the agent's existing open card BEFORE the picker
 * offers any fresh ToDo.
 *
 * Contract: an agent may own AT MOST ONE non-terminal card at a time
 * (closed cards in `<repo>/.danxbot/issues/closed/` carry historical
 * `assigned_agent` for audit and don't count). The picker's first
 * obligation on every tick is to resume that card if it exists —
 * regardless of card status (ToDo / In Progress / Blocked / Review /
 * waiting_on / requires_human). The agent itself is the decision-maker
 * on resumption:
 *
 *   - Finish the work if it's near-complete and valid → commit + sync
 *     back to main.
 *   - Card is genuinely blocked → unassign self, flip status to
 *     Blocked / Waiting On / Cancelled with the right reason, clean
 *     the worktree of any stale WIP.
 *   - Work is invalid → discard + clean worktree + transition card.
 *
 * In every case the agent's job is to return the system to a valid
 * state. The picker's job is to GET them onto the card; the dispatch
 * payload signals the resume by passing `resumeSessionId` so the agent
 * has full prior context.
 *
 * Throws `OwnedCardInvariantError` when more than one non-terminal
 * card carries the same `assigned_agent`. This is a hard data
 * invariant — the writer of the second stamp violated it and the
 * picker cannot guess which card to resume. Caller catches + heals by
 * skipping the agent this tick + logging both card ids so an operator
 * can manually clear one stamp.
 */
export class OwnedCardInvariantError extends Error {
  constructor(
    public readonly agentName: string,
    public readonly cardIds: string[],
  ) {
    super(
      `agent ${agentName} owns ${cardIds.length} open cards: ${cardIds.join(", ")} — invariant requires <=1`,
    );
    this.name = "OwnedCardInvariantError";
  }
}

/**
 * Return the agent's single open card (Status ∉ {Done, Cancelled}) or
 * null when the agent has no open assignment. Throws
 * `OwnedCardInvariantError` on duplicate ownership.
 *
 * `openIssues` is expected to be every non-terminal issue YAML for the
 * repo (the caller passes `listOpenYamls(repoLocalPath, prefix)`).
 * Pure — no DB queries, no filesystem reads.
 */
export function findOwnedCard(
  agentName: string,
  openIssues: readonly Issue[],
): Issue | null {
  const owned = openIssues.filter(
    (i) =>
      i.assigned_agent === agentName &&
      i.status !== "Done" &&
      i.status !== "Cancelled",
  );
  if (owned.length === 0) return null;
  if (owned.length > 1) {
    throw new OwnedCardInvariantError(
      agentName,
      owned.map((i) => i.id),
    );
  }
  return owned[0];
}
