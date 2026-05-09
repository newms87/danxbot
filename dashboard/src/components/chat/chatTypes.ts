/**
 * Chat-component types and formatting helpers (DX-84 / Phase 2 of the
 * Agent Chat epic).
 *
 * `ChatBlock` is the chat timeline's local block vocabulary — it differs
 * from the backend `JsonlBlock` (in `dashboard/src/types.ts`) in two
 * ways: tool_result carries a flat `result` string (the backend block
 * uses `content` + `isError`), and assistant/thinking/user/tool_use
 * blocks omit timestamps the timeline doesn't render. The
 * `useChat` composable does the conversion in one place.
 */

export type ChatBlock =
  | { type: "user"; text: string; ts?: number }
  | { type: "assistant_text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; toolUseId: string; result: string };

/**
 * Per-session card the chat shell renders in headers, pickers, and
 * meters. Maps onto the backend `dispatches` row plus the live
 * accumulated usage from the SSE stream. Some fields stay optional
 * because they're only known after the dispatch has produced output —
 * the chat header degrades gracefully when they're missing.
 */
export interface ChatSession {
  id: string;
  title: string;
  dispatchId?: string;
  trigger?: string;
  repo: string;
  turns: number;
  toolCalls: number;
  subagentCount?: number;
  tokensTotal?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextWindow?: number;
  startedAt: number;
  updatedAt?: number;
  completedAt?: number;
  status: "running" | "completed" | "idle";
  lastMessage?: string;
  timeline?: ChatBlock[];
}

export function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null) return "0";
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function fmtChatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
