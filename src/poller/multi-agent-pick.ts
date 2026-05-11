/**
 * Multi-agent pick + dispatch loop (DX-200 / multi-worker dispatch
 * epic DX-158 Phase 5).
 *
 * Glues together every Phase 1-4 deliverable into the per-tick path
 * the poller calls when its repo has at least one configured agent:
 *
 *   1. Read the agent roster from `<repo>/.danxbot/settings.json`
 *      (`readAgents`).
 *   2. Resolve the busy set (`busyAgents` — Phase 1's DB lookup).
 *   3. Resolve the per-card claim map (`assignedCards`).
 *   4. Resolve the in-progress sibling list (already in hand —
 *      `listInProgressYamls` ran upstream).
 *   5. Loop until either no free agent qualifies OR no unclaimed card
 *      remains:
 *      a. `pickFreeAgent` — first eligible agent by name.
 *      b. `pickCardForAgent` — first unclaimed (or self-claimed) card.
 *      c. If at least one OTHER agent is in-progress AND
 *         `agentDefaults.conflictCheckEnabled !== false`, spawn a
 *         conflict-check dispatch (Phase 5's
 *         `runConflictCheck`). Conservative: any failure → treat as
 *         conflict.
 *      d. On conflict: stamp `blocked` on the candidate's YAML with
 *         `by: [<overlapping-id>]` and skip — the poller will not
 *         dispatch the card this tick. Operator can clear via the
 *         dashboard.
 *      e. On no-conflict: stamp `assigned_agent` on the candidate's
 *         YAML, then dispatch via `dispatchWithRecovery` (Phase 3's
 *         worktree-aware entry point that ALSO routes through Phase
 *         4's persona injection).
 *
 * Returns the count of successfully-dispatched agents on this tick (0
 * when no agent was eligible, no card was available, or every
 * candidate was conflict-blocked). The caller decides whether to
 * proceed with downstream legacy-flow logic or short-circuit.
 *
 * Why a separate module: the per-tick orchestration in `index.ts` is
 * already long; isolating the multi-agent branch keeps the two paths
 * independently auditable. A repo with zero configured agents skips
 * this module entirely and behaves like Phase 4 / pre-Phase-5.
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
import { resolve } from "node:path";
import { createLogger } from "../logger.js";
import { dispatch } from "../dispatch/core.js";
import { runConflictCheck } from "../dispatch/conflict-check.js";
import { dispatchWithRecovery } from "../dispatch/recovery-mode.js";
import {
  buildLockHolderInfo,
  guardLiveDispatchForCard,
  runPostDispatchProgressCheck,
  tryAcquireLock,
} from "../dispatch/scheduler.js";
import {
  assignedCards,
  busyAgents,
  liveDispatchIssueIds,
} from "../agent/agent-locks.js";
import { targetName } from "../config.js";
import type { IssueTracker } from "../issue-tracker/interface.js";
// `createWorktreeManager` is intentionally imported lazily inside
// `tryMultiAgentDispatch` so the poller's heavy unit-test mock surface
// (which partially-mocks `node:child_process` for the OS-spawn path)
// doesn't choke on the worktree manager's module-load `promisify` call
// when this module is statically imported by `src/poller/index.ts`.
// Empty-roster repos pay zero cost; multi-agent integration tests
// supply their own mock via `vi.mock("../agent/worktree-manager.js")`.
import {
  isConflictCheckEnabled,
  readAgents,
  type AgentRecordWithName,
} from "../settings-file.js";
import type { Issue, WaitingOn } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";
import { pickCardForAgent, pickFreeAgent } from "./pick-agent.js";
import {
  buildStartStamp,
} from "./dispatch-liveness-yaml.js";
import {
  clearDispatchAndWrite,
  loadLocal,
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
   * Currently-in-progress siblings — input to the conflict-check
   * spawn. The poller already computed this via `listInProgressYamls`
   * earlier in the tick.
   */
  inProgress: readonly Issue[];
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
  /**
   * Count of (agent, card) pairs that were skipped because the
   * conflict-check verdict was `ok: false`. Surfaced for the poller's
   * log line.
   */
  conflictBlocked: number;
}

/**
 * Run the multi-agent pick + dispatch loop for one tick.
 *
 * No-op (returns `{dispatched: 0, conflictBlocked: 0}`) when:
 *   - `agents` map is empty (no roster).
 *   - No card is dispatchable.
 *   - No agent is free + in-schedule.
 *
 * Returns even when one or more dispatches failed to spawn — the
 * caller can re-tick on the next interval. Spawn failures are logged
 * and do not throw.
 */
