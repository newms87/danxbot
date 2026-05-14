/**
 * Worker HTTP handler for `POST /api/evaluator-summary/:dispatchId`
 * (DX-367 — Phase 4 of DX-363).
 *
 * The system-evaluator agent calls `danxbot_set_evaluator_summary` at
 * the end of its run; the MCP server POSTs the parsed `{reason,
 * suggested_steps}` payload here. This handler is the single place
 * that turns the verdict into:
 *
 *   - `agent.broken.reason` ← `reason`
 *   - `agent.broken.suggested_steps` ← `suggested_steps`
 *   - `agent.broken.evaluator_status` ← `"completed"`
 *
 * The target agent is located by reverse lookup on
 * `settings.agents.*.broken.evaluator_dispatch_id === dispatchId`. The
 * tool does NOT carry the target agent name in its arguments — the
 * evaluator-dispatcher already wrote that binding into settings when it
 * stamped `evaluator_status: "running"`. A re-run via the dashboard
 * clears + re-stamps the binding, so a stale dispatch posting after a
 * re-run will not match any agent and 404s — the right behavior, since
 * the operator already restarted the evaluation.
 *
 * Auth: same per-dispatch-id contract as `/api/stop/...` — the
 * dispatchId in the URL path is the bearer.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import {
  mutateAgents,
  type AgentBrokenState,
} from "../settings-file.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-evaluator-summary-route");

export interface EvaluatorSummaryDeps {
  /** Override the agents mutator for unit tests. */
  mutate?: typeof mutateAgents;
}

interface EvaluatorSummaryPayload {
  reason: string;
  suggested_steps: string[];
}

function parsePayload(body: unknown): EvaluatorSummaryPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    throw new TypeError("reason must be a non-empty string");
  }
  const steps = obj.suggested_steps;
  let suggestedSteps: string[] = [];
  if (steps !== undefined) {
    if (!Array.isArray(steps)) {
      throw new TypeError("suggested_steps must be an array of strings");
    }
    for (const step of steps) {
      if (typeof step !== "string") {
        throw new TypeError(
          "every entry in suggested_steps must be a string",
        );
      }
    }
    suggestedSteps = steps;
  }
  return { reason: obj.reason, suggested_steps: suggestedSteps };
}

/**
 * POST /api/evaluator-summary/:dispatchId — see file header for the
 * full contract. Locates the target agent via the
 * `agent.broken.evaluator_dispatch_id === dispatchId` reverse lookup
 * inside `mutateAgents` (atomic w/ the write so a concurrent re-run
 * can't race the stamp), updates the agent's broken record, returns
 * 200 with `{status: "applied", agent: <name>}`.
 */
export async function handleEvaluatorSummary(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
  repo: RepoContext,
  deps: EvaluatorSummaryDeps = {},
): Promise<void> {
  const mutate = deps.mutate ?? mutateAgents;

  let body: unknown;
  try {
    body = await parseBody(req);
  } catch (err) {
    json(res, 400, {
      error: err instanceof Error ? err.message : "Malformed body",
    });
    return;
  }

  let payload: EvaluatorSummaryPayload;
  try {
    payload = parsePayload(body);
  } catch (err) {
    json(res, 400, {
      error: err instanceof Error ? err.message : "Malformed payload",
    });
    return;
  }

  let targetAgent: string | null = null;
  try {
    await mutate(
      repo.localPath,
      (current) => {
        for (const [name, record] of Object.entries(current)) {
          if (record.broken?.evaluator_dispatch_id === dispatchId) {
            const nextBroken: AgentBrokenState = {
              ...record.broken,
              reason: payload.reason,
              suggested_steps: payload.suggested_steps,
              evaluator_status: "completed",
            };
            current[name] = { ...record, broken: nextBroken };
            targetAgent = name;
            return current;
          }
        }
        // Reverse lookup miss. Returning the map unchanged is the right
        // no-op: a stale dispatch posting after a re-run (which cleared
        // the binding) should not write anything. The route surfaces a
        // 404 to the agent after the mutator settles.
        return current;
      },
      "worker",
    );
  } catch (err) {
    log.error(
      `evaluator-summary ${dispatchId} mutate failed for repo ${repo.name}`,
      err,
    );
    json(res, 500, {
      error: err instanceof Error ? err.message : "Settings write failed",
    });
    return;
  }

  if (targetAgent === null) {
    json(res, 404, {
      error: `No agent in repo "${repo.name}" carries evaluator_dispatch_id=${dispatchId} — re-run may have cleared the binding`,
    });
    return;
  }

  json(res, 200, {
    status: "applied",
    agent: targetAgent,
    repo: repo.name,
  });
}
