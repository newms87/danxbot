/**
 * Chat session composable (DX-84). Owns the per-chat-session state the
 * SPA's chat shell renders:
 *
 *   - The active session card (mapped from a backend `dispatches` row).
 *   - The block stream (initial timeline + live-tail SSE).
 *   - Token totals (deduped by `message.id` because `parseJsonlContent`
 *     already handles that on both the initial fetch and the SSE
 *     stream — we just sum what arrives).
 *   - Streaming flag + Stop button wiring.
 *
 * One composable per active chat tab. Unmount disconnects the SSE.
 *
 * Multi-block dedupe: the backend's `parseJsonlContent` (used by both
 * the timeline endpoint and the `dispatch:jsonl:*` topic emitter) drops
 * duplicate `usage` blocks before they reach us, so the client never
 * sees the same `message.id` twice. Aggregating is a straight sum.
 */

import { computed, onBeforeUnmount, ref, type Ref } from "vue";
import {
  cancelChatSession,
  fetchChatTimeline,
  followChatSession,
  listBoardChatSessions,
  listChatSessions,
  postChatMessage,
  startBoardChat,
  type ChatSessionSummary,
} from "../api";
import type { JsonlBlock } from "../types";
import type { ChatBlock, ChatSession } from "../components/chat/chatTypes";

const DEFAULT_CONTEXT_WINDOW = 200_000;

