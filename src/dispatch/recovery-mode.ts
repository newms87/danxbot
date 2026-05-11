/**
 * Branch-recovery dispatch routing (DX-161 / multi-worker dispatch epic
 * DX-158). Owns the validate→reset/recover decision tree + post-completion
 * re-validation. Pure prompt construction lives in `./recovery-prompt.ts`;
 * default IO helpers live in `./recovery-card-update.ts`. Splitting them
 * lets pure-prompt tests run without loading `dispatch/core.js` (which
 * pulls in `config.ts` + every required env var).
 *
 * `dispatchWithRecovery` is the worktree-aware front door. Callers (the
 * Phase-5 poller; agent-CRUD endpoints when they spawn a hands-on
 * dispatch) pass an `agentName` + `manager`; `dispatchWithRecovery`
 * inserts the validate/reset/recover gate ahead of the actual dispatch.
 *
 * Existing callers (Slack, legacy poller, external `/api/launch` without
 * an agent) keep calling `dispatch()` directly — no behaviour change.
 *
 * Single-fork invariant: the recovery dispatch IS itself a normal
 * dispatch; `dispatchInRecoveryMode` calls `deps.dispatch(...)` once
 * with the recovery prompt. The post-completion re-validate runs in the
 * dispatch's `onComplete` callback (no second spawn).
 */

import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";
import type { WorktreeManager } from "../agent/worktree-manager.js";
import type { DispatchInput, DispatchResult } from "./core.js";
import {
  buildRecoveryPrompt,
  buildStillDirtyComment,
  type DirtyValidation,
} from "./recovery-prompt.js";
import {
  appendNeedsHelpComment as defaultAppendNeedsHelpComment,
  findLastModifiedOpenCard as defaultFindLastModifiedOpenCard,
} from "./recovery-card-update.js";

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
  /**
   * Lookup the most-recently-modified open issue YAML in the repo.
   * Defaults to a real-FS scan; tests stub. See
   * `./recovery-card-update.ts` for the Phase 3 limitation note.
   */
  findLastModifiedOpenCard?: (
    repo: RepoContext,
  ) => Promise<{ id: string; path: string } | null>;
  /**
   * Append a Needs Help comment to a card YAML. Defaults to the
   * yaml-parser-based helper in `./recovery-card-update.ts`; tests stub.
   */
  appendNeedsHelpComment?: (cardPath: string, body: string) => Promise<void>;
}

/** Re-export so callers don't need a second import for the type. */
export type { DirtyValidation } from "./recovery-prompt.js";
export { buildRecoveryPrompt } from "./recovery-prompt.js";

/**
 * Spawn the recovery dispatch and wire post-completion re-validation.
 *
 * Flow:
 *   1. Build the recovery prompt from the dirty validation result.
 *   2. Call `deps.dispatch()` with that prompt, marking the dispatch's
 *      API metadata `endpoint = "internal:recovery"` so dashboards / log
 *      readers can spot recovery runs without a schema change.
 *   3. On completion, re-run `validate()`. If still dirty, find the
 *      last-modified open card and append a Needs Help comment so an
 *      operator can intervene. If clean, poller picks again next tick.
 *
 * The caller's `input.onComplete` is invoked BEFORE the post-recovery
 * follow-up runs. Errors from either side are caught + logged so the
 * dispatch lifecycle never propagates an unhandled promise rejection
 * back to the worker.
 */
