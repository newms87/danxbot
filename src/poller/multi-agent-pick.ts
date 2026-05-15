/**
 * Multi-agent pick + dispatch loop (DX-200 / multi-worker dispatch
 * epic DX-158 Phase 5; rewired by DX-291 Phase 5 / DX-296).
 *
 * ## Trigger fan-in
 *
 * `tryMultiAgentDispatch` is the picker — every dispatch decision for
 * a multi-agent repo lands here. It is invoked through one of six
 * paths, all of which route through the scheduler's single-flight
 * mutex (`firePickerWithMutex` in `src/dispatch/scheduler.ts`) so
 * concurrent triggers cannot land a duplicate run against the same
 * `busy` / `assigned` snapshot:
 *
 *   1. **Cron-tick safety net** (DX-368) — per-minute sweep in
 *      `src/cron/sync-and-audit.ts#_sync` calls
 *      `firePickerWithMutex(repo.name)` after the audit-pass. Catches
 *      any event-driven poke the worker dropped; picker converges
 *      within ~60s regardless of which event source missed.
 *   2. **`onReconcileResult`** (DX-288) — chokidar-driven reconcile
 *      reports `dispatchableChanged: true` from `src/issue/reconcile.ts`
 *      → poke debounced by `pendingPokes`, fires the picker on the
 *      next macrotask.
 *   3. **`onAgentRosterChange`** (DX-289) — settings.json file-watch
 *      observes operator toggles (agent enable/disable, broken clear,
 *      schedule edit) → poke debounced by `pendingRosterPokes`, fires
 *      the picker on the next macrotask.
 *   4. **`/api/launch`** — operator-driven dispatch from the dashboard
 *      bypasses the picker entirely; the worker's
 *      `src/worker/dispatch.ts#handleLaunch` invokes `dispatch()`
 *      directly. The picker re-runs via the post-dispatch
 *      `onDispatchTerminated` poke when that dispatch ends, observing
 *      any newly-freed agent slot.
 *   5. **`onDispatchTerminated`** (DX-303 / DX-305) — every dispatch's
 *      `handleStop` calls this from `src/worker/auto-sync.ts` after
 *      the terminal write lands. Required for the freed-agent class of
 *      poke (the dispatched card's eligibility may not flip, so the
 *      reconcile-diff path produces no signal).
 *   6. **Worker boot** (`kickPickerOnceAtBoot` from `src/index.ts`) —
 *      one-shot fire after `bootRehydrate` so a worker booting into a
 *      steady-state queue (no field flips, no roster change) still
 *      gets the first picker run.
 *
 * Plus one bridge — `runWithPickerMutex(repoName, fn)` exports the
 * same single-flight mutex to callers that want to run their own
 * picker closure (the legacy `runSync` direct-picker path used this
 * before DX-290 retired it). No production caller today; kept as a
 * future seam so any non-`runPicker`-registered caller (a one-off
 * dashboard endpoint, a CLI tool) can land under the same mutex.
 *
 * The cron-tick safety net is the convergence guarantor; the other
 * five paths are optimisations that fire faster than the cron. If
 * every event-driven path is wired correctly, the cron tick is a
 * no-op (picker exits immediately — no free agent OR no dispatchable
 * card). If any event is missed, the cron tick recovers the picker
 * within 60s.
 *
 * Glues together every roster + worktree-sync + persona deliverable
 * into the per-tick path the poller calls when its repo has at least
 * one configured agent:
 *
 *   1. Read the agent roster from `<repo>/.danxbot/settings.json`
 *      (`readAgents`).
 *   2. Resolve the busy set (`busyAgents` — DB lookup).
 *   3. Resolve the per-card claim map (`assignedCards`).
 *   4. Loop until either no free agent qualifies OR no unclaimed card
 *      remains:
 *      a. `pickFreeAgent` — first eligible agent by name.
 *      b. `pickCardForAgent` — first unclaimed (or self-claimed) card.
 *      c. Pre-claim DB liveness guard.
 *      d. Tracker dispatch lock acquire.
 *      e. Stamp `assigned_agent` + `dispatch{}` on the candidate's
 *         YAML.
 *      f. Decide dispatch shape based on `getPrepMode(repo.localPath)`
 *         and whether the card was already self-claimed by this agent
 *         (DX-296):
 *           - `combined` mode → ALWAYS dispatch combined shape
 *             (`/danx-prep <id>` + `/danx-next <id>`); `dispatchKind:
 *             "work"` so the prep-verdict route lets the agent
 *             continue past `verdict: "ok"`.
 *           - `separate` mode + fresh card (no pre-existing self-
 *             claim) → dispatch prep-only shape (`/danx-prep <id>`);
 *             `dispatchKind: "prep"` so the route stops on `verdict:
 *             "ok"`. The next tick re-picks the card via the self-
 *             claim branch (`assigned_agent` stays).
 *           - `separate` mode + self-claim by THIS agent → dispatch
 *             combined shape; `dispatchKind: "work"`. This is the
 *             work-pass dispatch that follows the prep pass.
 *      g. Dispatch via `dispatchWithRecovery` (worktree-aware entry
 *         point that routes through persona injection).
 *
 * Why no in-picker conflict-check call: the prep agent (DX-291 P4) runs
 * the file-overlap reasoning DIRECTLY on the agent's worktree as the
 * first step of every dispatch. The legacy `runConflictCheck` precursor
 * and its `applyConflictVerdict` YAML stamp path were retired in DX-297
 * — `conflict_on[]` stamping is now done by the prep-verdict worker
 * route (DX-294) when the agent emits `verdict: "conflict_on"`. The
 * picker just dispatches and lets the verdict shape the outcome.
 *
 * Returns the count of successfully-dispatched agents on this tick (0
 * when no agent was eligible, no card was available, or every
 * candidate hit a guard). The caller decides whether to proceed with
 * downstream legacy-flow logic or short-circuit.
 *
 * Why a separate module: the per-tick orchestration in `index.ts` is
 * already long; isolating the multi-agent branch keeps the two paths
 * independently auditable. A repo with zero configured agents skips
 * this module entirely.
 *
 * Why no `state.teamRunning` mutation: the multi-agent branch
 * intentionally allows N concurrent dispatches per tick. Each
 * dispatch's `busyAgents` slot in the DB is the lock that prevents
 * double-claim; the in-memory teamRunning flag is a single-dispatch
 * concept that doesn't generalize to multi-agent. The poller's
 * `state.polling` flag still gates concurrent ticks.
 */

