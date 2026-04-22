/**
 * Worker endpoint for clearing the per-repo critical-failure flag.
 *
 * Routing: `DELETE /api/poller/critical-failure` → this handler.
 * Only the dashboard proxy calls it (via user bearer auth at the
 * dashboard boundary); the worker itself does not re-authenticate —
 * workers are only reachable on `danxbot-net` so reaching the endpoint
 * already implies the caller passed the dashboard auth gate.
 *
 * See `.claude/rules/agent-dispatch.md` "Critical failure flag" for
 * the full contract.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { clearFlag } from "../critical-failure.js";
import type { RepoContext } from "../types.js";

const log = createLogger("critical-failure-route");

export interface ClearCriticalFailureResponse {
  cleared: boolean;
}

/**
 * Idempotent clear. Returns 200 `{cleared: true}` when the flag
 * existed and was deleted, 200 `{cleared: false}` when it was already
 * absent. Unexpected filesystem errors (EACCES on the repo dir, etc.)
 * become 500 — those are misconfig, not "already clear".
 */
export async function handleClearCriticalFailure(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
): Promise<void> {
  try {
    const cleared = clearFlag(repo.localPath);
    log.info(
      `[${repo.name}] Critical-failure flag clear requested — cleared=${cleared}`,
    );
    const body: ClearCriticalFailureResponse = { cleared };
    json(res, 200, body);
  } catch (err) {
    log.error(`[${repo.name}] Failed to clear critical-failure flag`, err);
    json(res, 500, {
      error:
        err instanceof Error
          ? err.message
          : "Failed to clear critical-failure flag",
    });
  }
}
