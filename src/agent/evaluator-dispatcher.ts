/**
 * DX-367 (Phase 4 of DX-363) — system-evaluator dispatcher.
 *
 * Subscribes to the `broken-transition` event emitted by the strike
 * accumulator (`src/agent/strikes.ts`) when an agent's strike count
 * crosses `STRIKES_MAX` and `agent.broken` flips from `null` to
 * populated. On every event for THIS worker's repo:
 *
 *   1. Read the struck agent's `strikes.history` so the dispatch
 *      prompt can name the 3 strike `dispatch_id`s the evaluator
 *      must inspect.
 *   2. Atomically stamp `agent.broken.evaluator_status = "running"` +
 *      `agent.broken.evaluator_dispatch_id = <pre-allocated UUID>` so
 *      the dashboard banner can show "evaluator running" and so the
 *      worker's evaluator-summary route can reverse-look up the
 *      target agent by `evaluator_dispatch_id`.
 *   3. Call `dispatch()` with workspace `system-evaluator` and the
 *      `evaluatorSummaryUrl` opt-in. The dispatched agent runs the
 *      analysis, calls `danxbot_set_evaluator_summary({reason,
 *      suggested_steps})`, the worker route writes the summary into
 *      the agent's `broken` record + flips `evaluator_status` to
 *      `"completed"`, then the agent calls `danxbot_complete`.
 *   4. If `dispatch()` throws synchronously, flip
 *      `evaluator_status` to `"failed"` immediately — without
 *      overwriting the default reason from Phase 2.
 *   5. In `onComplete`, if `evaluator_status` is still `"running"` AND
 *      our `evaluator_dispatch_id` still matches (i.e. the operator
 *      did NOT re-run mid-flight), flip it to `"failed"` — the
 *      evaluator died without writing the summary.
 *
 * The "agent that became broken" is NOT the agent that runs the
 * evaluator — the evaluator dispatch has `agent_name = null` on its
 * dispatch row, so the strike accumulator never increments any
 * agent's counter on the evaluator's own terminal status (the
 * `applyStrike` guard short-circuits when `agent_name === null`).
 *
 * Returns the unsubscribe handle so the worker shutdown path can
 * detach the listener.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { dispatchEvents } from "../dispatch/events.js";
import type { BrokenTransitionEvent } from "../dispatch/events.js";
import { dispatch as defaultDispatch } from "../dispatch/core.js";
import {
  mutateAgents as defaultMutateAgents,
  readSettings as defaultReadSettings,
  type AgentStrikeEntry,
} from "../settings-file.js";
import type { RepoContext } from "../types.js";
import { buildEvaluatorPrompt } from "./evaluator-prompt.js";

const log = createLogger("evaluator-dispatcher");

export { buildEvaluatorPrompt } from "./evaluator-prompt.js";

export interface EvaluatorDispatcherDeps {
  repo: RepoContext;
  /** Override the dispatch entry-point for unit tests. */
  dispatchFn?: typeof defaultDispatch;
  /** Override the agents mutator for unit tests. */
  mutateAgents?: typeof defaultMutateAgents;
  /** Override the settings reader for unit tests. */
  readSettings?: typeof defaultReadSettings;
  /**
   * UUID generator — defaults to `randomUUID()`. Tests inject a
   * deterministic stub so assertion against the stamped
   * `evaluator_dispatch_id` stays stable.
   */
  uuid?: () => string;
}

/** Resolved deps after defaults application. Internal-only shape. */
interface ResolvedDeps {
  repo: RepoContext;
  dispatchFn: typeof defaultDispatch;
  mutateAgents: typeof defaultMutateAgents;
  readSettings: typeof defaultReadSettings;
  uuid: () => string;
}

function resolveDeps(deps: EvaluatorDispatcherDeps): ResolvedDeps {
  return {
    repo: deps.repo,
    dispatchFn: deps.dispatchFn ?? defaultDispatch,
    mutateAgents: deps.mutateAgents ?? defaultMutateAgents,
    readSettings: deps.readSettings ?? defaultReadSettings,
    uuid: deps.uuid ?? randomUUID,
  };
}

/**
 * Read the struck agent's strike history BEFORE the dispatcher
 * stamps its own evaluator binding. Returns `null` when the agent
 * is missing OR has cleared its broken flag (race between strike-3
 * and the operator clearing the broken state).
 */
function loadStrikeHistory(
  deps: ResolvedDeps,
  agentName: string,
): AgentStrikeEntry[] | null {
  try {
    const settings = deps.readSettings(deps.repo.localPath);
    const record = settings.agents?.[agentName];
    if (!record || record.broken === null) {
      log.warn(
        `broken-transition for ${agentName} but agent missing or not broken — skipping evaluator dispatch`,
      );
      return null;
    }
    return record.strikes.history;
  } catch (err) {
    log.error(
      `failed to read settings for evaluator dispatch on ${agentName}`,
      err,
    );
    return null;
  }
}

/**
 * Atomically stamp `evaluator_status = "running"` +
 * `evaluator_dispatch_id` on the named agent. Returns false when the
 * mutate failed (caller skips dispatch entirely).
 */