export async function tryMultiAgentDispatch(
  input: MultiAgentPickInput,
): Promise<MultiAgentPickResult> {
  const { repo, cards, inProgress, tracker, now } = input;
  const roster: AgentRecordWithName[] = readAgents(repo.localPath);
  if (roster.length === 0) {
    // No agents configured → caller falls through to the legacy
    // single-card dispatch path. NOT a no-op for the dispatch — the
    // single-card path still runs.
    return { dispatched: 0, conflictBlocked: 0 };
  }
  if (cards.length === 0) {
    return { dispatched: 0, conflictBlocked: 0 };
  }

  const busy = await busyAgents(repo.name);
  const assigned = await assignedCards(repo.name);
  const conflictEnabled = isConflictCheckEnabled(repo.localPath);

  // Heal orphan/duplicate `assigned_agent` stamps BEFORE the picker loop.
  // Two failure modes the picker can't otherwise progress past:
  //   (a) `assigned_agent` names an agent that no longer exists in the
  //       roster (settings.json clobber per DX-281, or operator deletion
  //       without the DX-283 cascade). `pickCardForAgent` treats those
  //       cards as owned-by-another-agent forever → silent skip every
  //       tick. Clear the stamp so the card returns to the unclaimed
  //       pool.
  //   (b) Same agent stamped on multiple open ToDo cards
  //       (clearDispatchAndWrite miss on a prior dispatch, manual YAML
  //       edit). Invariant: 1 open card per agent at a time. Keep the
  //       first card in pick order (already canonical from
  //       `listDispatchableYamls` — ICE+priority+FIFO) and clear the
  //       rest. The kept card dispatches this tick; cleared cards
  //       re-enter the pool unclaimed on the next tick.
  // Heal mutations are persisted via `clearDispatchAndWrite` (NOT
  // `stampAssignedAgentAndWrite(..., null)`) so the co-ownership
  // invariant `(dispatch !== null) === (assigned_agent !== null)` is
  // enforced atomically — DX-286 traced orphan `dispatch{pid:0}` blocks
  // to a heal that cleared assigned_agent only, leaving the dispatch{}
  // block on cards that came in carrying a stale dispatch. The DX-286
  // per-tick `runInvariantHeal` in `_poll` runs BEFORE this picker, so
  // cards reaching here should already satisfy the invariant; this heal
  // is the second line of defense against the chokidar-lag race window
  // where a fresh stamp lands between the per-tick scan and the
  // picker's DB read. The in-memory `cards` view is replaced with
  // post-heal Issue objects so the remainder of this fn sees the
  // cleared state.
  const rosterNames = new Set(roster.map((r) => r.name));
  const seenAgents = new Set<string>();
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
      const cleared = await clearDispatchAndWrite(repo.localPath, c);
      healedCards.push(cleared);
      continue;
    }
    if (seenAgents.has(c.assigned_agent)) {
      log.warn(
        `[${repo.name}] heal: ${c.id} duplicates assigned_agent=${c.assigned_agent} (already claimed by an earlier card this tick) — clearing claim (invariant: 1 open card per agent)`,
      );
      const cleared = await clearDispatchAndWrite(repo.localPath, c);
      healedCards.push(cleared);
      continue;
    }
    seenAgents.add(c.assigned_agent);
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
  let conflictBlocked = 0;

  while (remainingCards.length > 0) {
    const agent = pickFreeAgent({ roster, busy, now });
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

    // Run the conflict-check precursor when other agents are
    // working AND the operator hasn't disabled it.
    //
    // DX-262 follow-up — re-filter `inProgress` against the LIVE
    // dispatches table right before the conflict-check spawn. The
    // input list came from `listInProgressYamls` (status === "In
    // Progress" — YAML truth) at the top of the tick; orphan YAMLs
    // whose dispatch died outside the orderly completion path
    // (worker OOM, operator DB cancel, broken-worktree resetClean,
    // claude-auth fail) carry `In Progress` until reconcile resets
    // them, which can be MANY ticks later. Without this filter the
    // picker burns a conflict-check dispatch every tick against a
    // ghost card. The filter also closes the slow-tick window where
    // a sibling card moved Done between the top-of-tick read and the
    // dispatch call. `liveDispatchIssueIds` is the cheap O(busy)
    // query — no full table scan.
    let liveInProgress: readonly Issue[] = inProgress;
    if (inProgress.length > 0 && conflictEnabled) {
      const liveIds = await liveDispatchIssueIds(repo.name);
      liveInProgress = inProgress.filter((c) => liveIds.has(c.id));
      if (liveInProgress.length < inProgress.length) {
        const dropped = inProgress
          .filter((c) => !liveIds.has(c.id))
          .map((c) => c.id);
        log.info(
          `[${repo.name}] conflict-check: dropped ${dropped.length} stale in-progress YAML(s) with no live dispatch — ${dropped.join(", ")}`,
        );
      }
    }
    if (liveInProgress.length > 0 && conflictEnabled) {
      const checkDispatchId = randomUUID();
      const verdict = await runConflictCheck(
        { repo, candidate: card, inProgress: liveInProgress },
        { dispatch, dispatchId: checkDispatchId },
      );
      if (!verdict.ok) {
        log.warn(
          `[${repo.name}] conflict-check blocked ${card.id} for ${agent.name}: ${verdict.reason}`,
        );
        // Stamp `waiting_on` (NOT `blocked`) on the candidate. Per the
        // schema contract (src/issue-tracker/interface.ts: `Blocked` vs
        // `WaitingOn`): `blocked` = THIS card cannot make progress on
        // its own work (human must act); `waiting_on` = dep-chain queue
        // (waiting for OTHER cards to finish first, status stays ToDo).
        // A conflict-check rejection is the second case — the candidate
        // is fine, it just must wait for the overlapping sibling(s) to
        // finish. `effectiveWaitingOn` derives the card eligible again
        // automatically once every dep reaches a terminal status.
        const fresh = await loadLocal(repo.localPath, card.id, repo.issuePrefix);
        if (fresh) {
          const reasonRaw = `Conflict-check rejection: ${verdict.reason}`;
          const reason =
            reasonRaw.length > 280 ? reasonRaw.slice(0, 279) + "…" : reasonRaw;
          const by =
            verdict.blocked_by && verdict.blocked_by.length > 0
              ? verdict.blocked_by
              : liveInProgress.map((c) => c.id);
          const waiting: WaitingOn = {
            reason,
            timestamp: now.toISOString(),
            by,
          };
          const updated: Issue = { ...fresh, waiting_on: waiting };
          // Direct write skipping `stampDispatchAndWrite` — the card
          // isn't being dispatched, only flagged. `writeIssue`
          // mirror handles DB sync.
          await writeIssue(repo.localPath, updated);
        }
        // Remove from the working set so the next iteration moves on.
        remainingCards.splice(remainingCards.indexOf(card), 1);
        conflictBlocked++;
        continue;
      }
    }

    // Pre-generate the dispatch UUID + start stamp so the YAML carries
    // the same id we hand to dispatch().
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
        log.warn(
          `[${repo.name}] multi-agent lock acquire threw for ${card.id} (external_id=${card.external_id}) → ${agent.name}: ${err instanceof Error ? err.message : String(err)} — skipping this tick`,
        );
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

    // Build the per-card task body. Same shape as the legacy single-
    // card path (TEAM_PROMPT + Edit instruction); the persona prefix
    // is auto-injected by `dispatch()` before the agent reads the
    // first turn.
    const yamlPath = resolve(
      repo.localPath,
      ".danxbot",
      "issues",
      "open",
      `${stamped.id}.yml`,
    );
    const task =
      `/danx-next\n\nEdit ${yamlPath} directly with the Edit / Write tools. ` +
      `The watcher mirrors changes to the database automatically; the poller's ` +
      `per-tick mirror pushes them to the tracker. Call danxbot_complete when done.`;

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

            // AC #4 of DX-219 — post-dispatch card-progress check +
            // CRITICAL_FAILURE halt ported into the multi-agent path.
            // Skip locally-only cards (no external_id, no tracker round-
            // trip is possible). The legacy `_poll` single-card path's
            // `checkCardProgressedOrHalt` ran for every trello-trigger
            // dispatch; this is the multi-agent equivalent. Token-burn
            // safeguard against an env-level blocker (MCP/Bash/auth
            // failing) that lets the agent "finish" without moving the
            // card. The next poll tick reads the flag and halts.
            //
            // Skip when the dispatch was recovery-mode (branch cleanup,
            // not card work) — the tracked card stays in ToDo by design
            // and writing CRITICAL_FAILURE would halt the poller for a
            // non-issue. See AgentJob.recoveryMode.
            if (hasTrackerCoordinate(stamped) && !job.recoveryMode) {
              await runPostDispatchProgressCheck({
                repo,
                cardId: stamped.external_id,
                jobId: job.id,
                jobStatus: job.status,
                jobSummary: job.summary,
              });
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

  return { dispatched, conflictBlocked };
}
