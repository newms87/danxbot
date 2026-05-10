export type TriggerType = "slack" | "trello" | "api";

export type DispatchStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RuntimeMode = "docker" | "host";

export interface SlackTriggerMetadata {
  channelId: string;
  threadTs: string;
  messageTs: string;
  user: string;
  userName: string | null;
  messageText: string;
}

export interface TrelloTriggerMetadata {
  cardId: string;
  cardName: string;
  cardUrl: string;
  listId: string;
  listName: string;
}

export interface ApiTriggerMetadata {
  endpoint: string;
  callerIp: string | null;
  statusUrl: string | null;
  initialPrompt: string;
  /**
   * Workspace name the dispatch ran under (`issue-worker`, `board-chat`,
   * caller-supplied schema workspace, ...). DX-84 added this so the
   * dashboard's per-board chat list can filter to `workspace =
   * "board-chat"` without scanning every api dispatch row. Optional —
   * pre-DX-84 rows have it absent and the chat list query treats absent
   * as "not a chat session" (which is the right answer for legacy rows).
   */
  workspace?: string;
}

export type DispatchTriggerMetadata =
  | { trigger: "slack"; metadata: SlackTriggerMetadata }
  | { trigger: "trello"; metadata: TrelloTriggerMetadata }
  | { trigger: "api"; metadata: ApiTriggerMetadata };

export interface DispatchUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  toolCallCount: number;
  subagentCount: number;
  nudgeCount: number;
}

export interface Dispatch {
  id: string;
  repoName: string;
  trigger: TriggerType;
  triggerMetadata:
    | SlackTriggerMetadata
    | TrelloTriggerMetadata
    | ApiTriggerMetadata;
  /**
   * Denormalized Slack thread timestamp + channel ID. Populated when
   * `trigger === "slack"` (mirrored from `triggerMetadata.threadTs` /
   * `.channelId`); null for every other trigger. Indexed on
   * `slack_thread_ts` so Phase 2's `findLatestDispatchBySlackThread`
   * lookup hits an index instead of scanning a JSON path.
   *
   * The JSON metadata remains the source of truth for the audit trail;
   * these columns are a thin operational projection. Kept in sync at
   * insert time by `startDispatchTracking` and by the Slack listener's
   * `createSlackDispatch` — there is no drift path today because Slack
   * thread/channel is immutable for a dispatch.
   */
  slackThreadTs: string | null;
  slackChannelId: string | null;
  sessionUuid: string | null;
  jsonlPath: string | null;
  /**
   * Dispatch ID of the parent job when this dispatch was spawned via
   * `POST /api/resume`. Null for regular launches. Lets callers walk the
   * resume chain without scanning JSONL files.
   */
  parentJobId: string | null;
  /**
   * Local issue id (`<PREFIX>-N`, e.g. `DX-84`) when this dispatch was
   * launched against a card-bound YAML in `<repo>/.danxbot/issues/`. NULL
   * for Slack dispatches, ideator runs, board-chat sessions, and any
   * external `/api/launch` that didn't supply an issue id. The dashboard's
   * Agent Chat tab queries this column to list a card's prior dispatches
   * (DX-84 / Phase 2 of the Agent Chat epic).
   */
  issueId: string | null;
  status: DispatchStatus;
  startedAt: number;
  completedAt: number | null;
  summary: string | null;
  error: string | null;
  runtimeMode: RuntimeMode;
  /**
   * OS process id of the spawned claude/script-q-f process. Stamped via
   * `pairedWriteHostPid` AFTER the runtime fork resolves the agent PID
   * — paired with the YAML's `dispatch.pid` so both records carry the
   * same value (DX-140). `null` until the paired-write fires; cleared
   * back to `null` on rollback or termination.
   *
   * Worker startup uses it to distinguish "claude still running across a
   * restart" (PID alive → leave alone) from "orphaned row, owning worker
   * gone" (PID dead OR `null` → mark failed). The poller's pre-claim DB
   * guard reads it to skip cards whose existing dispatch is still live.
   *
   * Pre-DX-140 the column held the worker's `process.pid`. The semantics
   * change matters: under host mode the agent script (parented to PID 1
   * by `script -q -f`) survives every worker restart, so a row whose
   * `host_pid` is the agent PID is still alive after restart even though
   * the worker that spawned it is gone. The original meaning gave
   * divergent verdicts (reconcile saw dead worker PID, poller-reattach
   * saw alive agent PID) — the May-7 incident.
   *
   * `null` for rows inserted before migration 013 lands (legacy rows are
   * treated as orphaned by the first reconciliation after upgrade).
   */
  hostPid: number | null;
  /**
   * Millisecond epoch when `hostPid` was stamped. `null` while the spawn
   * is still in flight, after a paired-write rollback, and on legacy
   * pre-migration-015 rows. See DX-140 for the paired-write contract.
   */
  hostPidAt: number | null;
  /**
   * Millisecond epoch when termination of `hostPid` was confirmed.
   * Stamped by:
   *   - `danxbot_complete` stop handler (agent self-terminated).
   *   - `reconcileOrphanedDispatches` when sweeping a dead PID.
   *   - `cancelJob` (user-initiated cancel).
   * `null` while the row is non-terminal. Together with `hostPidAt` this
   * gives operators the PID's full lifecycle without losing the
   * historical pid value (`hostPid` is not cleared on termination).
   */
  pidTerminatedAt: number | null;
  tokensTotal: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  toolCallCount: number;
  subagentCount: number;
  nudgeCount: number;
  danxbotCommit: string | null;
  /**
   * Resolved agent name (`AGENT_NAME_SHAPE`) when this dispatch was launched
   * against a per-repo persona under the multi-worker pick algorithm
   * (DX-200 / DX-158). NULL for every other trigger — Slack, ideator,
   * external `/api/launch`, and pre-Phase-5 issue-worker dispatches.
   *
   * The poller's `busyAgents(repo)` lookup queries this column with a
   * partial index that skips terminal rows; see migration 018.
   */
  agentName: string | null;
  /**
   * Absolute path to the per-dispatch MCP settings JSON written by
   * `dispatch()` (`src/dispatch/core.ts#writeMcpSettingsFile`) at spawn
   * time — typically `/tmp/danxbot-mcp-XXXX/settings.json`. The file
   * embeds `DANXBOT_STOP_URL` for the live worker port; Phase 2c
   * (DX-209 — DB-driven full-stack reattach) reads this path to
   * rewrite the URL when the worker restarts on a different port.
   *
   * NULL on legacy / pre-DX-207 rows and on dispatches whose workspace
   * had no per-dispatch MCP file written (rare — every dispatch produced
   * by `dispatch()` writes one). Phase 2c falls through to mark-failed
   * for any non-terminal alive PID whose column is NULL — without the
   * path, the agent's `danxbot_complete` callback cannot be reliably
   * routed to the new worker.
   */
  mcpSettingsPath: string | null;
}

export interface DispatchFilters {
  trigger?: TriggerType;
  repo?: string;
  status?: DispatchStatus;
  since?: number;
  q?: string;
}

/** Terminal statuses — a row is "done" and safe to purge under retention. */
export const TERMINAL_STATUSES: readonly DispatchStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminalStatus(status: DispatchStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
