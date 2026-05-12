/**
 * Multi-agent pick + dispatch loop (DX-200 / multi-worker dispatch
 * epic DX-158 Phase 5; rewired by DX-291 Phase 5 / DX-296).
 *
 * Glues together every roster + worktree-validate + persona deliverable
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
import { escalateOnRepeatedFailures } from "../dispatch/failure-escalation.js";
import {
  clearQuarantineForSuccess,
  isAgentQuarantined,
  isCardQuarantined,
  quarantineAgent,
  quarantineCard,
} from "../dispatch/quarantine.js";
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
import type { RepoContext } from "../types.js";
import type { DispatchKind } from "../agent/agent-types.js";
import { pickCardForAgent, pickFreeAgent } from "./pick-agent.js";
import {
  buildStartStamp,
} from "./dispatch-liveness-yaml.js";
import {
  clearDispatchAndWrite,
  loadLocalFromDisk,
  stampAssignedAgentAndWrite,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import type { IssueDispatch } from "../issue-tracker/interface.js";

const log = createLogger("multi-agent-pick");

/**
 * DX-241: predicate for "this card lives on a shared tracker, so a
 * sibling worker could be polling it." The tracker dispatch lock skips
 * locally-only cards (memory-tracker fixtures, pre-create drafts that
 * never pushed), and the dispatch's `lockRelease` field skips them too.
 * One predicate keeps both call sites in sync — adding `external_id`
 * normalization (whitespace, future shapes) is a one-line change.
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
   * Resolved tracker for this repo. The picker calls
   * `tryAcquireLock` BEFORE dispatching so a sibling worker (local
   * dev / production EC2) polling the same Trello card cannot
   * double-dispatch — Trello-comment lock is the only cross-environment
   * coordinate (DB-backed `busyAgents` is per-environment). On dispatch
   * completion, `dispatch()` releases the lock via the new
   * `lockRelease` field. DX-241.
   */
  tracker: IssueTracker;
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
  const roster: AgentRecordWithName[] = readAgents(repo.localPath);
  if (roster.length === 0) {
    // No agents configured → caller falls through to the legacy
    // single-card dispatch path. NOT a no-op for the dispatch — the
    // single-card path still runs.
    return { dispatched: 0 };
  }
  if (cards.length === 0) {
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

  // Build the picker's combined skip set per iteration so we don't
  // mutate `busy` itself (callers may inspect it post-loop, and the
  // semantics differ — `busy` is "real DB lock held", `skipAgents` is
  // "skip this tick due to transient tracker error").
  const pickerSkipSet = (): Set<string> => {
    const combined = new Set<string>(busy);
    for (const name of skipAgents) combined.add(name);
    return combined;
  };

  while (remainingCards.length > 0) {
    const agent = pickFreeAgent({
      roster,
      busy: pickerSkipSet(),
      now,
      repoName: repo.name,
    });
    if (agent === null) break;
    const card = pickCardForAgent({
      cards: remainingCards,
      agentName: agent.name,
      assigned,
    });
    if (card === null) {
      // No remaining card the agent can claim. Other agents in the
      // roster might still find candidates — but with the picker's
      // first-by-name tiebreak, every later agent sees the same
      // cards minus the one we couldn't claim, so they'd hit the same
      // wall. Bail out.
      break;
    }

    // AC #2 of DX-221 — per-agent + per-card quarantine cooldown.
    // Replaces the deleted per-poller backoff window. A
    // freshly-failed agent + a freshly-failed card each get a short
    // cooldown so the picker does not hot-loop against an env-level
    // blocker; cleared on a successful dispatch (clearQuarantineForSuccess
    // in onComplete). See src/dispatch/quarantine.ts for the contract.
    if (
      isAgentQuarantined({
        repoName: repo.name,
        agentName: agent.name,
        now: now.getTime(),
      })
    ) {
      log.info(
        `[${repo.name}] multi-agent pick: ${agent.name} is quarantined — skipping this tick`,
      );
      skipAgents.add(agent.name);
      continue;
    }
    if (
      isCardQuarantined({
        repoName: repo.name,
        cardId: card.id,
        now: now.getTime(),
      })
    ) {
      log.info(
        `[${repo.name}] multi-agent pick: ${card.id} is quarantined — skipping`,
      );
      remainingCards.splice(remainingCards.indexOf(card), 1);
      continue;
    }

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
        remainingCards.splice(remainingCards.indexOf(card), 1);
        continue;
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
    const isPrepOnlyDispatch =
      prepMode === "separate" && !wasPreviouslyClaimedByThisAgent;
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
    // cards (memory-tracker fixtures, pre-create drafts that never
    // pushed) have no shared coordinate to lock against. The skip is
    // structurally safe: a card without an external_id can only be
    // polled by THIS worker.
    if (hasTrackerCoordinate(card)) {
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
        remainingCards.splice(remainingCards.indexOf(card), 1);
        continue;
      }
      if (!lockResult.acquired) {
        const held = lockResult.existing!;
        const ageM = Math.round(
          (now.getTime() - new Date(held.startedAt).getTime()) / 60000,
        );
        log.info(
          `[${repo.name}] multi-agent lock held by ${held.holder}@${held.host} (dispatch ${held.dispatchId}, ${ageM}m old) — skipping ${card.id}`,
        );
        remainingCards.splice(remainingCards.indexOf(card), 1);
        continue;
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
      remainingCards.splice(remainingCards.indexOf(card), 1);
      continue;
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
    const task = isPrepOnlyDispatch
      ? `/danx-prep ${stamped.id}`
      : `/danx-prep ${stamped.id}\n\n/danx-next ${stamped.id}`;

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
          // DX-296 — discriminator the prep-verdict route reads via
          // `getActiveJob(dispatchId)?.dispatchKind` on every verdict
          // POST. Stamped on `AgentJob` at construction time inside
          // spawnAgent so it is race-free against the agent's first
          // MCP call.
          dispatchKind,
          // DX-241: dispatch() releases the tracker lock in its
          // onComplete chain (success + failure). Skipped for
          // locally-only cards (no external_id, no shared coordinate).
          lockRelease: hasTrackerCoordinate(stamped)
            ? { tracker, externalId: stamped.external_id }
            : undefined,
          pairedWriteYaml: {
            // DX-284: cleanup paths re-read the YAML from DISK, not
            // the DB-backed `loadLocal`. `writeIssue`'s mirror ack
            // uses an 8s `awaitMirror` timeout that frequently lapses
            // under chokidar pressure (observed: "awaitMirror timed
            // out for danxbot/DX-260"). When it does, `loadLocal`
            // returns the PRE-stamp DB shape, the `fresh.dispatch !==
            // null` guard evaluates false, the clear is skipped, and
            // the orphan `dispatch{pid:0}` block accumulates on disk.
            // Disk reads bypass the mirror entirely.
            write: async (pid: number) => {
              const enriched: IssueDispatch = { ...startStamp, pid };
              const fresh = loadLocalFromDisk(
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
              const fresh = loadLocalFromDisk(
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
            //
            // DX-284: disk read (see pairedWriteYaml.write comment).
            const fresh = loadLocalFromDisk(
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
            if (
              hasTrackerCoordinate(stamped) &&
              !skipCardProgressForPrep
            ) {
              await runPostDispatchProgressCheck({
                repo,
                cardId: stamped.external_id,
                jobId: job.id,
                jobStatus: job.status,
                jobSummary: job.summary,
              });
            }

            // AC #1 + AC #2 of DX-221 — per-card consecutive-failure
            // tally + per-agent/per-card quarantine. Both replace
            // protections that lived in the deleted poller-tick state
            // (per-poller failure counter + per-poller backoff window).
            //
            // DX-296 — skip quarantine accounting on prep abort. The
            // prep-verdict route already stamped `agents.<name>.broken`
            // so the picker filters this agent out next tick; the card
            // itself is innocent (the env was broken on the agent's
            // worktree). Quarantining the card would punish a future
            // healthy agent for an unrelated env failure.
            const isPrepAbort = verdict?.verdict === "abort";
            if (!isPrepAbort) {
              if (job.status === "completed") {
                clearQuarantineForSuccess({
                  repoName: repo.name,
                  agentName: agent.name,
                  cardId: stamped.id,
                });
              } else if (job.status === "failed") {
                quarantineAgent({
                  repoName: repo.name,
                  agentName: agent.name,
                  reason: `dispatch ${job.id} failed on ${stamped.id}: ${job.summary || "(no summary)"}`,
                });
                quarantineCard({
                  repoName: repo.name,
                  cardId: stamped.id,
                  reason: `dispatch ${job.id} failed: ${job.summary || "(no summary)"}`,
                });
                try {
                  const fresh = loadLocalFromDisk(
                    repo.localPath,
                    stamped.id,
                    repo.issuePrefix,
                  );
                  if (fresh) {
                    await escalateOnRepeatedFailures({
                      repoName: repo.name,
                      repoLocalPath: repo.localPath,
                      internalIssueId: stamped.id,
                      card: fresh,
                    });
                  }
                } catch (escErr) {
                  log.error(
                    `[${repo.name}] escalation check threw for ${stamped.id}`,
                    escErr,
                  );
                }
              }
            }
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
      // AC #2 of DX-221 — dispatch threw before `onComplete` would
      // ever fire (spawn-fail, worktree validation throw, etc.).
      // Quarantine both sides so the next picker tick does not
      // hot-loop against the same broken pairing.
      const errMsg = err instanceof Error ? err.message : String(err);
      quarantineAgent({
        repoName: repo.name,
        agentName: agent.name,
        reason: `dispatch threw on ${card.id}: ${errMsg}`,
      });
      quarantineCard({
        repoName: repo.name,
        cardId: card.id,
        reason: `dispatch threw: ${errMsg}`,
      });
      // Dispatch threw post-stamp → YAML carries a `dispatch:` block
      // pointing at a dispatchId that never made it into the DB. Without
      // clearing, every subsequent tick's `listDispatchableYamls` filter
      // (`if (i.dispatch !== null) return false`) rejects the card
      // permanently. The accumulated stale blocks were the root cause of
      // a poller-idle-with-ToDo-queue stall seen 2026-05-11.
      try {
        // DX-284: disk read instead of `loadLocal`. The
        // `stampDispatchAndWrite` we just ran above may have lost its
        // `awaitMirror` race (the very symptom that gets us here
        // — `dispatch()` throwing post-stamp). Reading from disk
        // bypasses the DB-mirror lag so the clear actually runs.
        const fresh = loadLocalFromDisk(
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
      remainingCards.splice(remainingCards.indexOf(card), 1);
      continue;
    }

    // Mark this slot taken so the next iteration picks a different
    // agent + card. The DB-side `busyAgents` lookup will see the same
    // value on the NEXT tick (the dispatch row was inserted by
    // `dispatch()` synchronously).
    busy.add(agent.name);
    assigned.set(stamped.id, agent.name);
    remainingCards.splice(remainingCards.indexOf(card), 1);
    dispatched++;
  }

  return { dispatched };
}
