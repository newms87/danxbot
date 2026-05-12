/**
 * Worktree-aware dispatch entry point (DX-297 / DX-291 P6 — collapsed).
 *
 * `dispatchWithRecovery` is a thin pre-flight wrapper: it refreshes the
 * host clone's `refs/remotes/origin/main`, fast-forwards (or rebases)
 * the agent's worktree to that tip, and hands off to `deps.dispatch`.
 * The prep skill (DX-291 P4 / `danxbot:danx-prep`) is the new authority
 * on agent-readiness — WIP recovery, validate, conflict reasoning, and
 * branch-state inspection ALL live on the agent's worktree as the first
 * step of every dispatch.
 *
 * DX-297 deleted the legacy `validate → dispatchInRecoveryMode` dirty
 * branch (recovery prompt, last-modified-card scan, Needs Help comment
 * append) — the prep skill's `verdict: "abort"` path now handles every
 * blocked-worktree scenario via the prep-verdict route's
 * `agents.<name>.broken` stamp.
 *
 * On `syncWorktree.kind === "abort"` (ff-only refused, fetch mid-failure)
 * this wrapper stamps `agents.<name>.broken` persistently so the picker
 * skips the agent until the operator clears the field, then throws a
 * plain `Error` so the multi-agent caller's existing try/catch fires its
 * dispatch-cleanup bookkeeping (clear YAML `dispatch{}`, quarantine,
 * release lock).
 */

import { createLogger } from "../logger.js";
import { setAgentBroken } from "../settings-file.js";
import type { DispatchInput, DispatchResult } from "./core.js";
import type { WorktreeManager } from "../agent/worktree-manager.js";

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

  // Fast-forward (or rebase) the worktree to the freshly-fetched
  // origin/main. The prep skill runs branch-state inspection itself; this
  // call is a cheap pre-flight so the common clean-ff case takes zero
  // tokens. On abort (ff-only refused, history diverged), persistently
  // mark the agent broken — the picker will skip this agent next tick
  // until the operator clears the field via the dashboard.
  const sync = await manager.syncWorktree(input.repo, agentName);
  if (sync.kind === "abort") {
    const reason = `syncWorktree aborted: ${sync.reason}`;
    log.warn(
      `dispatchWithRecovery(${input.repo.name}/${agentName}): ${reason} — ${sync.details}`,
    );
    await setAgentBroken(
      input.repo.localPath,
      agentName,
      {
        reason,
        suggested_steps: sync.details ? [sync.details] : [],
        set_at: new Date().toISOString(),
      },
      "worker",
    );
    throw new Error(
      `dispatchWithRecovery(${input.repo.name}/${agentName}): ${reason} — ${sync.details}`,
    );
  }
  return deps.dispatch(input);
}