async function stampEvaluatorRunning(
  deps: ResolvedDeps,
  agentName: string,
  dispatchId: string,
): Promise<boolean> {
  try {
    await deps.mutateAgents(
      deps.repo.localPath,
      (current) => {
        const record = current[agentName];
        if (!record || record.broken === null) return current;
        current[agentName] = {
          ...record,
          broken: {
            ...record.broken,
            evaluator_status: "running",
            evaluator_dispatch_id: dispatchId,
          },
        };
        return current;
      },
      "worker",
    );
    return true;
  } catch (err) {
    log.error(
      `failed to stamp evaluator_status=running for ${agentName}`,
      err,
    );
    return false;
  }
}

/**
 * Flip `evaluator_status` to `"failed"` ONLY when our stamped
 * `evaluator_dispatch_id` still matches the agent's record AND
 * status is still `"running"`. The dispatch-id match is the re-run
 * race protection — a fresh re-run clears + re-stamps the id, and
 * this stale invocation must NOT flip the fresh re-run's state.
 */
async function markEvaluatorFailedIfStillOurs(
  deps: ResolvedDeps,
  agentName: string,
  dispatchId: string,
  context: "spawn-error" | "onComplete",
): Promise<void> {
  try {
    await deps.mutateAgents(
      deps.repo.localPath,
      (current) => {
        const rec = current[agentName];
        if (
          rec?.broken?.evaluator_dispatch_id === dispatchId &&
          rec.broken.evaluator_status === "running"
        ) {
          if (context === "onComplete") {
            log.warn(
              `evaluator dispatch ${dispatchId} for ${agentName} ended without writing summary — flipping evaluator_status to "failed"`,
            );
          }
          current[agentName] = {
            ...rec,
            broken: { ...rec.broken, evaluator_status: "failed" },
          };
        }
        return current;
      },
      "worker",
    );
  } catch (err) {
    log.error(
      `failed to flip evaluator_status=failed for ${agentName} (${context})`,
      err,
    );
  }
}

/** Spawn the system-evaluator dispatch. Returns true on success. */
async function spawnEvaluatorDispatch(
  deps: ResolvedDeps,
  agentName: string,
  dispatchId: string,
  prompt: string,
): Promise<boolean> {
  const evaluatorSummaryUrl = `http://localhost:${deps.repo.workerPort}/api/evaluator-summary/${dispatchId}`;
  try {
    await deps.dispatchFn({
      repo: deps.repo,
      task: prompt,
      workspace: "system-evaluator",
      overlay: {},
      apiDispatchMeta: {
        trigger: "api",
        metadata: {
          endpoint: "/internal/evaluator-dispatcher",
          callerIp: null,
          statusUrl: null,
          initialPrompt: prompt,
          workspace: "system-evaluator",
        },
      },
      dispatchId,
      evaluatorSummaryUrl,
      title: `Evaluator: ${agentName}`,
      onComplete: async () => {
        // The worker-route happy path already flipped status to
        // "completed" via `agent.broken.evaluator_dispatch_id`
        // reverse lookup. A completed evaluator therefore short-
        // circuits the equality check inside markEvaluatorFailedIfStillOurs.
        // A re-run that landed mid-flight has stamped a different
        // dispatch_id, which also short-circuits. Only the
        // dispatch-died-without-writing case actually flips here.
        await markEvaluatorFailedIfStillOurs(
          deps,
          agentName,
          dispatchId,
          "onComplete",
        );
      },
    });
    return true;
  } catch (err) {
    log.error(
      `evaluator dispatch threw synchronously for ${agentName}`,
      err,
    );
    await markEvaluatorFailedIfStillOurs(
      deps,
      agentName,
      dispatchId,
      "spawn-error",
    );
    return false;
  }
}

/**
 * Single-event handler. Reads strikes → stamps running → spawns
 * dispatch. Each step is its own helper above so the orchestration
 * stays at one level of detail.
 */
async function handleBrokenTransition(
  deps: ResolvedDeps,
  event: BrokenTransitionEvent,
): Promise<void> {
  if (event.repoName !== deps.repo.name) return;

  const strikes = loadStrikeHistory(deps, event.agentName);
  if (strikes === null) return;

  const dispatchId = deps.uuid();
  const stamped = await stampEvaluatorRunning(
    deps,
    event.agentName,
    dispatchId,
  );
  if (!stamped) return;

  const prompt = buildEvaluatorPrompt({
    agentName: event.agentName,
    repoName: event.repoName,
    strikes,
  });

  await spawnEvaluatorDispatch(deps, event.agentName, dispatchId, prompt);
}

/**
 * Subscribe to `broken-transition` and dispatch the evaluator agent
 * on every event for this worker's repo. Returns an unsubscribe
 * handle the worker shutdown path can call.
 */
export function startEvaluatorDispatcher(
  deps: EvaluatorDispatcherDeps,
): () => void {
  const resolved = resolveDeps(deps);
  const handler = (event: BrokenTransitionEvent): Promise<void> =>
    handleBrokenTransition(resolved, event);
  dispatchEvents.on("broken-transition", handler);
  return () => dispatchEvents.off("broken-transition", handler);
}