export async function dispatchInRecoveryMode(
  input: DispatchInput,
  agentName: string,
  validation: DirtyValidation,
  manager: WorktreeManager,
  deps: RecoveryDeps,
): Promise<DispatchResult> {
  const findLast = deps.findLastModifiedOpenCard ?? defaultFindLastModifiedOpenCard;
  const appendComment = deps.appendNeedsHelpComment ?? defaultAppendNeedsHelpComment;

  const worktreePath = manager.worktreePath(input.repo, agentName);
  const prompt = buildRecoveryPrompt({ agentName, worktreePath, validation });
  log.warn(
    `dispatchInRecoveryMode(${input.repo.name}/${agentName}): ${validation.reason} — spawning recovery prompt`,
  );

  // Mark the dispatch as recovery via the API metadata so the dashboard +
  // log readers can distinguish it from a normal `work` run. We always
  // overlay onto an `api` trigger — recovery dispatches are worker-
  // internal, not Slack/Trello-driven.
  const recoveryMeta: DispatchInput["apiDispatchMeta"] = {
    trigger: "api",
    metadata: {
      endpoint: "internal:recovery",
      callerIp: null,
      statusUrl: null,
      initialPrompt: prompt,
      ...(input.apiDispatchMeta.trigger === "api"
        ? { workspace: input.apiDispatchMeta.metadata.workspace }
        : {}),
    },
  };

  const recoveryInput: DispatchInput = {
    ...input,
    task: prompt,
    title: `Branch recovery — ${agentName}`,
    apiDispatchMeta: recoveryMeta,
    onComplete: async (job) => {
      // Stamp BEFORE caller.onComplete so the caller's "did the tracked
      // card progress?" guard can short-circuit. Recovery dispatches do
      // branch cleanup, not card work — running the progress check
      // would write a spurious CRITICAL_FAILURE flag every time recovery
      // succeeds against a clean ToDo card. See AgentJob.recoveryMode
      // for the cross-file contract.
      job.recoveryMode = true;
      // Caller's onComplete first — preserve existing semantics + don't
      // let our follow-up errors mask the caller's bookkeeping. Errors
      // from the caller are caught + logged so the dispatch lifecycle
      // doesn't surface an unhandled rejection.
      if (input.onComplete) {
        try {
          await input.onComplete(job);
        } catch (callerErr) {
          log.error(
            `recovery(${input.repo.name}/${agentName}): caller onComplete threw`,
            callerErr,
          );
        }
      }
      try {
        const post = await manager.validate(input.repo, agentName);
        if (post.state !== "dirty") {
          log.info(
            `recovery(${input.repo.name}/${agentName}): branch is now clean — poller will pick next card`,
          );
          return;
        }
        log.warn(
          `recovery(${input.repo.name}/${agentName}): STILL dirty after recovery — ${post.reason}`,
        );
        const card = await findLast(input.repo);
        if (!card) {
          log.error(
            `recovery(${input.repo.name}/${agentName}): no open cards to attach Needs Help to — operator must inspect manually`,
          );
          return;
        }
        const body = buildStillDirtyComment(agentName, post);
        await appendComment(card.path, body);
        log.warn(
          `recovery(${input.repo.name}/${agentName}): filed Needs Help on ${card.id} (${card.path})`,
        );
      } catch (err) {
        log.error(
          `recovery(${input.repo.name}/${agentName}): post-recovery validation threw`,
          err,
        );
      }
    },
  };

  return deps.dispatch(recoveryInput);
}

/**
 * Worktree-aware dispatch entry point. Use this from callers that own a
 * named agent + a `WorktreeManager`.
 *
 * On `clean` validation we run `resetClean` to fast-forward (or no-op
 * when already at HEAD) BEFORE handing off to dispatch — this is the
 * one chance to refresh the worktree's `main` ref. On `dirty` we route
 * to `dispatchInRecoveryMode` instead and the normal dispatch is
 * skipped — the next poll tick re-evaluates after recovery completes.
 *
 * **Caller serialization invariant:** callers MUST hold a per-agent
 * dispatch lock around this function so a concurrent operator-driven
 * dirtying op cannot race between `validate()` and `resetClean()` (the
 * reset would silently destroy uncommitted work). Phase 5 (DX-200)
 * lands the formal lock via the `dispatches` table; until then, the
 * single-poller invariant + the absence of an issue-worker dispatch API
 * for arbitrary callers gives us this property by construction.
 */
export async function dispatchWithRecovery(
  input: DispatchInput,
  worktreeContext: { agentName: string; manager: WorktreeManager },
  deps: RecoveryDeps,
): Promise<DispatchResult> {
  const { agentName, manager } = worktreeContext;

  // Refresh the host clone's `refs/remotes/origin/main` BEFORE validate
  // so external pushes (PR-merge via GitHub web UI, peer-dev pushes,
  // this host's own non-finalize pushes) are visible to the next
  // resetClean. Without this, the agent starts on whatever sha was
  // cached at the last finalize / manual fetch — silent staleness.
  // Transient failures fall through (warning logged inside the
  // manager) so a flaky network does not dead-letter the dispatch.
  await manager.fetchOrigin(input.repo);

  const validation = await manager.validate(input.repo, agentName);
  if (validation.state === "dirty") {
    return dispatchInRecoveryMode(input, agentName, validation, manager, deps);
  }
  // Clean — fast-forward (or no-op) before normal spawn.
  await manager.resetClean(input.repo, agentName);
  return deps.dispatch(input);
}
