/**
 * Best-effort `danx_issue_save` on the dispatch's tracked issue. Phase 3
 * of the tracker-agnostic-agents epic (Trello wsb4TVNT) wires this into
 * `handleStop` so an agent that calls `danxbot_complete` directly
 * (without an explicit `danx_issue_save`) still gets its YAML pushed to
 * the tracker before the process exits.
 *
 * Lookup chain:
 *   1. `getDispatch(jobId)` → trigger metadata.
 *   2. `trigger === "trello"` && `metadata.cardId` → external_id.
 *   3. Anything else (Slack, api, missing row) → no-op.
 *
 * Errors (DB lookup failure, sync exception) are logged and swallowed —
 * a tracker hiccup must NEVER block the agent's terminal state from
 * landing. The agent already passed `danxbot_complete`; the worker must
 * not turn that into a stall.
 *
 * Lives in its own module so unit tests can import + exercise it
 * without dragging the full `worker/dispatch.ts` chain (which imports
 * config + DB + Slack listener at module load time).
 */

import { syncTrackedIssueOnComplete } from "./issue-route.js";
import { createLogger } from "../logger.js";
import type {
  Dispatch,
  TrelloTriggerMetadata,
} from "../dashboard/dispatches.js";
import type { RepoContext } from "../types.js";

const log = createLogger("auto-sync");

export interface AutoSyncDeps {
  getDispatch: (jobId: string) => Promise<Dispatch | null>;
  runSync: typeof syncTrackedIssueOnComplete;
}

/**
 * Lazy-load `getDispatchById` so this module's top-level import doesn't
 * pull `src/config.ts` (which validates DB env vars at module-init).
 * Tests pass their own `getDispatch` and never hit this path; the lazy
 * import only fires for production calls. Per
 * `.claude/rules/danx-repo-workflow.md` "Isolate Pure Helpers".
 */
async function defaultGetDispatch(jobId: string): Promise<Dispatch | null> {
  const { getDispatchById } = await import(
    "../dashboard/dispatches-db.js"
  );
  return getDispatchById(jobId);
}

export async function autoSyncTrackedIssue(
  jobId: string,
  repo: RepoContext,
  deps: AutoSyncDeps = {
    getDispatch: defaultGetDispatch,
    runSync: syncTrackedIssueOnComplete,
  },
): Promise<void> {
  try {
    const row = await deps.getDispatch(jobId);
    if (!row || row.trigger !== "trello") return;
    // The `Dispatch.trigger === "trello"` discriminator pins
    // `triggerMetadata` to `TrelloTriggerMetadata` shape — see
    // `src/dashboard/dispatches.ts`. The cast is type-safe given the
    // discriminator check above, and a future rename of `cardId` would
    // surface as a compile error here rather than as a silent runtime
    // miss.
    const meta = row.triggerMetadata as TrelloTriggerMetadata;
    const externalId = meta.cardId;
    if (!externalId) return;
    const result = await deps.runSync(jobId, repo, externalId);
    if (!result.ok && result.errors.length > 0) {
      log.warn(
        `[Dispatch ${jobId}] danxbot_complete auto-sync skipped: ${result.errors.join("; ")}`,
      );
    }
  } catch (err) {
    log.error(
      `[Dispatch ${jobId}] danxbot_complete auto-sync failed (non-fatal)`,
      err,
    );
  }
}
