/**
 * DX-645 (Phase 3 of DX-576) — sync-repair dispatcher.
 *
 * Subscribes to the `sync-repair-needed` event emitted by
 * `dispatchWithRecovery` when `syncWorktree` returns
 * `kind: "abort"` (rebase-against-origin/main blew up — usually
 * because a prior dispatch left autosave commits on the agent branch
 * AND main has moved). For every event scoped to THIS worker's repo:
 *
 *   1. Generate a fresh dispatch UUID (the dispatch row's id, also
 *      the per-callback URL bearer).
 *   2. Re-check that the agent is still broken (race protection — the
 *      operator may have cleared the field between the emit and our
 *      subscriber running). The broken stamp landed inline in
 *      `dispatchWithRecovery` BEFORE the emit, so on the happy path
 *      the read always finds a populated record; the no-op exit
 *      handles a concurrent operator clear without racing.
 *   3. Dispatch the `worktree-repair` workspace with `agent_name = null`
 *      on the dispatch row so the strike accumulator's
 *      `agent_name != null` guard short-circuits — the repair dispatch
 *      itself does NOT count toward the broken agent's strikes (the
 *      original dispatch already failed and was attributed). Strike-
 *      counter decision per the card's "bypass naturally" branch.
 *   4. The repair prompt names the broken agent + the broken worktree
 *      path + the abort reason; the workspace's CLAUDE.md / plugin
 *      skill carry the contract body.
 *   5. On terminal `completed`: programmatically clear `agent.broken`
 *      via the same atomic mutation `clear-broken-route.ts` uses
 *      (zero strike count, preserve history). On terminal `failed`:
 *      LEAVE THE STAMP IN PLACE — operator-gate behavior preserved
 *      as the fallback for genuine application-code conflicts that
 *      the repair agent could not resolve.
 *
 * The dispatcher does NOT touch the broken agent's worktree directly.
 * The dispatched repair agent navigates into the worktree via Bash
 * (the prompt names the absolute path); the workspace cwd remains
 * `<repo>/.danxbot/workspaces/worktree-repair/` so the dispatch
 * resolver's workspace.yml + .mcp.json conventions hold.
 *
 * Returns the unsubscribe handle so the worker shutdown path can
 * detach the listener.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { dispatchEvents } from "../dispatch/events.js";
import type { SyncRepairNeededEvent } from "../dispatch/events.js";
import { dispatch as defaultDispatch } from "../dispatch/core.js";
import {
  mutateAgents as defaultMutateAgents,
  readSettings as defaultReadSettings,
  type AgentRecord,
} from "../settings-file.js";
import type { RepoContext } from "../types.js";
import type { AgentJob } from "./launcher.js";
import { agentWorktreePath } from "./worktree-manager.js";

const log = createLogger("sync-repair-dispatcher");

export interface SyncRepairDispatcherDeps {
  repo: RepoContext;
  /** Override the dispatch entry-point for unit tests. */
  dispatchFn?: typeof defaultDispatch;
  /** Override the agents mutator for unit tests. */
  mutateAgents?: typeof defaultMutateAgents;
  /** Override the settings reader for unit tests. */
  readSettings?: typeof defaultReadSettings;
  /**
   * UUID generator — defaults to `randomUUID()`. Tests inject a
   * deterministic stub so the dispatched row's id stays stable.
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

function resolveDeps(deps: SyncRepairDispatcherDeps): ResolvedDeps {
  return {
    repo: deps.repo,
    dispatchFn: deps.dispatchFn ?? defaultDispatch,
    mutateAgents: deps.mutateAgents ?? defaultMutateAgents,
    readSettings: deps.readSettings ?? defaultReadSettings,
    uuid: deps.uuid ?? randomUUID,
  };
}

/**
 * Verify the broken stamp is still in place before dispatching the
 * repair. Returns the populated broken record on the happy path,
 * `null` when the agent is missing OR the broken field was cleared
 * (concurrent operator clear). The check is a single read — we do
 * NOT hold a lock across the dispatch call, so a clear that lands
 * AFTER this check still produces an extra repair dispatch. That is
 * harmless: the repair agent's idempotent steps (rebase → push)
 * either succeed (and re-clear broken — a no-op when it is already
 * null) or fail and re-stamp. The cost of the extra dispatch is
 * dwarfed by the cost of holding a lock for the duration of a 30s+
 * dispatch.
 */
function loadBrokenRecord(
  deps: ResolvedDeps,
  agentName: string,
): AgentRecord["broken"] {
  try {
    const settings = deps.readSettings(deps.repo.localPath);
    const record = settings.agents?.[agentName];
    if (!record || record.broken === null) {
      log.warn(
        `sync-repair-needed for ${agentName} but agent missing or not broken — skipping repair dispatch`,
      );
      return null;
    }
    return record.broken;
  } catch (err) {
    log.error(
      `failed to read settings for repair dispatch on ${agentName}`,
      err,
    );
    return null;
  }
}

