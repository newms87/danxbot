/**
 * Worker HTTP handler for `POST /api/re-run-evaluator` (DX-367 —
 * Phase 4b of DX-363).
 *
 * Owns the operator-triggered re-run path: reset
 * `agent.broken.evaluator_status` to `"pending"`, clear
 * `evaluator_dispatch_id`, then emit `broken-transition` in-process
 * so the worker's `evaluator-dispatcher` re-dispatches the
 * system-evaluator. The route lives on the WORKER (not the dashboard)
 * because the event bus is in-process and the dispatcher subscriber
 * lives in the worker process — a separate dashboard process emitting
 * its own bus does NOT reach the worker.
 *
 * The dashboard's `handleReRunEvaluator` is a thin proxy that
 * forwards user-authenticated requests here via
 * `proxyToWorkerWithFallback`.
 *
 * Body: `{name: "<agent-name>"}` — the agent within the worker's
 * repo to re-evaluate.
 *
 * Status codes:
 *   - 200 — re-run queued; broken-transition emitted.
 *   - 400 — body missing `name` OR agent is not in broken state OR
 *           agent is already running an evaluator (anti-double-click
 *           guard).
 *   - 404 — agent not found in the worker's repo.
 *   - 500 — settings write failed.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import {
  mutateAgents,
  type AgentRecord,
} from "../settings-file.js";
import { dispatchEvents } from "../dispatch/events.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-re-run-evaluator-route");

export interface ReRunEvaluatorDeps {
  /** Override the agents mutator for unit tests. */
  mutate?: typeof mutateAgents;
  /** Override the event emitter for unit tests. */
  emit?: typeof dispatchEvents.emit;
}

interface MutateOutcome {
  agentMissing: boolean;
  notBroken: boolean;
  alreadyRunning: boolean;
}

/**
 * Atomically reset the agent's evaluator binding. Returns the
 * mutation outcome so the caller can map to the right HTTP status.
 */
async function resetEvaluatorBinding(
  mutate: typeof mutateAgents,
  repoLocalPath: string,
  agentName: string,
): Promise<MutateOutcome> {
  const outcome: MutateOutcome = {
    agentMissing: false,
    notBroken: false,
    alreadyRunning: false,
  };
  await mutate(
    repoLocalPath,
    (current) => {
      const record: AgentRecord | undefined = current[agentName];
      if (!record) {
        outcome.agentMissing = true;
        return current;
      }
      if (record.broken === null) {
        outcome.notBroken = true;
        return current;
      }
      if (record.broken.evaluator_status === "running") {
        // Anti-double-click guard: an evaluator that is currently
        // running gets a chance to finish before a second spawn. The
        // operator can wait for the in-flight dispatch to terminate
        // (success or failure → status moves off "running") and try
        // again. This bounds dispatch cost to 1 evaluator per
        // broken-state transition.
        outcome.alreadyRunning = true;
        return current;
      }
      current[agentName] = {
        ...record,
        broken: {
          ...record.broken,
          evaluator_status: "pending",
          evaluator_dispatch_id: null,
        },
      };
      return current;
    },
    "worker",
  );
  return outcome;
}

export async function handleReRunEvaluator(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
  deps: ReRunEvaluatorDeps = {},
): Promise<void> {
  const mutate = deps.mutate ?? mutateAgents;
  const emit = deps.emit ?? dispatchEvents.emit.bind(dispatchEvents);

  let body: Record<string, unknown>;
  try {
    body = (await parseBody(req)) as Record<string, unknown>;
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const name = body["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    json(res, 400, { error: "name must be a non-empty string" });
    return;
  }

  let outcome: MutateOutcome;
  try {
    outcome = await resetEvaluatorBinding(mutate, repo.localPath, name);
  } catch (err) {
    log.error(
      `re-run-evaluator(${repo.name}, ${name}) mutate failed`,
      err,
    );
    json(res, 500, {
      error: err instanceof Error ? err.message : "Settings write failed",
    });
    return;
  }

  if (outcome.agentMissing) {
    json(res, 404, {
      error: `Agent "${name}" not found in repo "${repo.name}"`,
    });
    return;
  }
  if (outcome.notBroken) {
    json(res, 400, {
      error: `Agent "${name}" is not in broken state — cannot re-run evaluator on a healthy agent`,
    });
    return;
  }
  if (outcome.alreadyRunning) {
    json(res, 400, {
      error: `Agent "${name}" already has an evaluator dispatch running — wait for it to complete before re-running`,
    });
    return;
  }

  emit("broken-transition", { repoName: repo.name, agentName: name });
  json(res, 200, { status: "queued", repo: repo.name, agent: name });
}
