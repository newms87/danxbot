/**
 * Auto-resume on worker boot (extension of DX-209 / Phase 2c reattach).
 *
 * When the boot scan finds a non-terminal dispatch row whose `host_pid`
 * is dead, the legacy behavior is to mark the row `failed` and surface
 * the orphan summary. That loses the in-flight session context — the
 * card stays In Progress, but the next agent (whether the same persona
 * or another) starts from zero, having to rediscover what the prior
 * dispatch was mid-doing.
 *
 * This module adds an auto-resume branch in front of the orphan-mark:
 * when ALL of the following hold, spawn a fresh dispatch with
 * `claude --resume <sessionId>` so the new agent inherits the full
 * conversation history of the dead session:
 *
 *   1. The row has a `sessionUuid` (the parent session UUID parsed off
 *      the JSONL filename by `extractSessionUuidFromJsonlPath`).
 *   2. The row has a `jsonlPath` (the on-disk session log still exists;
 *      `claude --resume` will read it back to seed conversation state).
 *   3. There is an In Progress YAML in `<repo>/.danxbot/issues/open/`
 *      whose `dispatch.id` matches the dead row's id. (The card is
 *      genuinely mid-work — not a row whose YAML already moved to
 *      `closed/` because the agent committed + closed the card just
 *      before the worker died.)
 *   4. The workspace name is recoverable from the row: trello-triggered
 *      dispatches use `issue-worker` (hard-coded by the poller); api-
 *      triggered dispatches stored their workspace in
 *      `triggerMetadata.workspace` (DX-84). Slack-triggered and any
 *      legacy rows without a recoverable workspace skip.
 *
 * On success: marks the parent row `recovered` (a terminal status, like
 * `cancelled`), stamps the new child's id in the summary, and the child
 * dispatch row carries `parent_job_id` pointing back at the parent.
 * Operators walking the resume chain via `parent_job_id` see the same
 * link they'd see for an explicit `POST /api/resume`.
 *
 * On any failure (no YAML, missing sessionUuid, persona load failure,
 * dispatch() throw): caller falls back to the legacy `markOrphaned`
 * behavior — the dispatch row ends up `failed`, the card stays In
 * Progress with a stale `dispatch{}` block, and the next agent starts
 * fresh.
 *
 * Tests live alongside `reattach.test.ts` — see the `auto-resume`
 * describe block there for happy path + each refusal branch.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "../logger.js";
import { updateDispatch } from "../dashboard/dispatches-db.js";
import { dispatch } from "../dispatch/core.js";
import { findInProgressIssueByDispatchId } from "../poller/local-issues.js";
import {
  clearDispatchAndWrite,
  issuePath,
  loadLocal,
  stampDispatchAndWrite,
} from "../poller/yaml-lifecycle.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import { deriveStatus } from "../issue/derive-status.js";
import { readSettings } from "../settings-file.js";
import type { Dispatch } from "../dashboard/dispatches.js";
import type { Issue, IssueDispatch } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-reattach-resume");

const AUTO_RESUME_TRIGGER_REASON = "worker_boot_auto_resume";

export interface AutoResumeOutcome {
  /** True when a fresh dispatch with `--resume` was spawned and the parent row marked `recovered`. */
  resumed: boolean;
  /** Child dispatch id when `resumed === true`. */
  childDispatchId?: string;
  /** Reason caller should fall through to legacy orphan-mark when `resumed === false`. */
  refusalReason?:
    | "no-session-uuid"
    | "no-jsonl-path"
    | "no-workspace"
    | "no-matching-yaml"
    | "card-not-in-progress-on-disk"
    | "dispatch-threw";
}

/**
 * Map a dispatch row's trigger → workspace name. Trello rows use the
 * poller's hard-coded `issue-worker`; api rows carry their workspace
 * in trigger metadata. Slack-triggered rows return `null` — we don't
 * auto-resume slack threads (no card-bound YAML to anchor the resume).
 *
 * Exported for testability.
 */