/**
 * Clear `agent.broken = null` AND zero `agent.strikes.count` for the
 * named agent. Mirrors the mutation `src/worker/clear-broken-route.ts`
 * performs on the operator-driven path — but called programmatically
 * from the repair dispatch's `onComplete` so the operator does not
 * have to click anything for the steady-state autosave-rebase-
 * conflict class.
 *
 * Preserves strike history (the on-record audit window). Only clears
 * when `evaluator_dispatch_id` was NOT populated — a repair dispatch
 * landing AFTER a separate evaluator dispatch arms a strike-3 broken
 * record could otherwise wipe the evaluator's analysis. Practically
 * this is rare (the sync-repair stamp uses
 * `defaultBrokenEvaluator()` which leaves `evaluator_dispatch_id`
 * null, so the guard is a safety net rather than a routine
 * condition), but the safety net costs one field comparison and
 * preserves an entire class of operator-visible state.
 */
async function clearBrokenIfStillSyncRepair(
  deps: ResolvedDeps,
  agentName: string,
): Promise<{ cleared: boolean; reason?: string }> {
  let cleared = false;
  let skipReason: string | undefined;
  try {
    await deps.mutateAgents(
      deps.repo.localPath,
      (current) => {
        const record = current[agentName];
        if (!record) {
          skipReason = "agent record missing";
          return current;
        }
        if (record.broken === null) {
          skipReason = "broken already cleared (concurrent operator action)";
          return current;
        }
        if (record.broken.evaluator_dispatch_id !== null) {
          // A strike-3 evaluator dispatch armed THIS broken record
          // alongside the sync-repair flow — clearing it here would
          // delete operator-visible diagnostics the evaluator wrote.
          // Leave the stamp; let the operator clear via dashboard.
          skipReason =
            "broken record carries an evaluator binding — leaving for operator review";
          return current;
        }
        current[agentName] = {
          ...record,
          broken: null,
          strikes: {
            count: 0,
            history: record.strikes.history,
          },
          updated_at: new Date().toISOString(),
        };
        cleared = true;
        return current;
      },
      "worker",
    );
  } catch (err) {
    log.error(
      `failed to clear broken record for ${agentName} after sync-repair completion`,
      err,
    );
    return { cleared: false, reason: "mutate threw" };
  }
  return { cleared, reason: skipReason };
}

/**
 * Build the repair prompt body. The persona block is injected by
 * `dispatch()` when `agent` is set; we leave `agent` unset on the
 * repair dispatch (the broken agent's bio describes the original
 * work persona, not the repair task) and embed worktree + branch +
 * abort context directly into the task body. The workspace's
 * CLAUDE.md is the authoritative contract — the prompt is a thin
 * pointer.
 */
export function buildSyncRepairPrompt(opts: {
  agentName: string;
  worktreePath: string;
  abortReason: string;
  abortDetails: string;
}): string {
  const detailsBlock =
    opts.abortDetails.trim().length > 0
      ? "Verbatim git stderr:\n```\n" +
        opts.abortDetails.slice(0, 4000) +
        "\n```\n\n"
      : "";
  return (
    "Repair the wedged worktree of the agent named below. The agent's\n" +
    "branch hit a rebase abort against `origin/main`; the picker has\n" +
    `stamped \`agents.${opts.agentName}.broken\` as a gate so no further\n` +
    "dispatch lands until you resolve the conflict.\n\n" +
    `Broken agent: \`${opts.agentName}\`\n` +
    `Worktree: \`${opts.worktreePath}\`\n` +
    `Agent branch: \`${opts.agentName}\`\n` +
    `Abort reason: ${opts.abortReason}\n\n` +
    detailsBlock +
    "Contract — execute every step. Stop and call `danxbot_complete`\n" +
    "with `status: \"failed\"` only when a conflict region is\n" +
    "genuinely unreconcilable (e.g. same line of an application-code\n" +
    "file edited semantically incompatible on both sides). The\n" +
    "dispatcher's `onComplete` clears `agent.broken` programmatically\n" +
    "on terminal `completed`; on `failed` the existing broken stamp\n" +
    "persists and the operator-gate engages as the fallback.\n\n" +
    "1. `cd` into the worktree path above. (You are spawned in a\n" +
    "   workspace cwd, NOT in the worktree — every git op must run\n" +
    "   inside the worktree.)\n" +
    "2. Run the Pre-task sync contract from `CLAUDE.md`:\n" +
    "   - `git fetch origin`\n" +
    "   - If `git status --porcelain` is non-empty: commit as\n" +
    "     `wip(autosave): pre-sync snapshot of prior-dispatch residue`\n" +
    "     on the agent branch.\n" +
    "   - `git rebase origin/main`. On conflict, resolve in place\n" +
    "     file by file:\n" +
    "     * Files under `.danxbot/workspaces/*/` take `origin/main`'s\n" +
    "       side (they regenerate per tick from the inject pipeline\n" +
    "       and carry no agent-authored content worth preserving).\n" +
    "     * Other files: read both sides, reconcile on merit.\n" +
    "     * `git add <path>` + `git rebase --continue` until rebase\n" +
    "       reports `Successfully rebased`.\n" +
    "   - `git push --force-with-lease` to update the remote agent\n" +
    "     branch. Never `--force`.\n" +
    "3. Verify the result:\n" +
    "   - `git rev-list --left-right --count origin/main...HEAD`\n" +
    "     should produce `<ahead>\\t0` (zero behind).\n" +
    "   - `git status --porcelain` empty.\n" +
    "4. Call `danxbot_complete({status: \"completed\", summary: \"...\"})`.\n" +
    "   The dispatcher's onComplete clears the broken stamp.\n\n" +
    "If you cannot complete the rebase (genuine application-code\n" +
    "conflict you cannot reconstruct intent for), do NOT\n" +
    "`git rebase --abort` quietly. Call\n" +
    "`danxbot_complete({status: \"failed\", summary: \"<exact file +\n" +
    "region>: <why unreconcilable>\"})`. The dispatcher leaves\n" +
    "`agent.broken` populated; the operator clears it via the\n" +
    "dashboard after resolving manually.\n"
  );
}

