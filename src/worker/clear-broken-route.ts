/**
 * Worker HTTP handler for `POST /api/clear-broken` (DX-369 — Phase 6 of
 * DX-363).
 *
 * Owns the operator-triggered unblock path: clear `agent.broken = null`
 * AND zero `agent.strikes.count` so the picker re-admits the agent on
 * the next tick. `strikes.history[]` is preserved unchanged on the
 * record as the immediate-forensics audit window (capped at
 * `STRIKES_HISTORY_CAP = 3` by the schema — the next strike rotation
 * after a re-broken cycle pushes the oldest entry out).
 *
 * Forever-preservation of cleared strike history is NOT implemented —
 * the on-record `strikes.history[]` is the audit window the dashboard
 * banner reads. Operators who need longer retention can consult
 * dispatch JSONLs by `dispatch_id` (the strike entry's `dispatch_id`
 * stays correlatable to the underlying `~/.claude/projects/.../<uuid>.jsonl`
 * file the dispatch tracker resolves it from).
 *
 * The route lives on the WORKER (not the dashboard) so the per-file
 * `mutateAgents` lock and the settings.json write happen on the same
 * process that runs the picker — eliminates a cross-process race where
 * a worker-emitted broken stamp could land between a dashboard-issued
 * clear and the picker's next pickup decision.
 *
 * Body: `{name: "<agent-name>"}` — the agent within the worker's repo
 * to unblock.
 *
 * Status codes:
 *   - 200 — broken cleared + strikes zeroed. Response body carries the
 *           pre-clear strike snapshot so the dashboard proxy can echo
 *           it back to the SPA for the operator-facing toast on success.
 *   - 400 — body missing `name` OR agent is not in broken state.
 *   - 404 — agent not found in the worker's repo.
 *   - 500 — settings write failed.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import {
  mutateAgents,
  type AgentRecord,
  type AgentStrikes,
} from "../settings-file.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-clear-broken-route");

export interface ClearBrokenDeps {
  /** Override the agents mutator for unit tests. */
  mutate?: typeof mutateAgents;
}

interface MutateOutcome {
  agentMissing: boolean;
  notBroken: boolean;
  /** Pre-clear strikes — echoed back so the dashboard proxy can audit. */
  clearedStrikes: AgentStrikes | null;
}

/**
 * Atomically clear the agent's broken record + zero its strike count.
 * Returns the mutation outcome so the caller can map to the right HTTP
 * status. The pre-clear strikes snapshot is returned so the dashboard
 * proxy can stamp a parallel audit-log entry without re-reading settings.
 */
async function clearBrokenBinding(
  mutate: typeof mutateAgents,
  repoLocalPath: string,
  agentName: string,
): Promise<MutateOutcome> {
  const outcome: MutateOutcome = {
    agentMissing: false,
    notBroken: false,
    clearedStrikes: null,
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
      outcome.clearedStrikes = {
        count: record.strikes.count,
        history: [...record.strikes.history],
      };
      // Zero count, preserve history. History is capped at
      // STRIKES_HISTORY_CAP by the schema so a subsequent strike-
      // and-rebreak cycle rotates the oldest entry out — operators
      // who need longer retention consult dispatch JSONLs by
      // `dispatch_id` (the entry stays correlatable). Explicit
      // `AgentRecord` annotation locks the merged shape against
      // future schema drift.
      const next: AgentRecord = {
        ...record,
        broken: null,
        strikes: { count: 0, history: record.strikes.history },
        updated_at: new Date().toISOString(),
      };
      current[agentName] = next;
      return current;
    },
    "worker",
  );
  return outcome;
}

export async function handleClearBroken(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
  deps: ClearBrokenDeps = {},
): Promise<void> {
  const mutate = deps.mutate ?? mutateAgents;

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
    outcome = await clearBrokenBinding(mutate, repo.localPath, name);
  } catch (err) {
    log.error(`clear-broken(${repo.name}, ${name}) mutate failed`, err);
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
      error: `Agent "${name}" is not in broken state — nothing to clear`,
    });
    return;
  }

  log.info(
    `clear-broken(${repo.name}, ${name}): broken cleared, strikes zeroed (preserved ${outcome.clearedStrikes?.history.length ?? 0} history entries)`,
  );
  json(res, 200, {
    status: "cleared",
    repo: repo.name,
    agent: name,
    cleared_strikes: outcome.clearedStrikes,
  });
}
