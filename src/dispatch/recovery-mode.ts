/**
 * Worktree-aware dispatch entry point (DX-297 / DX-291 P6 — collapsed).
 *
 * `dispatchWithRecovery` is a thin pre-flight wrapper: it refreshes the
 * host clone's `refs/remotes/origin/main`, fast-forwards (or rebases)
 * the agent's worktree to that tip, and hands off to `deps.dispatch`.
 * The prep skill (DX-291 P4 / `danxbot:danx-prep`) is the new authority
 * on agent-readiness — WIP recovery, conflict reasoning, and branch-
 * state inspection ALL live on the agent's worktree as the first step
 * of every dispatch.
 *
 * DX-297 deleted the prior `validate → dispatchInRecoveryMode` dirty
 * branch (recovery prompt, last-modified-card scan, Needs Help comment
 * append) — the prep skill's `verdict: "abort"` path now handles every
 * blocked-worktree scenario via the prep-verdict route's
 * `agents.<name>.broken` stamp. DX-333 retired the `validate()` method
 * itself.
 *
 * On `syncWorktree.kind === "abort"` (env failure — ff-only refused,
 * fetch network failure, rev-list plumbing) this wrapper stamps
 * `agents.<name>.broken` persistently so the picker skips the agent
 * for THIS tick, emits a `sync-repair-needed` event so the
 * sync-repair-dispatcher (DX-645 / Phase 3 of DX-576) dispatches the
 * `worktree-repair` workspace asynchronously, then throws a plain
 * `Error` so the multi-agent caller's existing try/catch fires its
 * dispatch-cleanup bookkeeping (clear YAML `dispatch{}`, release
 * lock). The repair agent rebases + resolves + pushes + clears
 * `agent.broken` (on terminal `completed`) so the original agent is
 * dispatchable again on the next tick — no operator action required
 * for the steady-state autosave-rebase-conflict class. The broken
 * stamp persists when the repair dispatch itself fails (terminal
 * `failed`), preserving the prior operator-gate behavior as the
 * fallback for unresolvable conflicts.
 *
 * The order — stamp BEFORE emit BEFORE throw — is load-bearing:
 *   - Stamping first guarantees the picker-gate is in place even if
 *     the event subscriber is missing or throws.
 *   - Emitting before the throw means the event lands in the
 *     dispatch-events bus's microtask queue while the caller's
 *     try/catch unwinds; the repair dispatcher fires its dispatch
 *     after the unwind completes, on a fresh tick.
 *   - Throwing last gives the multi-agent caller the rejection it
 *     needs to release its lock; the repair runs concurrently with
 *     the next poller tick.
 *
 * On `syncWorktree.kind === "conflict"` (rebase against origin/main
 * hit a merge conflict — the EXPECTED branch-collision state when two
 * agents or a PR-merge + agent commits touch the same files) this
 * wrapper logs + passes through to `deps.dispatch`. The agent's prep
 * skill (Step 4 of `danxbot:danx-prep`) re-runs the rebase and
 * resolves conflicts semantically in-session — that is the steady-
 * state self-healing flow. Stamping `broken` on a conflict would lock
 * the agent out for what is supposed to be in-session work
 * (regression DX-293, fixed in the same commit that introduced the
 * `conflict` kind).
 */

import { createLogger } from "../logger.js";
import { defaultBrokenEvaluator, setAgentBroken } from "../settings-file.js";
import type { DispatchInput, DispatchResult } from "./core.js";
import type { WorktreeManager } from "../agent/worktree-manager.js";
import { dispatchEvents } from "./events.js";

const log = createLogger("recovery-mode");

export interface RecoveryDeps {
  /**
   * The dispatch entry point. REQUIRED — there is no default. Injecting
   * the dispatch import keeps this module's load-time clean of
   * `dispatch/core.js` (which transitively requires `DANXBOT_DB_*` env
   * vars). Production callers pass `dispatch` from `./core.js`; tests
   * pass a `vi.fn()`.
   */
  dispatch: (input: DispatchInput) => Promise<DispatchResult>;
}