import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { createLogger } from "../logger.js";
import { dispatch } from "../dispatch/core.js";
import { dispatchWithRecovery } from "../dispatch/recovery-mode.js";
import {
  buildLockHolderInfo,
  guardLiveDispatchForCard,
  runPostDispatchProgressCheck,
  tryAcquireLock,
} from "../dispatch/scheduler.js";
import { assignedCards, busyAgents } from "../agent/agent-locks.js";
import { targetName } from "../config.js";
import type { IssueTracker } from "../issue-tracker/interface.js";
// `createWorktreeManager` is intentionally imported lazily inside
// `tryMultiAgentDispatch` so the poller's heavy unit-test mock surface
// (which partially-mocks `node:child_process` for the OS-spawn path)
// doesn't choke on the worktree manager's module-load `promisify` call
// when this module is statically imported by `src/cron/sync-and-audit.ts`.
// Empty-roster repos pay zero cost; multi-agent integration tests
// supply their own mock via `vi.mock("../agent/worktree-manager.js")`.
import {
  getPrepMode,
  readAgents,
  type AgentRecordWithName,
} from "../settings-file.js";
import type { Issue } from "../issue-tracker/interface.js";
import { isEffectivelyConflicted } from "../issue/effective-conflict-on.js";
import type { RepoContext } from "../types.js";
import type { DispatchKind } from "../agent/agent-types.js";
import {
  buildReconcileTaskBody,
  findOwnedCard,
  pickCardForAgent,
  pickFreeAgent,
  pickFreeAgentCandidates,
} from "./pick-agent.js";
import { recordSystemError } from "../dashboard/system-errors.js";
import { listDispatchesByIssueId } from "../dashboard/dispatches-db.js";
import { listInProgressYamls } from "./local-issues.js";
import {
  buildStartStamp,
} from "./dispatch-liveness-yaml.js";
import {
  clearDispatchAndWrite,
  loadLocal,
  stampAssignedAgentAndWrite,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import type { IssueDispatch } from "../issue-tracker/interface.js";

const log = createLogger("multi-agent-pick");

/**
 * DX-241: predicate for "this card lives on a shared tracker, so a
 * sibling worker could be polling it." The tracker dispatch lock skips
 * locally-only cards (test fixtures with no `external_id`, pre-create
 * drafts that never pushed), and the dispatch's `lockRelease` field
 * skips them too. One predicate keeps both call sites in sync —
 * adding `external_id` normalization (whitespace, future shapes) is a
 * one-line change.
 */
function hasTrackerCoordinate(card: { external_id: string }): boolean {
  return card.external_id.trim() !== "";
}

export interface MultiAgentPickInput {
  repo: RepoContext;
  /**
   * Pre-sorted dispatchable cards from `listDispatchableYamls`. The
   * helper preserves their order; it does not re-rank.
   */
  cards: readonly Issue[];
  /**
   * Every open (non-terminal) issue YAML for the repo (DX-360). Used by
   * the resume-existing-card pre-check: before offering an agent a
   * fresh ToDo from `cards`, the picker scans `openIssues` for a card
   * with `assigned_agent === agent.name` and, if found, dispatches
   * that card with the prior session UUID for `--resume`. The agent
   * itself decides on resumption whether to finish, escalate, or
   * cancel. Superset of `cards` — includes In Progress / Blocked /
   * Review / waiting_on / requires_human cards that `cards` filters
   * out as non-dispatchable. Optional for back-compat with pre-DX-360
   * tests; production callers ALWAYS pass this. When absent, defaults
   * to `cards` (degrades to pre-DX-360 picker behavior — no resume).
   */
  openIssues?: readonly Issue[];
  /**
   * Resolved tracker for this repo. The picker calls
   * `tryAcquireLock` BEFORE dispatching so a sibling worker (local
   * dev / production EC2) polling the same Trello card cannot
   * double-dispatch — Trello-comment lock is the only cross-environment
   * coordinate (DB-backed `busyAgents` is per-environment). On dispatch
   * completion, `dispatch()` releases the lock via the new
   * `lockRelease` field. DX-241.
   *
   * `null` in YAML-only mode (DX-342) — no tracker, no cross-environment
   * lock to acquire. Locally-only cards already skip the lock path via
   * `hasTrackerCoordinate(card) === false`, so a YAML-only repo (where
   * EVERY card has empty `external_id`) sees the same skip path. The
   * picker still dispatches; only the cross-env coordinate is gone.
   */
  tracker: IssueTracker | null;
  now: Date;
}

export interface MultiAgentPickResult {
  /** Count of dispatches successfully kicked off on this tick. */
  dispatched: number;
}

/**
 * Run the multi-agent pick + dispatch loop for one tick.
 *
 * No-op (returns `{dispatched: 0}`) when:
 *   - `agents` map is empty (no roster).
 *   - No card is dispatchable.
 *   - No agent is free + in-schedule.
 *
 * Returns even when one or more dispatches failed to spawn — the
 * caller can re-tick on the next interval. Spawn failures are logged
 * and do not throw.
 *
 * **Per-tick prepMode read-once invariant:** `getPrepMode` is read
 * exactly once at the top of the tick. Mid-tick mode flips
 * (operator dashboard toggle landing while the loop is running) do
 * NOT cause some cards in this tick to dispatch under combined-mode
 * shape and others under separate-mode — every card in this tick
 * sees the same mode.
 *
 * **Separate-mode crash recovery falls back to combined.** If a
 * separate-mode prep-only dispatch crashes BEFORE emitting any
 * verdict, the next tick re-pickup walks the self-claim branch and
 * dispatches the COMBINED task body (kind=work) — so prep RE-RUNS as
 * part of the work pass. Acceptable: the alternative would require a
 * "did prep complete?" YAML field, which the description explicitly
 * forbids ("Simpler state machine, no `prep_completed_at` field" —
 * DX-291 phase 5). Cost is one extra prep run on a clean worktree
 * (cheap by design).
 */
export async function tryMultiAgentDispatch(
  input: MultiAgentPickInput,
): Promise<MultiAgentPickResult> {
  const { repo, cards, tracker, now } = input;
  const openIssues: readonly Issue[] = input.openIssues ?? cards;
  const roster: AgentRecordWithName[] = readAgents(repo.localPath);
  if (roster.length === 0) {
    // No agents configured → caller falls through to the legacy
    // single-card dispatch path. NOT a no-op for the dispatch — the
    // single-card path still runs.
    return { dispatched: 0 };
  }
  // DX-360 — pre-DX-360 we also short-circuited on `cards.length === 0`,
  // but the resume-existing-card path needs to fire even when no fresh
  // ToDo exists (the agent's owned card may be In Progress / Blocked
  // and therefore absent from `cards`). Only short-circuit when there
  // is also nothing to resume.
  if (cards.length === 0 && openIssues.length === 0) {
    return { dispatched: 0 };
  }

  const busy = await busyAgents(repo.name);
  const assigned = await assignedCards(repo.name);
  // DX-296 — per-repo prep mode resolved ONCE per tick. Per-card
  // dispatch shape decisions branch off this + the card's pre-existing
  // `assigned_agent` so a separate-mode self-claim follow-up can use
  // the combined shape (work pass) while the fresh first dispatch
  // uses prep-only.
  const prepMode = getPrepMode(repo.localPath);

  // Heal orphan/duplicate `assigned_agent` stamps BEFORE the picker loop.
  // Two failure modes the picker can't otherwise progress past:
  //   `assigned_agent` names an agent that no longer exists in the
  //   roster (settings.json clobber per DX-281, or operator deletion
  //   without the DX-283 cascade). `pickCardForAgent` treats those
  //   cards as owned-by-another-agent forever → silent skip every
  //   tick. Clear the stamp + dispatch so the card returns to the
  //   unclaimed pool. The co-ownership invariant is retired, but the
  //   not-in-roster case is the one place where a persistent
  //   `assigned_agent` would actually block dispatch — the agent is
  //   gone, so the audit value is meaningless.
  //
  // Duplicate-agent across multiple open cards is NOT cleared anymore:
  // with `assigned_agent` as durable audit, multiple ToDo cards can
  // legitimately name the same agent (re-bounced cards, multi-phase
  // work). The picker dispatches one per tick (an agent that
  // dispatches becomes busy → skipped for the rest of the tick) so
  // there is no double-spawn risk; the other claimed cards simply
  // wait for the next eligible tick.
  const rosterNames = new Set(roster.map((r) => r.name));
  const healedCards: Issue[] = [];
  for (const c of cards) {
    if (c.assigned_agent === null) {
      healedCards.push(c);
      continue;
    }
    if (!rosterNames.has(c.assigned_agent)) {
      log.warn(
        `[${repo.name}] heal: ${c.id} carries orphan assigned_agent=${c.assigned_agent} (not in roster) — clearing claim`,
      );
      const cleared: Issue = { ...c, assigned_agent: null, dispatch: null };
      await writeIssue(repo.localPath, cleared);
      healedCards.push(cleared);
      continue;
    }
    healedCards.push(c);
  }
  const { createWorktreeManager } = await import(
    "../agent/worktree-manager.js"
  );
  const manager = createWorktreeManager();

  // Mutable working set — each successful dispatch removes the card
  // from this list (so the next iteration picks a different one) and
  // adds the agent to `busy` (so `pickFreeAgent` skips them next).
  // Seeded from `healedCards` (post heal pass) so orphan/dup claims are
  // already cleared.
  const remainingCards = [...healedCards];
  let dispatched = 0;

  // DX-306: tick-local set of agents to skip after a tracker error
  // (most commonly a Trello 429) on the lock-acquire path. Without this
  // skip the same agent walks every remaining card in the tick: each
  // 429 splices the card but never marks the agent busy, the loop's
  // `pickFreeAgent` returns the same agent, picks the next card, 429s,
  // repeats — burning Trello quota during the exact window the API is
  // asking for backoff. Per-tick scope is enough; the agent retries on
  // the next tick (cards stay dispatchable, scheduler re-arms naturally).
  // Distinct from `busy` (DB-backed cross-tick) so a transient tracker
  // hiccup doesn't mark the agent busy in the DB.
  const skipAgents = new Set<string>();

  // DX-501: every "drop this card from the rest of the tick" branch
  // below used to do `remainingCards.splice(remainingCards.indexOf(c), 1)`
  // directly. When `c` came from `owned.cards[0]` (reconcile target
  // OR DX-360 owned-card resume) it is NOT in `remainingCards` —
  // `indexOf` returns -1 and the splice deletes the LAST element of
  // `remainingCards` (off-by-one poison that corrupts sibling agents'
  // candidates this tick). Helper guards with an explicit index check
  // so the splice only runs on real membership.
  const removeFromRemaining = (c: Issue): void => {
    const i = remainingCards.indexOf(c);
    if (i !== -1) remainingCards.splice(i, 1);
  };

  // Build the picker's combined skip set per iteration so we don't
  // mutate `busy` itself (callers may inspect it post-loop, and the
  // semantics differ — `busy` is "real DB lock held", `skipAgents` is
  // "skip this tick due to transient tracker error").
  const pickerSkipSet = (): Set<string> => {
    const combined = new Set<string>(busy);
    for (const name of skipAgents) combined.add(name);
    return combined;
  };

  // Card-first picker (DX-369 — replaces the pre-DX-369 agent-first
  // outer loop). Two passes share the per-dispatch `attemptDispatch`
  // helper below.
  //
  //   Pass A — owned-card resume / reconcile. Walk the roster; for each
  //   eligible agent, `findOwnedCard(agent, openIssues)` decides
  //   ownership state. A `single` match dispatches the owned card with
  //   `--resume <sessionUuid>` (DX-360). A `duplicates` match dispatches
  //   a reconcile body (DX-501) so the agent self-heals (release extras
  //   → finish one).
  //
  //   Pass B — card-first fresh pick. Walk `remainingCards` in canonical
  //   pick order. If a card carries an `assigned_agent` stamp (or the
  //   DB-side `assigned` map agrees), route it to THAT agent only — if
  //   the owner is busy / broken / out-of-schedule / already-dispatched
  //   this tick, defer the card to the next tick. Re-routing to a
  //   different free agent would steal the assignment. Unowned cards
  //   fall through to `pickFreeAgent` (alphabetical tiebreak preserved).
  //
  // Why card-first: the pre-DX-369 outer loop iterated agents and
  // filtered cards through `pickCardForAgent(agent)`. When the
  // alphabetically-first free agent could not claim a card owned by a
  // later-named agent, the inner `break` exited the loop before the
  // owner was tried — the DX-368 invariant fired but no dispatch
  // happened (observed: gpt-manager SG-151 stuck behind harry while
  // sage was free, 04:03–04:09 UTC 2026-05-15). The card-first model
  // is structurally immune: each card directly names its own owner so
  // the picker never needs an alphabetical-agent fallback to find them.
  //
  // The DX-368 convergence invariant below is retained as defense-in-
  // depth: it should not fire after this refactor; if it does, the
  // operator gets a loud signal that a new bug has surfaced.

  type DispatchAttempt = "dispatched" | "skipped";

  /**
   * Check whether the agent is eligible to take a dispatch right now —
   * enabled, has the issue-worker capability, not in `busy` or
   * `skipAgents`, not broken, in-schedule. Re-derived per call because
   * `pickerSkipSet()` mutates as Pass A / Pass B dispatches land.
   */
  const isAgentEligibleThisTick = (a: AgentRecordWithName): boolean =>
    pickFreeAgentCandidates({
      roster: [a],
      busy: pickerSkipSet(),
      now,
      repoName: repo.name,
    }).length === 1;

  async function attemptDispatch(args: {
    agent: AgentRecordWithName;
    card: Issue;
    resumeSessionId: string | undefined;
    reconcileOwnedCards: readonly Issue[];
  }): Promise<DispatchAttempt> {
    const { agent, card, resumeSessionId, reconcileOwnedCards } = args;
    const isReconcileDispatch = reconcileOwnedCards.length > 0;

    log.info(
      `[${repo.name}] multi-agent pick: ${agent.name} → ${card.id} (${card.title})`,
    );

    // AC #2 of DX-219 — pre-claim DB liveness guard (ISS-69 ported into
    // the scheduler). The DB-side `busyAgents` lock is per-environment;
    // a host-mode claude reparented to PID 1 after a worker restart
    // still owns this card and the dispatch row still says "running",
    // but the lock would be released on the worker shutdown. Without
    // this guard the picker would assign the SAME card to a NEW agent
    // and melt the working tree. The check skips locally-only cards
    // (no external_id) — those have no inter-worker double-claim risk
    // and the guard's `internalIssueId` branch still covers them via
    // the dispatch row's `issue_id` column.
    if (hasTrackerCoordinate(card)) {
      const live = await guardLiveDispatchForCard({
        repoName: repo.name,
        cardId: card.external_id,
        internalIssueId: card.id,
      });
      if (live) {
        log.info(
          `[${repo.name}] multi-agent pre-claim guard: card ${card.id} (${card.external_id}) has a live PID dispatch — skipping ${agent.name}`,
        );
        removeFromRemaining(card);
        return "skipped";
      }
    }

    // DX-296 — decide dispatch shape + kind BEFORE the YAML stamp so
    // the in-memory `dispatchKind` discriminator is computed against
    // the PRE-stamp `assigned_agent` (the YAML stamp below stamps it
    // to `agent.name`, which would otherwise indistinguish "fresh
    // claim this tick" from "self-claim follow-up tick" inside the
    // route's lifecycle decision). Branch:
    //   - combined mode → ALWAYS work; combined prompt shape.
    //   - separate mode + pre-existing self-claim → work; combined
    //     prompt shape (the work-pass dispatch follows the prep pass
    //     run on the previous tick).
    //   - separate mode + fresh card → prep; prep-only prompt shape.
    const wasPreviouslyClaimedByThisAgent =
      card.assigned_agent === agent.name;
    // DX-501 — reconcile dispatches always run as `kind: "work"` with
    // no prep leg. The reconcile body owns its own pre-work pass
    // (inspecting + releasing the duplicate stamps) before any normal
    // workflow skill runs, so prep would be redundant and the prep-
    // verdict route's "stop on ok" branch would prematurely terminate
    // the dispatch.
    const isPrepOnlyDispatch =
      !isReconcileDispatch &&
      prepMode === "separate" &&
      !wasPreviouslyClaimedByThisAgent;
    const dispatchKind: DispatchKind = isPrepOnlyDispatch ? "prep" : "work";

    // Pre-generate the dispatch UUID + start stamp so the YAML carries
    // the same id we hand to dispatch(). YAML's `dispatch.kind` stays
    // `"work"` regardless — the YAML enum is for poller liveness +
    // TTL, not for route flow control. The route reads
    // `AgentJob.dispatchKind` from the live job for the ok-branch
    // decision (DX-296).
    const dispatchId = randomUUID();
    const startStamp = buildStartStamp(dispatchId, "work", osHostname());

    // DX-241: tracker dispatch lock. Cross-environment coordination —
    // a sibling worker (local dev / production EC2) polling the same
    // tracker card must NOT double-dispatch. The DB-backed
    // `busyAgents` lock is per-environment; the Trello-comment lock is
    // the only coordinate every environment can read. Acquired here
    // (after we know which card to dispatch) and released via
    // `dispatch()`'s onComplete chain (`input.lockRelease` below).
    //
    // Skipped when `hasTrackerCoordinate(card)` is false — locally-only
    // cards (test fixtures with no `external_id`, pre-create drafts
    // that never pushed) have no shared coordinate to lock against.
    // The skip is structurally safe: a card without an external_id can
    // only be polled by THIS worker.
    // DX-342 — also short-circuit the lock acquire path when running
    // in YAML-only mode (no tracker). A YAML-only repo has no shared
    // cross-environment coordinate, so the tracker-comment lock is a
    // no-op by design. Same structural safety as the no-external_id
    // skip: the card is only visible to THIS worker.
    if (hasTrackerCoordinate(card) && tracker !== null) {
      const lockInfo = buildLockHolderInfo({
        targetName,
        repoPath: repo.localPath,
        workspace: "issue-worker",
        dispatchId,
      });
      let lockResult;
      try {
        lockResult = await tryAcquireLock(
          tracker,
          card.external_id,
          lockInfo,
          now,
        );
      } catch (err) {
        // Tracker rejection during lock acquire — most commonly Trello
        // 4xx on a stale/missing card or a network outage. Drop the
        // card from this tick's working set and continue; the next
        // tick will retry. We surface this loudly because a permanent
        // tracker outage would silently churn through every card every
        // tick if every error were swallowed at debug-level.
        //
        // DX-306: also remove THIS AGENT from the picker's eligible
        // pool for the rest of this tick. Without this skip the loop's
        // next `pickFreeAgent` returns the same agent (the lock-acquire
        // throw never set `busy`), the agent walks the next card, 429s,
        // repeats — wasting Trello quota during the backoff window.
        // Effect: one tracker error per agent per tick instead of one
        // per (agent, card) pair. The `lockResult.acquired === false`
        // branch below is "another holder owns the lock," NOT a tracker
        // error — agent stays eligible there (different semantics).
        log.warn(
          `[${repo.name}] multi-agent lock acquire threw for ${card.id} (external_id=${card.external_id}) → ${agent.name}: ${err instanceof Error ? err.message : String(err)} — skipping this tick`,
        );
        skipAgents.add(agent.name);
        removeFromRemaining(card);
        return "skipped";
      }
      if (!lockResult.acquired) {
        const held = lockResult.existing!;
        const ageM = Math.round(
          (now.getTime() - new Date(held.startedAt).getTime()) / 60000,
        );
        log.info(
          `[${repo.name}] multi-agent lock held by ${held.holder}@${held.host} (dispatch ${held.dispatchId}, ${ageM}m old) — skipping ${card.id}`,
        );
        removeFromRemaining(card);
        return "skipped";
      }
      if (lockResult.reclaimed) {
        log.info(
          `[${repo.name}] multi-agent lock reclaimed for ${card.id} (previous holder went stale)`,
        );
      }
    }

    // Stamp `assigned_agent` BEFORE dispatch so the next tick's
    // `assignedCards()` lookup sees the claim even if dispatch()
    // throws mid-spawn.
    let stamped: Issue;
    try {
      const claimed = await stampAssignedAgentAndWrite(
        repo.localPath,
        card,
        agent.name,
      );
      stamped = await stampDispatchAndWrite(
        repo.localPath,
        claimed,
        startStamp,
      );
    } catch (err) {
      log.error(
        `[${repo.name}] multi-agent stamp failed for ${card.id} → ${agent.name}`,
        err,
      );
      removeFromRemaining(card);
      return "skipped";
    }

    // DX-296 — task body branches on the dispatch shape:
    //   - prep-only (separate mode, fresh card) → just `/danx-prep <id>`.
    //     The skill emits a verdict; the route stops the dispatch on
    //     `verdict: "ok"` because `dispatchKind === "prep"`.
    //   - combined (combined mode, OR separate-mode self-claim follow-
    //     up) → `/danx-prep <id>` followed by `/danx-next <id>`. The
    //     route lets the dispatch run past `verdict: "ok"` because
    //     `dispatchKind === "work"`, and the agent proceeds straight
    //     into the work workflow in the same session.
    // Enumerate in-progress sibling cards so the prep agent does NOT
    // have to search the issues directory itself. The worker resolves
    // the list once and ships it as a single line in the prompt body.
    // Excludes the candidate (it's about to be flipped to In Progress
    // by `dispatch()`'s auto-flip). Sliced at 20 to keep the prompt
    // line bounded — pathological repos with 50+ concurrent dispatches
    // would otherwise spam the prompt.
    let inProgressSiblings: string[] = [];
    try {
      const siblings = await listInProgressYamls(
        repo.localPath,
        repo.issuePrefix,
      );
      inProgressSiblings = siblings
        .map((s) => s.id)
        .filter((id) => id !== stamped.id)
        .slice(0, 20);
    } catch (err) {
      log.warn(
        `[${repo.name}] failed to enumerate in-progress siblings for ${stamped.id} — proceeding with empty list`,
        err,
      );
    }
    const siblingsLine =
      inProgressSiblings.length > 0
        ? `In Progress cards: [${inProgressSiblings.join(", ")}]\n\n`
        : "In Progress cards: []\n\n";

    const taskBody = isReconcileDispatch
      ? buildReconcileTaskBody(agent.name, reconcileOwnedCards)
      : isPrepOnlyDispatch
        ? `/danx-prep ${stamped.id}`
        : `/danx-prep ${stamped.id}\n\n/danx-next ${stamped.id}`;
    // Prepend the siblings line to non-reconcile dispatches. Reconcile
    // builds its own task body and operates on owned cards only — no
    // need to surface siblings there.
    const task = isReconcileDispatch ? taskBody : siblingsLine + taskBody;

    try {
      await dispatchWithRecovery(
        {
          repo,
          task,
          workspace: "issue-worker",
          overlay: {},
          apiDispatchMeta: {
            trigger: "trello",
            metadata: {
              cardId: stamped.external_id,
              cardName: stamped.title,
              cardUrl: `https://trello.com/c/${stamped.external_id}`,
              listId: repo.trello?.todoListId ?? "",
              listName: "ToDo",
            },
          },
          dispatchId,
          issueId: stamped.id,
          agent: { name: agent.name, bio: agent.bio },
          // DX-360 — resume the agent's prior session when the picker
          // resolved via `findOwnedCard`. `claude --resume <uuid>`
          // loads the JSONL transcript so the agent inherits full
          // context (prior tool calls, scratch state, etc.) and the
          // task body's `/danx-prep` + `/danx-next` becomes the next
          // turn in the same conversation. Undefined for fresh picks
          // and for owned-card cases where no prior dispatch row
          // carried a sessionUuid (rare — happens when the prior
          // dispatch died before claude wrote its first JSONL entry).
          resumeSessionId,
          // DX-296 — discriminator the prep-verdict route reads via
          // `getActiveJob(dispatchId)?.dispatchKind` on every verdict
          // POST. Stamped on `AgentJob` at construction time inside
          // spawnAgent so it is race-free against the agent's first
          // MCP call.
          dispatchKind,
          // DX-241: dispatch() releases the tracker lock in its
          // onComplete chain (success + failure). Skipped for
          // locally-only cards (no external_id, no shared coordinate).
          //
          // DX-342 — also skipped when the worker is running in
          // YAML-only mode (`tracker === null`). A card may carry a
          // stale `external_id` from a prior tracker window; without
          // a live tracker there is no comment-lock to release.
          lockRelease:
            hasTrackerCoordinate(stamped) && tracker !== null
              ? { tracker, externalId: stamped.external_id }
              : undefined,
          pairedWriteYaml: {
            // Cleanup paths re-read the YAML so they observe the
            // post-stamp state. Post-DX-547 the writer upserts the DB
            // row BEFORE `writeFileSync`, so DB-backed `loadLocal`
            // returns the freshly-stamped shape immediately.
            write: async (pid: number) => {
              const enriched: IssueDispatch = { ...startStamp, pid };
              const fresh = await loadLocal(
                repo.localPath,
                stamped.id,
                repo.issuePrefix,
              );
              if (!fresh) {
                throw new Error(
                  `multi-agent paired-write: YAML for ${stamped.id} disappeared during dispatch`,
                );
              }
              await stampDispatchAndWrite(repo.localPath, fresh, enriched);
            },
            clear: async () => {
              const fresh = await loadLocal(
                repo.localPath,
                stamped.id,
                repo.issuePrefix,
              );
              if (fresh && fresh.dispatch !== null) {
                await clearDispatchAndWrite(repo.localPath, fresh);
              }
            },
          },
          onComplete: async (job) => {
            // Clear the YAML's `dispatch{}` block so the next tick
            // sees a clean slate. The `assigned_agent` stamp survives
            // (the next dispatch by the same agent re-claims it via
            // pickCardForAgent's "self-claim allowed" branch).
            const fresh = await loadLocal(
              repo.localPath,
              stamped.id,
              repo.issuePrefix,
            );
            if (fresh && fresh.dispatch !== null) {
              await clearDispatchAndWrite(repo.localPath, fresh);
            }

            // DX-296 — branch the post-dispatch behaviour on the prep
            // verdict + dispatch kind. The prep-verdict route already
            // applied any YAML / settings side-effect for non-ok
            // verdicts (`conflict_on[]` append, `Blocked` stamp,
            // `agents.<name>.broken` stamp), so the picker MUST NOT
            // run the card-progress check on those — the card was
            // never expected to leave ToDo.
            //
            // Skip card-progress check when ANY of:
            //   - prep verdict is non-ok (route already stamped the card).
            //   - prep verdict is ok AND dispatchKind is "prep" (separate-
            //     mode prep-only dispatch — work pass not yet started).
            //
            // Run the check otherwise (combined-mode work dispatch, or
            // separate-mode self-claim work pass — both expect card
            // progress). Skip when locally-only or prep verdict already
            // shaped the outcome (existing).
            const verdict = job.prepVerdict;
            const isPrepOnlyOk =
              verdict?.verdict === "ok" && job.dispatchKind === "prep";
            const isNonOkVerdict =
              verdict !== undefined && verdict.verdict !== "ok";
            const skipCardProgressForPrep = isPrepOnlyOk || isNonOkVerdict;

            // AC #4 of DX-219 — post-dispatch card-progress check +
            // CRITICAL_FAILURE halt ported into the multi-agent path.
            // Skip locally-only cards (no external_id, no tracker round-
            // trip is possible). The legacy `runSync` single-card path's
            // `checkCardProgressedOrHalt` ran for every trello-trigger
            // dispatch; this is the multi-agent equivalent. Token-burn
            // safeguard against an env-level blocker (MCP/Bash/auth
            // failing) that lets the agent "finish" without moving the
            // card. The next poll tick reads the flag and halts.
            //
            // DX-296 — skip when the dispatch was a prep-only run
            // (separate prepMode) OR when prep returned a non-`ok`
            // verdict. In both cases the work-pass hasn't run yet and
            // the card legitimately stays in ToDo — see
            // `skipCardProgressForPrep` above.
            //
            // DX-322 — also skip when the dispatch ended `throttled`.
            // The rate-limit throttle handler already wrote a throttle
            // flag with `resume_at` to the same flag-file path; the
            // post-dispatch check would write a
            // `source: "post-dispatch-check"` payload (no `resume_at`)
            // that OVERWRITES the throttle flag → poller halt-gate
            // degrades from "auto-clear past resume_at" to "permanent
            // CRITICAL_FAILURE" → exactly the failure mode DX-322
            // exists to prevent. The card naturally stays in ToDo for
            // a throttled dispatch (no work happened), so the check
            // would always fire here without the guard.
            // DX-501 — reconcile dispatches do not necessarily move the
            // dispatch-target card off ToDo: the agent may release that
            // very card and continue on a different one. Skip the
            // progress check; the reconcile body owns its own success
            // semantics.
            if (
              hasTrackerCoordinate(stamped) &&
              tracker !== null &&
              !skipCardProgressForPrep &&
              !isReconcileDispatch &&
              job.status !== "throttled"
            ) {
              await runPostDispatchProgressCheck({
                repo,
                cardId: stamped.external_id,
                jobId: job.id,
                jobStatus: job.status,
                jobSummary: job.summary,
              });
            }

            // DX-366 — per-agent + per-card failure cooldowns and the
            // per-card N-strike auto-Blocked path are RETIRED. Card-
            // level fault handling is now solely the agent's
            // responsibility (set Blocked / waiting_on / requires_human
            // in-session) and agent-level fault handling lives on the
            // strike accumulator (DX-365) which stamps
            // `agents.<name>.broken` after 3 consecutive failures so
            // the picker drops the agent from the pool. No picker-side
            // accounting remains.
          },
        },
        { agentName: agent.name, manager },
        { dispatch },
      );
    } catch (err) {
      log.error(
        `[${repo.name}] multi-agent dispatch failed for ${card.id} → ${agent.name}`,
        err,
      );
      // DX-366 — picker-side failure cooldowns retired. The strike
      // accumulator (DX-365) records the failure on the dispatch row;
      // after 3 consecutive failures the agent gets
      // `agents.<name>.broken` stamped and the picker drops them from
      // the pool. No card-level cooldown stamp here — the next tick
      // is free to re-pick the same card with the same agent.
      // Dispatch threw post-stamp → YAML carries a `dispatch:` block
      // pointing at a dispatchId that never made it into the DB. Without
      // clearing, every subsequent tick's `listDispatchableYamls` filter
      // (`if (i.dispatch !== null) return false`) rejects the card
      // permanently. The accumulated stale blocks were the root cause of
      // a poller-idle-with-ToDo-queue stall seen 2026-05-11.
      try {
        // Re-read post-stamp state and clear the dispatch block. The
        // synchronous writer (DX-547) leaves the DB row consistent the
        // moment `stampDispatchAndWrite` resolves, so DB-backed
        // `loadLocal` returns the right shape with no race.
        const fresh = await loadLocal(
          repo.localPath,
          stamped.id,
          repo.issuePrefix,
        );
        if (fresh && fresh.dispatch !== null) {
          await clearDispatchAndWrite(repo.localPath, fresh);
        }
      } catch (clearErr) {
        log.error(
          `[${repo.name}] multi-agent post-fail clearDispatch failed for ${card.id}`,
          clearErr,
        );
      }
      removeFromRemaining(card);
      return "skipped";
    }

    // Mark this slot taken so the next pass / iteration picks a
    // different agent + card. The DB-side `busyAgents` lookup will see
    // the same value on the NEXT tick (the dispatch row was inserted by
    // `dispatch()` synchronously).
    busy.add(agent.name);
    assigned.set(stamped.id, agent.name);
    // DX-360 — owned-card resume may have selected a card NOT in
    // `remainingCards` (e.g. status=In Progress filtered out of the
    // dispatchable list). `indexOf` returns -1 → naïve `splice(-1, 1)`
    // would remove the LAST element of `remainingCards` (off-by-one
    // poison). Guard with the explicit index check.
    const idx = remainingCards.indexOf(card);
    if (idx !== -1) remainingCards.splice(idx, 1);
    dispatched++;
    return "dispatched";
  }

  // Pass A — owned-card resume / reconcile.
  //
  // Walk the roster (NOT the dispatchable cards list) so an agent
  // whose owned card is non-dispatchable (status=In Progress / Blocked
  // / Review / waiting_on / requires_human) still gets resumed. The
  // agent itself decides on resumption whether to finish, escalate, or
  // cancel — see `findOwnedCard`'s doc block.
  //
  // `handledOwnedCardIds` tracks every card touched here (resume
  // target, reconcile target, reconcile siblings) so Pass B does not
  // double-consider them.
  const handledOwnedCardIds = new Set<string>();
  for (const member of roster) {
    if (!isAgentEligibleThisTick(member)) continue;
    const owned = findOwnedCard(member.name, openIssues);
    if (owned.kind === "none") continue;
    let card: Issue;
    let reconcileOwnedCards: readonly Issue[] = [];
    let resumeSessionId: string | undefined;
    if (owned.kind === "single") {
      // conflict_on partner-terminal gate. Symmetric with the
      // listDispatchableYamls filter that gates Pass B fresh picks
      // (`isEffectivelyConflicted` in `src/poller/local-issues.ts`).
      // Without this check, an agent owning a card whose conflict_on
      // partner is non-terminal gets re-resumed every tick; the prep
      // skill re-emits the `conflict_on` verdict, dispatch ends,
      // next tick repeats — infinite loop burning tokens (observed on
      // murphy DX-547 / phil DX-548 vs dani DX-546, 2026-05-15). The
      // duplicates branch below intentionally skips this gate: the
      // reconcile body's purpose is to RELEASE excess `assigned_agent`
      // stamps, which is valuable even when a partner is non-terminal.
      if (isEffectivelyConflicted(owned.card, openIssues)) {
        log.info(
          `[${repo.name}] multi-agent pick (defer resume): ${member.name} → ${owned.card.id} — conflict_on partner non-terminal; skipping this tick`,
        );
        continue;
      }
      card = owned.card;
      // Latest dispatch's session UUID, newest-first. Skip rows whose
      // sessionUuid is empty/null (failed-before-session-create rows).
      // A missing UUID degrades to a fresh session — claude --resume
      // is the optimisation, not a hard requirement.
      try {
        const prior = await listDispatchesByIssueId(owned.card.id);
        const withSession = prior.find(
          (d) => d.sessionUuid !== null && d.sessionUuid !== "",
        );
        resumeSessionId = withSession?.sessionUuid ?? undefined;
      } catch (err) {
        log.warn(
          `[${repo.name}] resume-lookup failed for ${owned.card.id}: ${err instanceof Error ? err.message : String(err)} — proceeding without --resume`,
        );
      }
      log.info(
        `[${repo.name}] multi-agent pick (resume): ${member.name} → ${owned.card.id} (status=${owned.card.status})${resumeSessionId ? ` --resume ${resumeSessionId.slice(0, 8)}` : ""}`,
      );
    } else {
      // DX-501 — duplicate ownership: dispatch a reconcile body so the
      // agent self-heals. Dispatch target is the first duplicate in
      // input order; the reconcile body enumerates ALL duplicates so
      // the agent walks every card and recovers the invalid ones in-
      // session.
      reconcileOwnedCards = owned.cards;
      card = owned.cards[0];
      log.warn(
        `[${repo.name}] multi-agent pick (reconcile): ${member.name} owns ${owned.cards.length} open cards (${owned.cards.map((c) => c.id).join(", ")}) — dispatching reconcile task on ${card.id} (status=${card.status})`,
      );
    }
    handledOwnedCardIds.add(card.id);
    for (const c of reconcileOwnedCards) handledOwnedCardIds.add(c.id);
    await attemptDispatch({
      agent: member,
      card,
      resumeSessionId,
      reconcileOwnedCards,
    });
  }

  // Pass B — card-first fresh pick.
  //
  // Iterate `remainingCards` in canonical pick order (priority DESC +
  // ICE total DESC + FIFO — `listDispatchableYamls`). For each card:
  //   - already-touched by Pass A → drop and continue.
  //   - has a named owner → route to that owner only. If owner is busy
  //     / broken / out-of-schedule / already-dispatched-this-tick,
  //     defer the card to the next tick. NEVER re-route to a different
  //     free agent.
  //   - no owner → pick the first eligible agent (alphabetical).
  //   - no free agents → break (next tick will retry).
  //
  // The snapshot iteration (`[...remainingCards]`) lets
  // `attemptDispatch`'s success path mutate `remainingCards` in place
  // without disrupting iteration order.
  for (const card of [...remainingCards]) {
    if (!remainingCards.includes(card)) {
      // attemptDispatch already removed this card (success or guard
      // skip in a prior Pass B iteration / Pass A).
      continue;
    }
    if (handledOwnedCardIds.has(card.id)) {
      // Pass A already touched this card (resume target, reconcile
      // target, or reconcile sibling). Drop so it is not re-considered.
      removeFromRemaining(card);
      continue;
    }
    const yamlOwner = card.assigned_agent ?? null;
    const dbOwner = assigned.get(card.id) ?? null;
    if (
      yamlOwner !== null &&
      dbOwner !== null &&
      yamlOwner !== dbOwner
    ) {
      // YAML and DB disagree on owner — usually a chokidar read-your-
      // writes race. Defer this tick; the next tick reads a settled
      // state.
      log.warn(
        `[${repo.name}] card ${card.id} has conflicting ownership claims (yaml=${yamlOwner}, db=${dbOwner}) — skipping this tick`,
      );
      removeFromRemaining(card);
      continue;
    }
    const owner = yamlOwner ?? dbOwner;

    let agent: AgentRecordWithName | null;
    if (owner !== null) {
      const ownerRecord = roster.find((r) => r.name === owner) ?? null;
      if (ownerRecord === null) {
        // The orphan-`assigned_agent` heal pass above should have
        // cleared this. Belt-and-braces — if the heal missed (race
        // with operator settings edit, agent deleted mid-tick), defer
        // and let the next tick re-heal.
        log.warn(
          `[${repo.name}] card ${card.id} owned by ${owner} (not in roster) — skipping this tick`,
        );
        removeFromRemaining(card);
        continue;
      }
      if (!isAgentEligibleThisTick(ownerRecord)) {
        // Owner busy / broken / out-of-schedule / already-dispatched
        // this tick → card waits. Operator action (clear broken,
        // re-enable agent, etc.) unblocks the next tick.
        log.info(
          `[${repo.name}] card ${card.id} owned by ${ownerRecord.name} but agent unavailable this tick — deferring`,
        );
        removeFromRemaining(card);
        continue;
      }
      agent = ownerRecord;
    } else {
      agent = pickFreeAgent({
        roster,
        busy: pickerSkipSet(),
        now,
        repoName: repo.name,
      });
      if (agent === null) break;
    }

    await attemptDispatch({
      agent,
      card,
      resumeSessionId: undefined,
      reconcileOwnedCards: [],
    });
  }

  // DX-368 — post-loop convergence invariant. The loop's exit
  // conditions (`pickFreeAgent` returns null OR `pickCardForAgent`
  // returns null) imply that at exit, no remaining free agent can
  // claim any remaining card. Firing this assertion means the loop
  // broke prematurely — a real picker bug. Surface loudly so the
  // operator sees the divergence on the dashboard banner without
  // grepping logs.
  //
  // `pickerSkipSet()` already accounts for agents we marked busy
  // during this tick AND agents we skipped on transient tracker
  // errors (DX-306). `remainingCards` reflects every card we did NOT
  // successfully dispatch this tick.
  //
  // The claim-eligibility iteration is required: `pickFreeAgent`'s
  // first-by-name tiebreak picks alice; if alice can't claim any
  // remaining card but bob can, the loop's `if (card === null) break`
  // exits without trying bob. The invariant catches that case while
  // staying silent for legitimately-blocked states (every remaining
  // card is owned by an agent now busy, lock-held cards we couldn't
  // re-acquire this tick, etc.).
  const remainingFreeAgents = pickFreeAgentCandidates({
    roster,
    busy: pickerSkipSet(),
    now,
    repoName: repo.name,
  });
  if (remainingFreeAgents.length > 0 && remainingCards.length > 0) {
    const reclaimableByAnyFreeAgent = remainingFreeAgents.some(
      (a) =>
        pickCardForAgent({
          cards: remainingCards,
          agentName: a.name,
          assigned,
        }) !== null,
    );
    if (reclaimableByAnyFreeAgent) {
      const freeNames = remainingFreeAgents.map((a) => a.name);
      const cardIds = remainingCards.map((c) => c.id);
      const message = `dispatch invariant violated: free=[${freeNames.join(",")}] cards=[${cardIds.join(",")}] — picker did not converge`;
      log.error(`[${repo.name}] ${message}`);
      recordSystemError({
        source: "poller",
        repo: repo.name,
        message,
        details: {
          freeAgents: freeNames,
          dispatchableCards: cardIds,
        },
      });
    }
  }

  return { dispatched };
}