export function resolveWorkspaceForReattach(row: Dispatch): string | null {
  if (row.trigger === "trello") return "issue-worker";
  if (row.trigger === "api") {
    const meta = row.triggerMetadata as { workspace?: string };
    return typeof meta.workspace === "string" && meta.workspace.length > 0
      ? meta.workspace
      : null;
  }
  return null;
}

/**
 * Build the "continue" prompt body for the resumed dispatch's first
 * user turn. `claude --resume` rehydrates the entire prior conversation;
 * this string is only the NEXT user turn that nudges the agent to
 * continue from where it left off. Keep it short — the model already
 * has full context.
 */
function buildAutoResumePrompt(issue: Issue, repoLocalPath: string): string {
  const yamlPath = `${repoLocalPath}/.danxbot/issues/open/${issue.id}.yml`;
  return [
    `Continue from where you left off. The worker process restarted mid-task; your Claude session was resumed via --resume so the prior conversation is intact.`,
    ``,
    `Your card: ${issue.id} (${issue.title})`,
    `YAML: ${yamlPath}`,
    ``,
    `Edit the YAML directly with Edit/Write. Call danxbot_complete when done.`,
  ].join("\n");
}

/**
 * Try to auto-resume a dead-PID dispatch row. See module docstring for
 * the full contract. Caller (`reattachOrResolveDispatches`) invokes
 * this BEFORE `markOrphaned`; on `resumed: false` the caller falls
 * through to the legacy path.
 *
 * Idempotent on infrastructure: an exception from `dispatch()` is
 * caught, logged, and surfaces as `{resumed: false, refusalReason:
 * "dispatch-threw"}` so the boot scan continues to the next row.
 */