/** Spawn the worktree-repair dispatch. Returns true on success. */
async function spawnRepairDispatch(
  deps: ResolvedDeps,
  event: SyncRepairNeededEvent,
  dispatchId: string,
): Promise<boolean> {
  // Use the canonical builder so a malformed `agentName` fails fast via
  // `assertAgentName()` (defense-in-depth against a future event payload
  // that carries a path-traversal-shaped name).
  let worktreePath: string;
  try {
    worktreePath = agentWorktreePath(deps.repo.hostPath, event.agentName);
  } catch (err) {
    log.error(
      `sync-repair: invalid agent name "${event.agentName}" — skipping dispatch`,
      err,
    );
    return false;
  }
  const prompt = buildSyncRepairPrompt({
    agentName: event.agentName,
    worktreePath,
    abortReason: event.abortReason,
    abortDetails: event.abortDetails,
  });
  try {
    await deps.dispatchFn({
      repo: deps.repo,
      task: prompt,
      workspace: "worktree-repair",
      overlay: {},
      apiDispatchMeta: {
        trigger: "api",
        metadata: {
          endpoint: "/internal/sync-repair-dispatcher",
          callerIp: null,
          statusUrl: null,
          initialPrompt: prompt,
          workspace: "worktree-repair",
        },
      },
      dispatchId,
      title: `Sync repair: ${event.agentName}`,
      // The repair dispatch is worker-initiated (agent_name = null on
      // the dispatch row). Strikes are agent-scoped; the row's null
      // agent name short-circuits the strike accumulator, so the
      // broken agent's strike counter is untouched by repair
      // outcomes — desired behavior per the card's "bypass strike
      // counter" decision.
      onComplete: (job: AgentJob) => {
        // Fire-and-forget. `clearBrokenIfStillSyncRepair` swallows its
        // own mutator errors; the outer try/catch is belt-and-suspenders
        // so a logger throw (rare but theoretically possible on a
        // misconfigured stdout) cannot surface as an unhandled
        // rejection up the dispatch finalize chain.
        void (async () => {
          try {
            if (job.status === "completed") {
              const outcome = await clearBrokenIfStillSyncRepair(
                deps,
                event.agentName,
              );
              if (outcome.cleared) {
                log.info(
                  `sync-repair ${dispatchId} completed for ${event.agentName} — broken cleared`,
                );
              } else {
                log.warn(
                  `sync-repair ${dispatchId} completed for ${event.agentName} but broken NOT cleared: ${outcome.reason}`,
                );
              }
              return;
            }
            log.warn(
              `sync-repair ${dispatchId} for ${event.agentName} terminated with status=${job.status} — broken stamp preserved, operator gate engaged`,
            );
          } catch (err) {
            log.error(
              `sync-repair ${dispatchId} onComplete handler threw for ${event.agentName}`,
              err,
            );
          }
        })();
      },
    });
    return true;
  } catch (err) {
    log.error(
      `sync-repair dispatch threw synchronously for ${event.agentName}`,
      err,
    );
    return false;
  }
}

/**
 * Single-event handler. Re-checks broken state → spawns repair.
 * Each step is its own helper above so orchestration stays at one
 * level of detail.
 */
async function handleSyncRepairNeeded(
  deps: ResolvedDeps,
  event: SyncRepairNeededEvent,
): Promise<void> {
  if (event.repoName !== deps.repo.name) return;

  const broken = loadBrokenRecord(deps, event.agentName);
  if (broken === null) return;

  const dispatchId = deps.uuid();
  await spawnRepairDispatch(deps, event, dispatchId);
}

/**
 * Subscribe to `sync-repair-needed` and dispatch the worktree-repair
 * agent on every event for this worker's repo. Returns an
 * unsubscribe handle the worker shutdown path can call.
 */
export function startSyncRepairDispatcher(
  deps: SyncRepairDispatcherDeps,
): () => void {
  const resolved = resolveDeps(deps);
  const handler = (event: SyncRepairNeededEvent): Promise<void> =>
    handleSyncRepairNeeded(resolved, event);
  dispatchEvents.on("sync-repair-needed", handler);
  return () => dispatchEvents.off("sync-repair-needed", handler);
}
