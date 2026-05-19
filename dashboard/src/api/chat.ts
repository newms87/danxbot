import type { JsonlBlock } from "../types";
import { fetchWithAuth, labelRequest } from "./_request";
import { followDispatch } from "./dispatches";

// ── Agent Chat (DX-84) ───────────────────────────────────────────────

/** Mirrors backend `chat-routes.ts#ChatSessionSummary`. */
export interface ChatSessionSummary {
  job_id: string;
  parent_job_id: string | null;
  issue_id: string | null;
  repo: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  summary: string | null;
  started_at: number;
  completed_at: number | null;
  tokens_total: number;
  tool_call_count: number;
  subagent_count: number;
}

export interface ChatTimelinePayload {
  blocks: JsonlBlock[];
  totals: {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    tokensTotal: number;
    toolCallCount: number;
  };
  chain: string[];
}

export async function listChatSessions(
  issueId: string,
): Promise<ChatSessionSummary[]> {
  return labelRequest(
    "listChatSessions",
    "GET",
    `/api/chat/sessions?issue_id=${encodeURIComponent(issueId)}`,
  );
}

export async function listBoardChatSessions(
  repo: string,
): Promise<ChatSessionSummary[]> {
  return labelRequest(
    "listBoardChatSessions",
    "GET",
    `/api/chat/sessions/board?repo=${encodeURIComponent(repo)}`,
  );
}

export async function fetchChatTimeline(
  jobId: string,
): Promise<ChatTimelinePayload> {
  return labelRequest(
    "fetchChatTimeline",
    "GET",
    `/api/chat/sessions/${encodeURIComponent(jobId)}/timeline`,
  );
}

export async function startBoardChat(
  repo: string,
  task: string,
): Promise<{ job_id: string; status: string }> {
  return labelRequest("startBoardChat", "POST", "/api/chat/sessions", {
    repo,
    task,
  });
}

export async function postChatMessage(
  jobId: string,
  task: string,
): Promise<{ job_id: string; parent_job_id: string; status: string }> {
  return labelRequest(
    "postChatMessage",
    "POST",
    `/api/chat/sessions/${encodeURIComponent(jobId)}/resume`,
    { task },
  );
}

export async function cancelChatSession(
  jobId: string,
): Promise<{ status: string }> {
  return labelRequest(
    "cancelChatSession",
    "POST",
    `/api/chat/sessions/${encodeURIComponent(jobId)}/cancel`,
  );
}

/**
 * Chat session route `/api/chat/sessions/:id/stream` is a thin SSE alias
 * — delegating to `followDispatch` keeps the auth + reconnect contract
 * identical (`useStream` is the single SSE consumer).
 */
export function followChatSession(
  jobId: string,
  onBlock: (block: JsonlBlock) => void,
  onError: () => void,
): () => void {
  return followDispatch(jobId, onBlock, onError);
}

// ── Per-card chat (DX-352 Phase 4) ───────────────────────────────────
//
// Posts to `/api/chat` with `{repo, issue_id}`; worker decides FRESH vs
// RESUME from the per-card `chat-sessions/<id>.json` cache. Rides the
// stable `chat:<PREFIX>-N` SSE alias topic.
export async function sendChatMessage(
  repo: string,
  issueId: string,
  text: string,
): Promise<{ job_id: string; parent_job_id: string | null; status: string }> {
  const res = await fetchWithAuth("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, issue_id: issueId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `sendChatMessage failed: ${res.status}${body ? ` — ${body}` : ""}`,
    );
  }
  return res.json();
}