export async function attemptAutoResume(
  row: Dispatch,
  repo: RepoContext,
): Promise<AutoResumeOutcome> {
  if (!row.sessionUuid) {
    return { resumed: false, refusalReason: "no-session-uuid" };
  }
  if (!row.jsonlPath) {
    return { resumed: false, refusalReason: "no-jsonl-path" };
  }
  const workspace = resolveWorkspaceForReattach(row);
  if (!workspace) {
    return { resumed: false, refusalReason: "no-workspace" };
  }

  const issue = await findInProgressIssueByDispatchId(repo.localPath, row.id);
  if (!issue) {
    return { resumed: false, refusalReason: "no-matching-yaml" };
  }

  // DX-655 — disk re-verify gate. `findInProgressIssueByDispatchId`
  // reads `dbListOpenIssues`, which lags the on-disk truth by up to
  // the chokidar 5s mirror debounce. Within that window an agent that
  // has already stamped `blocked.at` / `completed_at` / `cancelled_at`
  // / `requires_human` on disk still appears In Progress in the DB,
  // and the legacy gate would re-launch the terminal card on every
  // worker restart — producing the DX-655 dispatch loop. Reading the
  // YAML directly off disk and re-deriving the semantic status is the
  // authoritative check; the DB-backed `findInProgressIssueByDispatchId`
  // call above is kept as the cheap pre-filter for the common case
  // (most rows the boot scan walks are not loop-class). Refuse on:
  //   - derived status != In Progress (rules 1/2/3/6/7 → terminal-ish)
  //   - requires_human != null (orthogonal dispatch gate; auto-resume
  //     would defeat the human-gate by re-launching the card the
  //     operator just parked)
  const openYamlPath = issuePath(repo.localPath, issue.id, "open");
  if (existsSync(openYamlPath)) {
    try {
      const onDisk = parseIssue(readFileSync(openYamlPath, "utf-8"), {
        expectedPrefix: repo.issuePrefix,
      });
      const derived = deriveStatus(onDisk);
      if (derived !== "In Progress" || onDisk.requires_human !== null) {
        log.info(
          `[Dispatch ${row.id}] auto-resume: refused — on-disk derived=${derived}, requires_human=${onDisk.requires_human !== null} (DB mirror was stale)`,
        );
        return {
          resumed: false,
          refusalReason: "card-not-in-progress-on-disk",
        };
      }
    } catch (err) {
      // YAML missing / unparseable on disk is itself a refusal — the
      // dispatch can't proceed without a card. Fall through to the
      // existing no-matching-yaml semantics; caller still falls back
      // to markOrphaned and the operator sees the row as failed.
      log.warn(
        `[Dispatch ${row.id}] auto-resume: disk re-verify threw — refusing resume`,
        err,
      );
      return { resumed: false, refusalReason: "card-not-in-progress-on-disk" };
    }
  }

  const agent = (() => {
    if (!row.agentName) return undefined;
    try {
      const settings = readSettings(repo.localPath);
      const record = settings.agents?.[row.agentName];
      if (!record) return undefined;
      return { name: row.agentName, bio: record.bio };
    } catch (err) {
      log.warn(
        `[Dispatch ${row.id}] auto-resume: failed to load persona '${row.agentName}'; resume will proceed without it`,
        err,
      );
      return undefined;
    }
  })();

  const task = buildAutoResumePrompt(issue, repo.localPath);

  // Pre-generate the child dispatchId so we can stamp the YAML's
  // `dispatch{}` block on it BEFORE the runtime fork resolves the PID.
  // This is the same pattern the poller-spawn path uses (`multi-agent-
  // pick.ts` line ~340): without it the YAML keeps advertising the
  // dead parent's dispatch+PID, and the poller's `tryResumeOrphan` on
  // the next tick re-spawns the card — racing this auto-resume child
  // and producing two live agents against the same In Progress YAML.
  const childDispatchId = randomUUID();
  const startStamp: IssueDispatch = {
    id: childDispatchId,
    pid: 0,
    host: hostname(),
    kind: "work",
    started_at: new Date().toISOString(),
    ttl_seconds: 7_200,
  };

  try {
    const result = await dispatch({
      repo,
      task,
      workspace,
      overlay: {},
      apiDispatchMeta: {
        trigger: "api",
        metadata: {
          endpoint: "/internal/auto-resume",
          callerIp: null,
          statusUrl: null,
          initialPrompt: task,
          workspace,
        },
      },
      resumeSessionId: row.sessionUuid,
      parentJobId: row.id,
      issueId: issue.id,
      agent,
      dispatchId: childDispatchId,
      pairedWriteYaml: {
        write: async (pid: number) => {
          const enriched: IssueDispatch = { ...startStamp, pid };
          const fresh = await loadLocal(
            repo.localPath,
            issue.id,
            repo.issuePrefix,
          );
          if (!fresh) {
            throw new Error(
              `auto-resume paired-write: YAML for ${issue.id} disappeared during dispatch`,
            );
          }
          await stampDispatchAndWrite(repo.localPath, fresh, enriched);
        },
        clear: async () => {
          const fresh = await loadLocal(
            repo.localPath,
            issue.id,
            repo.issuePrefix,
          );
          if (fresh && fresh.dispatch !== null) {
            await clearDispatchAndWrite(repo.localPath, fresh);
          }
        },
      },
      env: { DANXBOT_AUTO_RESUME_REASON: AUTO_RESUME_TRIGGER_REASON },
    });

    // Mark parent `cancelled` (closest existing terminal status — the
    // dispatch ended without producing its own terminal signal, and we
    // explicitly handed the work off to the child). A bespoke
    // `"recovered"` status would force a schema migration + cascade
    // through TERMINAL_STATUSES, dashboard color maps, and every status-
    // filter UI; `cancelled` + the auto-resume summary captures the
    // operator-visible signal today. The child's `parent_job_id` is the
    // structural link.
    const completedAt = Date.now();
    await updateDispatch(row.id, {
      status: "cancelled",
      summary: `Auto-resume on worker boot — child dispatch ${result.dispatchId}`,
      completedAt,
      pidTerminatedAt: completedAt,
    });

    log.info(
      `[Dispatch ${row.id}] auto-resume: spawned child ${result.dispatchId} on ${issue.id} (workspace=${workspace}, agent=${row.agentName ?? "none"})`,
    );

    return { resumed: true, childDispatchId: result.dispatchId };
  } catch (err) {
    log.error(
      `[Dispatch ${row.id}] auto-resume: dispatch() threw — falling back to orphan-mark`,
      err,
    );
    return { resumed: false, refusalReason: "dispatch-threw" };
  }
}
