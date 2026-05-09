/**
 * Agent Chat session routes (DX-84 / Phase 2 of the Agent Chat epic).
 *
 * Seven endpoints power the dashboard's per-card and per-board Chat
 * surfaces. They are thin viewers + resumers around the existing
 * single-fork dispatch pipeline — chat is NOT a new spawn shape:
 *
 *   GET  /api/chat/sessions?issue_id=ISS-N        → list dispatches for an issue
 *   GET  /api/chat/sessions/board?repo=<name>     → list board-chat dispatches
 *   GET  /api/chat/sessions/:job_id/timeline      → chain-walked deduped blocks
 *   POST /api/chat/sessions                       → start board-chat (wraps /api/launch)
 *   POST /api/chat/sessions/:job_id/resume        → wraps /api/resume
 *   POST /api/chat/sessions/:job_id/cancel        → wraps /api/cancel/:id
 *   GET  /api/chat/sessions/:job_id/stream        → SSE alias for dispatch:jsonl:<id>
 *
 * Auth: every endpoint sits behind the user-auth gate in `server.ts`.
 * The POST proxies do NOT require `DANXBOT_DISPATCH_TOKEN` because the
 * dashboard already runs inside `danxbot-net` and can reach the worker
 * containers directly — the dispatch token is the *external* gate.
 *
 * Multi-block dedupe is inherited verbatim from `parseJsonlContent` /
 * `dispatch:jsonl:*` SSE topic. No parallel SSE infra here.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import {
  getDispatchById,
  getResumeChain,
  listBoardChatDispatches,
  listDispatchesByIssueId,
} from "./dispatches-db.js";
import { parseJsonlContent } from "./jsonl-reader.js";
import type { JsonlBlock } from "./jsonl-reader.js";
import type { Dispatch } from "./dispatches.js";
import { resolveJsonlPath } from "./jsonl-path-resolver.js";
import { readFile } from "node:fs/promises";
import {
  proxyToWorkerWithFallback,
  type DispatchProxyDeps,
} from "./dispatch-proxy.js";
import { handleStream } from "./stream-routes.js";

const log = createLogger("chat-routes");

const BOARD_CHAT_WORKSPACE = "board-chat";

/**
 * Wire shape the chat list returns — a thin projection of `Dispatch`
 * with the columns the chat header / picker actually renders. Keeps the
 * payload small (chat sessions accumulate) and avoids leaking internal
 * fields like `error` and `host_pid` to the SPA.
 */
interface ChatSessionSummary {
  job_id: string;
  parent_job_id: string | null;
  issue_id: string | null;
  repo: string;
  status: Dispatch["status"];
  summary: string | null;
  started_at: number;
  completed_at: number | null;
  tokens_total: number;
  tool_call_count: number;
  subagent_count: number;
}

function toSummary(d: Dispatch): ChatSessionSummary {
  return {
    job_id: d.id,
    parent_job_id: d.parentJobId,
    issue_id: d.issueId,
    repo: d.repoName,
    status: d.status,
    summary: d.summary,
    started_at: d.startedAt,
    completed_at: d.completedAt,
    tokens_total: d.tokensTotal,
    tool_call_count: d.toolCallCount,
    subagent_count: d.subagentCount,
  };
}

export async function handleListChatSessions(
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const issueId = params.get("issue_id");
  if (!issueId) {
    json(res, 400, { error: "Missing required query param: issue_id" });
    return;
  }
  try {
    const rows = await listDispatchesByIssueId(issueId);
    json(res, 200, rows.map(toSummary));
  } catch (err) {
    log.error(`listChatSessions(${issueId}) failed`, err);
    json(res, 500, { error: "Failed to list chat sessions" });
  }
}

export async function handleListBoardChatSessions(
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const repo = params.get("repo");
  if (!repo) {
    json(res, 400, { error: "Missing required query param: repo" });
    return;
  }
  try {
    const rows = await listBoardChatDispatches(repo);
    json(res, 200, rows.map(toSummary));
  } catch (err) {
    log.error(`listBoardChatSessions(${repo}) failed`, err);
    json(res, 500, { error: "Failed to list board chat sessions" });
  }
}

/**
 * Read every dispatch in the parent chain (oldest first), parse each
 * dispatch's JSONL into blocks, and return one merged ordered timeline
 * with multi-block usage entries deduped by `message.id`.
 *
 * Per-dispatch dedupe is handled by `parseJsonlContent`. Cross-dispatch
 * dedupe is unnecessary because Claude Code uses fresh `message.id`
 * namespaces per session (resume reuses the same JSONL file but turns
 * write distinct messages with new ids).
 */
export async function handleChatTimeline(
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  try {
    const chain = await getResumeChain(jobId);
    if (chain.length === 0) {
      json(res, 404, { error: "Dispatch not found" });
      return;
    }

    const blocks: JsonlBlock[] = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let toolCallCount = 0;

    // Resume chains commonly share the same JSONL path (claude appends
    // resumed turns to the parent's file). Reading the same file once
    // per ancestor is wasteful — track which paths we've already parsed.
    const parsedPaths = new Set<string>();

    for (const dispatch of chain) {
      const path = await resolveJsonlPath(dispatch);
      if (!path || parsedPaths.has(path)) continue;
      parsedPaths.add(path);
      let text: string;
      try {
        text = await readFile(path, "utf-8");
      } catch (err) {
        log.warn(
          `chatTimeline(${jobId}): failed to read JSONL ${path}`,
          err,
        );
        continue;
      }
      const result = parseJsonlContent(text);
      blocks.push(...result.blocks);
      totalTokensIn += result.totals.tokensIn;
      totalTokensOut += result.totals.tokensOut;
      totalCacheRead += result.totals.cacheRead;
      totalCacheWrite += result.totals.cacheWrite;
      toolCallCount += result.totals.toolCallCount;
    }

    // Stable timestamp sort so partial files merged across the chain
    // still render in chronological order. parseJsonlContent already
    // emits blocks in file order; the sort is defense for the unusual
    // case where two ancestors hold concurrent slices.
    blocks.sort((a, b) => a.timestampMs - b.timestampMs);

    json(res, 200, {
      blocks,
      totals: {
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        tokensTotal:
          totalTokensIn + totalTokensOut + totalCacheRead + totalCacheWrite,
        toolCallCount,
      },
      chain: chain.map((d) => d.id),
    });
  } catch (err) {
    log.error(`chatTimeline(${jobId}) failed`, err);
    json(res, 500, { error: "Failed to load chat timeline" });
  }
}