export async function dispatchWithRecovery(
  input: DispatchInput,
  worktreeContext: { agentName: string; manager: WorktreeManager },
  deps: RecoveryDeps,
): Promise<DispatchResult> {
  const { agentName, manager } = worktreeContext;

  // Refresh the host clone's `refs/remotes/origin/main` BEFORE syncWorktree
  // so external pushes (PR-merge via GitHub web UI, peer-dev pushes,
  // this host's own non-finalize pushes) are visible. Transient failures
  // fall through (warning logged inside the manager) so a flaky network
  // does not dead-letter the dispatch.
  await manager.fetchOrigin(input.repo);

  // DX-359 — snapshot any uncommitted WIP residue from a prior unclean
  // dispatch BEFORE the ff/rebase pre-flight. The prep skill (DX-291) is
  // the steady-state owner of commit-first WIP recovery, but it runs
  // INSIDE the dispatched agent's session — too late if `syncWorktree`'s
  // ff-only pull aborts on the dirty tree first. Worker-crash-mid-
  // dispatch leaves WIP that, untouched, aborts the next pick's
  // ff-only pull and stamps `agents.<name>.broken`. One commit on the
  // agent branch preserves the work AND unwedges sync; rebase replays
  // the snapshot onto fresh origin/main. Same `broken`-stamping
  // routing as a `syncWorktree` abort.
  const snapshot = await manager.snapshotIfDirty(input.repo, agentName);
  if (snapshot.kind === "abort") {
    await stampBrokenAndThrow(
      input,
      agentName,
      `snapshotIfDirty aborted: ${snapshot.reason}`,
      snapshot.details,
    );
  }

  // Fast-forward (or rebase) the worktree to the freshly-fetched
  // origin/main. The prep skill runs branch-state inspection itself; this
  // call is a cheap pre-flight so the common clean-ff case takes zero
  // tokens. On abort (ff-only refused, history diverged), persistently
  // mark the agent broken — the picker will skip this agent next tick
  // until the operator clears the field via the dashboard.
  const sync = await manager.syncWorktree(input.repo, agentName);
  if (sync.kind === "abort") {
    // DX-645 — emit the sync-repair-needed event AFTER the broken
    // stamp so the picker-gate is in place before the repair
    // dispatcher fires (subscriber-vs-stamp race-safe). The repair
    // agent's terminal `completed` clears `agent.broken`
    // programmatically (mirrors the `clear-broken` route's
    // mutation); terminal `failed` leaves the stamp in place as the
    // operator-gate fallback.
    await stampBrokenAndThrow(
      input,
      agentName,
      `syncWorktree aborted: ${sync.reason}`,
      sync.details,
      { emitSyncRepairNeeded: true },
    );
  }
  if (sync.kind === "conflict") {
    // Pass-through. The agent's prep skill (Step 4 of
    // `danxbot:danx-prep`) re-runs the rebase and resolves the
    // conflict in place. Logged at warn so the conflict is visible
    // in dispatch logs without alerting on the steady-state flow.
    log.warn(
      `dispatchWithRecovery(${input.repo.name}/${agentName}): ${sync.reason} — handing off to agent's prep skill for in-session resolution`,
    );
  }
  return deps.dispatch(input);
}

interface StampBrokenOpts {
  /**
   * DX-645 — when true, emits a `sync-repair-needed` event AFTER the
   * broken stamp settles but BEFORE the throw unwinds the caller.
   * The sync-repair-dispatcher (`src/agent/sync-repair-dispatcher.ts`)
   * subscribes and dispatches the `worktree-repair` workspace
   * asynchronously. ONLY the `syncWorktree` abort path sets this —
   * `snapshotIfDirty` abort (HEAD not on agent branch, commit
   * failure) is a corrupt-worktree condition the repair agent
   * cannot heal via the rebase contract, so that path retains the
   * operator-gate behavior.
   */
  emitSyncRepairNeeded?: boolean;
}

async function stampBrokenAndThrow(
  input: DispatchInput,
  agentName: string,
  reason: string,
  details: string,
  opts: StampBrokenOpts = {},
): Promise<never> {
  log.warn(
    `dispatchWithRecovery(${input.repo.name}/${agentName}): ${reason} — ${details}`,
  );
  await setAgentBroken(
    input.repo.localPath,
    agentName,
    {
      reason,
      suggested_steps: details ? [details] : [],
      set_at: new Date().toISOString(),
      // DX-364 — sync-recovery stamps outside the evaluator workflow.
      ...defaultBrokenEvaluator(),
    },
    "worker",
  );
  if (opts.emitSyncRepairNeeded) {
    // Strip the `syncWorktree aborted: ` prefix so the event carries
    // the raw SyncResult.abort.reason — the dispatcher composes its
    // own prefix when surfacing the reason in the repair prompt.
    const abortReason = reason.replace(/^syncWorktree aborted:\s*/, "");
    dispatchEvents.emit("sync-repair-needed", {
      repoName: input.repo.name,
      agentName,
      abortReason,
      abortDetails: details,
    });
  }
  throw new Error(
    `dispatchWithRecovery(${input.repo.name}/${agentName}): ${reason} — ${details}`,
  );
}