interface TokenTotals {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

function emptyTotals(): TokenTotals {
  return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Convert a backend `JsonlBlock` to the chat-shell's local `ChatBlock`
 * vocabulary. Drops `system`/`usage` blocks (the timeline never renders
 * them — usage flows through the totals accumulator instead).
 */
export function jsonlBlockToChatBlock(b: JsonlBlock): ChatBlock | null {
  switch (b.type) {
    case "user":
      return { type: "user", text: b.text, ts: b.timestampMs };
    case "assistant_text":
      return { type: "assistant_text", text: b.text };
    case "thinking":
      return { type: "thinking", text: b.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: b.toolUseId,
        result: b.content,
      };
    default:
      return null;
  }
}

function summaryToSession(s: ChatSessionSummary): ChatSession {
  return {
    id: s.job_id,
    title: s.summary ?? `Dispatch ${s.job_id.slice(0, 8)}`,
    dispatchId: s.job_id,
    repo: s.repo,
    turns: 0,
    toolCalls: s.tool_call_count,
    subagentCount: s.subagent_count,
    tokensTotal: s.tokens_total,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    startedAt: s.started_at,
    completedAt: s.completed_at ?? undefined,
    updatedAt: s.completed_at ?? s.started_at,
    status:
      s.status === "running"
        ? "running"
        : s.status === "completed"
          ? "completed"
          : "idle",
    lastMessage: s.summary ?? undefined,
  };
}

export interface UseChatReturn {
  blocks: Ref<ChatBlock[]>;
  session: Ref<ChatSession | null>;
  streaming: Ref<boolean>;
  tokensIn: Ref<number>;
  tokensOut: Ref<number>;
  cacheRead: Ref<number>;
  cacheWrite: Ref<number>;
  tokensTotal: Ref<number>;
  /** Load and stream an existing dispatch. Replaces any in-flight session. */
  openExisting(jobId: string): Promise<void>;
  /** Start a new board-chat dispatch with the operator's first task. */
  startBoard(repo: string, task: string): Promise<void>;
  /** Send the next operator turn — wraps `/api/resume` and re-attaches the SSE. */
  sendMessage(task: string): Promise<void>;
  /** Cancel the streaming reply via `/api/cancel`. */
  cancel(): Promise<void>;
  /** Clear all in-memory state (used when switching issues / closing the tab). */
  reset(): void;
}

export function useChat(): UseChatReturn {
  const session = ref<ChatSession | null>(null);
  const blocks = ref<ChatBlock[]>([]);
  const streaming = ref<boolean>(false);
  const tokensIn = ref<number>(0);
  const tokensOut = ref<number>(0);
  const cacheRead = ref<number>(0);
  const cacheWrite = ref<number>(0);
  let unsubscribe: (() => void) | null = null;
  // Cross-source dedupe: REST `fetchChatTimeline` returns blocks parsed
  // from the same JSONL file the SSE `dispatch:jsonl:<id>` topic hydrates
  // on first subscribe, so a usage block can arrive twice (once via REST
  // totals, once via the SSE hydrate). `parseJsonlContent` dedupes
  // within a single source by `message.id` — the client must dedupe
  // across sources the same way, otherwise the token meter doubles
  // (the AC-blocking case from `agent-dispatch.md` "Multi-block
  // assistant turns"). Tracked per `useChat` instance so a fresh
  // session reset clears the cache.
  const seenUsageMessageIds = new Set<string>();

  const tokensTotal = computed(
    () =>
      tokensIn.value + tokensOut.value + cacheRead.value + cacheWrite.value,
  );

  function disconnect(): void {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function attachStream(jobId: string): void {
    disconnect();
    streaming.value = true;
    // SSE stream subscribes to `dispatch:jsonl:<id>` and gets the
    // already-deduped block stream. New blocks append to the timeline
    // and feed the totals accumulator.
    unsubscribe = followChatSession(
      jobId,
      (block) => {
        if (block.type === "usage") {
          // See `seenUsageMessageIds` declaration for the cross-source
          // dedupe rationale. Blocks without `messageId` (never seen in
          // real Claude Code output) accumulate defensively.
          if (block.messageId) {
            if (seenUsageMessageIds.has(block.messageId)) return;
            seenUsageMessageIds.add(block.messageId);
          }
          tokensIn.value += block.usage.tokensIn;
          tokensOut.value += block.usage.tokensOut;
          cacheRead.value += block.usage.cacheRead;
          cacheWrite.value += block.usage.cacheWrite;
          syncSessionTotals();
          return;
        }
        const chatBlock = jsonlBlockToChatBlock(block);
        if (chatBlock) blocks.value.push(chatBlock);
        if (chatBlock?.type === "assistant_text") {
          // Heuristic: an assistant_text block at the tail of the
          // stream usually marks the end of a turn. Stop button is
          // still shown via `streaming`; the SSE itself stays open
          // until the dispatch terminates so we don't miss a
          // follow-up turn that arrives without a fresh resume.
          streaming.value = false;
        }
      },
      () => {
        streaming.value = false;
      },
    );
  }

  function syncSessionTotals(): void {
    if (!session.value) return;
    session.value = {
      ...session.value,
      tokensIn: tokensIn.value,
      tokensOut: tokensOut.value,
      cacheRead: cacheRead.value,
      cacheWrite: cacheWrite.value,
      tokensTotal: tokensTotal.value,
    };
  }

  function reset(): void {
    disconnect();
    session.value = null;
    blocks.value = [];
    streaming.value = false;
    tokensIn.value = 0;
    tokensOut.value = 0;
    cacheRead.value = 0;
    cacheWrite.value = 0;
    seenUsageMessageIds.clear();
  }

  async function openExisting(jobId: string): Promise<void> {
    reset();
    const timeline = await fetchChatTimeline(jobId);
    const initialBlocks: ChatBlock[] = [];
    let userTurns = 0;
    let toolCalls = 0;
    for (const b of timeline.blocks) {
      if (b.type === "usage") {
        // Pre-populate the dedupe set so the SSE hydrate (which replays
        // the same JSONL file blocks via the `dispatch:jsonl:<id>` topic)
        // does not double-count tokens already accounted for in
        // `timeline.totals` below.
        if (b.messageId) seenUsageMessageIds.add(b.messageId);
        continue;
      }
      if (b.type === "user") userTurns++;
      if (b.type === "tool_use") toolCalls++;
      const chatBlock = jsonlBlockToChatBlock(b);
      if (chatBlock) initialBlocks.push(chatBlock);
    }
    blocks.value = initialBlocks;
    tokensIn.value = timeline.totals.tokensIn;
    tokensOut.value = timeline.totals.tokensOut;
    cacheRead.value = timeline.totals.cacheRead;
    cacheWrite.value = timeline.totals.cacheWrite;
    session.value = {
      id: jobId,
      dispatchId: jobId,
      title: `Dispatch ${jobId.slice(0, 8)}`,
      repo: "",
      turns: userTurns,
      toolCalls,
      tokensIn: tokensIn.value,
      tokensOut: tokensOut.value,
      cacheRead: cacheRead.value,
      cacheWrite: cacheWrite.value,
      tokensTotal: tokensTotal.value,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      startedAt: Date.now(),
      status: "idle",
    };
    attachStream(jobId);
  }

  async function startBoard(repo: string, task: string): Promise<void> {
    reset();
    blocks.value.push({ type: "user", text: task, ts: Date.now() });
    const result = await startBoardChat(repo, task);
    session.value = {
      id: result.job_id,
      dispatchId: result.job_id,
      title: `Board chat · ${repo}`,
      repo,
      turns: 1,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokensTotal: 0,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      startedAt: Date.now(),
      status: "running",
    };
    attachStream(result.job_id);
  }

  async function sendMessage(task: string): Promise<void> {
    if (!session.value) {
      throw new Error("useChat.sendMessage: no active session");
    }
    blocks.value.push({ type: "user", text: task, ts: Date.now() });
    streaming.value = true;
    const result = await postChatMessage(session.value.id, task);
    // The resume creates a new dispatch row, but blocks land in the
    // SAME JSONL file. Swap the SSE subscription onto the new dispatch
    // id so future blocks are tagged correctly. The underlying file
    // doesn't change, so existing blocks stay rendered.
    session.value = {
      ...session.value,
      id: result.job_id,
      dispatchId: result.job_id,
      turns: (session.value.turns ?? 0) + 1,
      status: "running",
    };
    attachStream(result.job_id);
  }

  async function cancel(): Promise<void> {
    if (!session.value) return;
    try {
      await cancelChatSession(session.value.id);
    } finally {
      streaming.value = false;
    }
  }

  onBeforeUnmount(disconnect);

  return {
    blocks,
    session,
    streaming,
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    tokensTotal,
    openExisting,
    startBoard,
    sendMessage,
    cancel,
    reset,
  };
}

/** Helper for the per-issue chat tab — load the most-recent prior dispatch. */
export async function fetchIssueSessions(
  issueId: string,
): Promise<ChatSession[]> {
  const rows = await listChatSessions(issueId);
  return rows.map(summaryToSession);
}

/** Helper for the board chat picker — list this repo's prior board chats. */
export async function fetchBoardSessions(
  repo: string,
): Promise<ChatSession[]> {
  const rows = await listBoardChatSessions(repo);
  return rows.map(summaryToSession);
}