/**
 * `POST /api/chat/sessions` — start a fresh board-chat dispatch.
 * Wraps `/api/launch` with `workspace = "board-chat"`. The repo is
 * required in the body so the worker route can be selected; the
 * `task` is the operator's first message.
 */
export async function handleStartBoardChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchProxyDeps,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const repoName = typeof body.repo === "string" ? body.repo : null;
  const task = typeof body.task === "string" ? body.task : null;
  if (!repoName) {
    json(res, 400, { error: "Missing required field: repo" });
    return;
  }
  if (!task || !task.trim()) {
    json(res, 400, { error: "Missing or blank required field: task" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }
  const launchBody = {
    repo: repoName,
    workspace: BOARD_CHAT_WORKSPACE,
    task,
  };
  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName,
      primaryHost: deps.resolveHost(repoName),
      port: repo.workerPort,
      path: "/api/launch",
      method: "POST",
    },
    JSON.stringify(launchBody),
  );
}

/**
 * `POST /api/chat/sessions/:job_id/resume` — continue an existing chat
 * session by resuming its Claude session UUID. Worker resolves the
 * parent dispatch's session id via `findSessionFileByDispatchId`.
 *
 * The repo + workspace are read from the parent dispatch row so the SPA
 * only needs the `job_id` + the operator's next `task`. `workspace` is a
 * required field on `/api/resume` (`parseDispatchRequest` rejects bodies
 * without it), so we MUST forward whatever the parent ran under — for
 * board-chat resumes that's `"board-chat"`; for poller-driven trello
 * dispatches that ran under `issue-worker` we fall back to that name
 * since legacy trello-trigger rows pre-DX-84 carry no workspace key.
 */
export async function handleResumeChatSession(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const dispatch = await getDispatchById(jobId);
  if (!dispatch) {
    json(res, 404, { error: "Dispatch not found" });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const task = typeof body.task === "string" ? body.task : null;
  if (!task || !task.trim()) {
    json(res, 400, { error: "Missing or blank required field: task" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === dispatch.repoName);
  if (!repo) {
    json(res, 404, {
      error: `Repo "${dispatch.repoName}" is not configured`,
    });
    return;
  }
  const resumeBody = {
    repo: dispatch.repoName,
    job_id: jobId,
    task,
    workspace: workspaceForResume(dispatch),
  };
  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName: dispatch.repoName,
      primaryHost: deps.resolveHost(dispatch.repoName),
      port: repo.workerPort,
      path: "/api/resume",
      method: "POST",
    },
    JSON.stringify(resumeBody),
  );
}

/**
 * Resolve the workspace name to forward when resuming a chat session.
 * The poller's trello-trigger rows ran under `issue-worker` but the
 * dispatch row predates the DX-84 workspace stamp, so `triggerMetadata`
 * has no `workspace` key for those rows — fall back to `issue-worker`.
 * API-trigger rows always carry `workspace` (worker stamps it on every
 * `/api/launch`), and that's the only authoritative source for
 * board-chat / schema / external dispatcher rows.
 */
function workspaceForResume(dispatch: Dispatch): string {
  const meta = dispatch.triggerMetadata;
  if (
    meta &&
    typeof meta === "object" &&
    "workspace" in meta &&
    typeof meta.workspace === "string" &&
    meta.workspace.length > 0
  ) {
    return meta.workspace;
  }
  return "issue-worker";
}

/**
 * `POST /api/chat/sessions/:job_id/cancel` — stop a streaming chat reply.
 * Wraps `/api/cancel/:job_id` on the dispatch's owning worker.
 */
export async function handleCancelChatSession(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const dispatch = await getDispatchById(jobId);
  if (!dispatch) {
    json(res, 404, { error: "Dispatch not found" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === dispatch.repoName);
  if (!repo) {
    json(res, 404, {
      error: `Repo "${dispatch.repoName}" is not configured`,
    });
    return;
  }
  await proxyToWorkerWithFallback(
    req,
    res,
    {
      repoName: dispatch.repoName,
      primaryHost: deps.resolveHost(dispatch.repoName),
      port: repo.workerPort,
      path: `/api/cancel/${encodeURIComponent(jobId)}`,
      method: "POST",
    },
    JSON.stringify({}),
  );
}

/**
 * `GET /api/chat/sessions/:job_id/stream` — SSE alias for the dispatch
 * JSONL topic. Re-uses `handleStream` so we don't introduce parallel
 * SSE infra: the underlying `dispatch:jsonl:<job_id>` topic is fed by
 * `SessionLogWatcher` via `dispatch-stream.ts` and its blocks are
 * already deduped by `parseJsonlContent`.
 */
export async function handleChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): Promise<void> {
  const params = new URLSearchParams({
    topics: `dispatch:jsonl:${jobId}`,
  });
  await handleStream(req, res, params);
}
