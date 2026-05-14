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
 *    `cards` first (the dispatchable list comes pre-sorted by priority
 *    DESC + ICE total DESC + FIFO from `listDispatchableYamls`).
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
 * Return EVERY agent that's eligible to take a new dispatch, sorted
 * by name. Returns `[]` when no agent qualifies. Same filter chain as
 * {@link pickFreeAgent} — kept as a single source of truth so the
 * picker's "first eligible" pick and the dispatch invariant assertion
 * (DX-368) cannot diverge.
 *
 * Filters in this order:
 *
 *   1. `enabled === true` (operator paused agents are always skipped).
 *   2. `capabilities` includes `"issue-worker"` (Slack-only or
 *      api-only agents don't process cards).
 *   3. NOT in `busy` — no in-flight dispatch on this repo.
 *   4. `broken === null` (DX-292 — a prep dispatch that ended in
 *      `abort` marks the agent unrecoverable; the operator clears the
 *      field via the dashboard once the worktree is healthy again).
 *   5. `isAgentInSchedule(agent, now)` — the agent's tz + per-day
 *      windows say it's working hours.
 */
export function pickFreeAgentCandidates(
  input: PickFreeAgentInput,
): AgentRecordWithName[] {
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
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates;
}

/**
 * Return the first agent that's eligible to take a new dispatch, or
 * null when no agent qualifies. Thin wrapper around
 * {@link pickFreeAgentCandidates} — returns `candidates[0] ?? null`.
 *
 * Tiebreak: when multiple agents pass, return the one whose `name`
 * sorts first (lexicographic). Stable across ticks; tests can assert
 * the deterministic pick.
 */
export function pickFreeAgent(
  input: PickFreeAgentInput,
): AgentRecordWithName | null {
  const candidates = pickFreeAgentCandidates(input);
  return candidates[0] ?? null;
}

export interface PickCardForAgentInput {
  /**
   * Pre-sorted list of dispatchable cards. `listDispatchableYamls`
   * already returns them in canonical pick order (priority DESC + ICE
   * total DESC + FIFO; DX-521); this helper preserves that order and
   * just filters out cards another agent owns.
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
 * DX-501: duplicate ownership (>1 open card stamped to the same
 * agent) returns `{kind: "duplicates", cards}` instead of throwing.
 * The picker dispatches a reconcile task body so the agent self-heals.
 */

/**
 * Discriminated result of `findOwnedCard` (DX-501 — replaces the prior
 * throw-on-duplicate control flow). Callers branch on `kind`:
 *
 *   - `"none"`     — agent owns no open card; picker offers a fresh ToDo.
 *   - `"single"`   — agent owns exactly one open card; picker resumes it.
 *   - `"duplicates"` — agent owns 2+ open cards; picker dispatches a
 *     **reconcile** task body so the agent itself releases the extra
 *     stamps in-session. See `buildReconcileTaskBody` below.
 */
export type FindOwnedCardResult =
  | { kind: "none" }
  | { kind: "single"; card: Issue }
  | { kind: "duplicates"; cards: readonly Issue[] };

/**
 * Resolve the agent's open-card ownership state. Returns a discriminated
 * result the caller switches on — never throws.
 *
 * Status filter: only non-terminal cards count. Closed-dir cards carry
 * `assigned_agent` forever as durable audit; treating them as live
 * ownership would prevent every agent from ever picking up new work
 * once it shipped its first card.
 *
 * Order preserved: `duplicates.cards` matches `openIssues` order. Caller
 * uses it for the reconcile prompt enumeration and as the heuristic
 * tiebreak when picking a dispatch target.
 *
 * Pure — no DB queries, no filesystem reads.
 *
 * DX-501: pre-DX-501 this function threw `OwnedCardInvariantError` on
 * duplicate ownership and the picker caught + skipped the agent for the
 * tick. That state is fully self-healable — the agent has every card's
 * description, recent comments, and worktree context — so the picker
 * now dispatches a reconcile task body instead of punting to operator
 * intervention. The error class is gone; control flow lives in the
 * return value. A future "defensive invariant throw for picker-internal
 * dup creation mid-tick" was considered (see DX-501 AC #6) and rejected
 * — adding a throw the picker never catches would re-introduce the
 * exact escape hatch this card removed.
 */
export function findOwnedCard(
  agentName: string,
  openIssues: readonly Issue[],
): FindOwnedCardResult {
  const owned = openIssues.filter(
    (i) =>
      i.assigned_agent === agentName &&
      i.status !== "Done" &&
      i.status !== "Cancelled",
  );
  if (owned.length === 0) return { kind: "none" };
  if (owned.length === 1) return { kind: "single", card: owned[0] };
  return { kind: "duplicates", cards: owned };
}

/**
 * Build the reconcile task body the picker hands to an agent that holds
 * duplicate `assigned_agent` stamps (DX-501).
 *
 * The body is self-contained — no `/danx-prep` / `/danx-next` first leg,
 * because the agent's first job is to decide which card it actually owns
 * before any work skill runs. After the agent releases the extras, it
 * invokes `/danx-next <retained-id>` on the retained card in the same
 * session and the normal work pipeline takes over from there.
 *
 * Pure — no I/O. Callers feed the agent name + the duplicates list from
 * `findOwnedCard`. Order of `ownedCards` is preserved verbatim in the
 * enumeration so the prompt is stable across ticks (deterministic test
 * assertion).
 */
export function buildReconcileTaskBody(
  agentName: string,
  ownedCards: readonly Issue[],
): string {
  const enumerated = ownedCards
    .map((c, i) => {
      const hint = c.description.trim().split("\n")[0].slice(0, 120);
      return [
        `${i + 1}. **${c.id}** — ${c.title}`,
        `   status: ${c.status}`,
        hint ? `   hint: ${hint}` : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
    })
    .join("\n\n");

  return [
    `You are ${agentName}.`,
    "",
    `Reconcile required: your \`assigned_agent\` stamp is on **${ownedCards.length} open cards** at once. The invariant is at-most-one. You must decide which ONE card is legitimately yours to continue and release the rest before any work pipeline starts.`,
    "",
    "## Cards currently stamped to you",
    "",
    enumerated,
    "",
    "## Reconcile procedure (do this BEFORE any /danx-next)",
    "",
    "1. **Inspect each card.** For every id listed above, call `mcp__danx-issue__danx_issue_get({id})` and read the YAML's description, AC, recent comments, and any prior dispatch history. Inspect your worktree state on your agent branch (`git log --oneline -20`, `git status`) for evidence of which card you were actively working.",
    "2. **Decide which ONE card to retain.** Heuristic: the card with the most recent meaningful work on your branch, the freshest comments, and a status preference of `In Progress` over `ToDo`. A duplicate stamped on a `Blocked` or `Review` card is an INVALID state — those statuses are never agent-dispatched, so the stamp is leftover; treat that card as a release candidate, not a retention candidate, and unstamp it (step 3) unless the work in it clearly matters and a fresh ToDo doesn't exist for the same goal. Append a structured comment entry to the retained card's `comments[]` explaining the choice — shape: `{author: \"<your-name>\", timestamp: \"<ISO 8601 now>\", text: \"## Reconcile — retained this card\\n\\nReason: ...\"}`. No `id` field; the worker assigns one.",
    "3. **Release every other card.** For each card NOT retained, `Edit` its YAML to set `assigned_agent: null` and clear the `dispatch` block if it still names you. Append a structured `comments[]` entry to that card with text `Released by reconcile dispatch — see <retained-id>`.",
    "4. **Check the retained card's dispatch gates before resuming.** If the retained card has non-null `waiting_on`, non-null `requires_human`, or `status: \"Blocked\"`, you cannot just run `/danx-next` — those are dispatch gates `/danx-next` will refuse or mishandle. Resolve them first (clear `waiting_on` if every blocker is terminal; transition status off `Blocked` if you have the evidence; populate or clear `requires_human` per the workflow rules). If you cannot resolve them in this session, save your reasoning in a comment and call `danxbot_complete({status: \"completed\", summary: \"Reconcile complete — retained <id>; cannot resume this session due to <gate>\"})` instead of step 5.",
    "5. **Resume normal work.** Once exactly one card carries your stamp AND its dispatch gates are clear, invoke `/danx-next <retained-id>` in this same session to enter the standard issue-card workflow on the retained card. `/danx-next` owns completion signaling from that point.",
    "",
    "Do not call `danxbot_complete` until either step 4's early-exit branch OR step 5's `/danx-next` finishes.",
  ].join("\n");
}
