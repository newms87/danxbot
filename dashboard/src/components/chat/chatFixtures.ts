// Phase 1 fixtures-only data. Phase 2 (ISS-84) deletes this file outright
// when the real backend wiring lands. Do NOT add a backwards-compat shim
// when removing — migrate consumers cleanly.

export type ChatBlock =
  | { type: "user"; text: string; ts?: number }
  | { type: "assistant_text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      toolUseId: string;
      result: string;
    };

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

const NOW = Date.now();

export const FIXTURE_BOARD_SESSIONS: ChatSession[] = [
  {
    id: "sess_board_a1",
    title: "What's blocking the platform epic?",
    repo: "platform",
    lastMessage:
      "Two issues are blocking — ISS-105 (alerting routing decision) and ISS-310 (heartbeat design).",
    turns: 6,
    toolCalls: 14,
    startedAt: NOW - 2 * 3600_000,
    updatedAt: NOW - 35 * 60_000,
    status: "idle",
  },
  {
    id: "sess_board_a2",
    title: "Triage backlog: which 3 issues should ship next?",
    repo: "platform",
    lastMessage:
      "Recommend ISS-104 (low effort, unblocks ISS-105), ISS-110, ISS-111 in that order.",
    turns: 4,
    toolCalls: 8,
    startedAt: NOW - 18 * 3600_000,
    updatedAt: NOW - 17 * 3600_000,
    status: "idle",
  },
  {
    id: "sess_board_a3",
    title: "Are any in-flight issues at risk?",
    repo: "gpt-manager",
    lastMessage:
      "ISS-203 (auth migration) hit a fixture-update snag; ISS-204 still blocked on the duplicate-warning decision.",
    turns: 9,
    toolCalls: 22,
    startedAt: NOW - 3 * 86_400_000,
    updatedAt: NOW - 2 * 86_400_000,
    status: "idle",
  },
];

export const FIXTURE_ISSUE_SESSIONS: Record<string, ChatSession> = {
  "ISS-102": {
    id: "sess_iss102_run",
    title: "Original implementation run",
    dispatchId: "b82041ce-1fed",
    trigger: "trello",
    repo: "platform",
    turns: 14,
    toolCalls: 31,
    subagentCount: 1,
    tokensTotal: 41_820,
    tokensIn: 32_110,
    tokensOut: 9_710,
    cacheRead: 18_200,
    cacheWrite: 4_100,
    contextWindow: 200_000,
    startedAt: NOW - 2 * 3600_000 - 35 * 60_000,
    completedAt: NOW - 2 * 3600_000 - 12 * 60_000,
    status: "completed",
    timeline: [
      {
        type: "user",
        text: "Trello rate-limit backoff isn't honoring Retry-After header. Reproed at 14:01 — see ISS-102. Fix it.",
      },
      {
        type: "thinking",
        text: "Need to find the Trello adapter, locate where 429s are handled, and add Retry-After parsing.",
      },
      {
        type: "assistant_text",
        text: "I'll start by reading the Trello adapter to find the 429 handling code.",
      },
      {
        type: "tool_use",
        id: "toolu_01A",
        name: "read_file",
        input: { path: "src/poller/trello-client.ts" },
      },
      {
        type: "tool_result",
        toolUseId: "toolu_01A",
        result:
          "[file: src/poller/trello-client.ts] 218 lines — found handleRateLimit() at line 142, currently does setTimeout(retry, 1000)",
      },
      {
        type: "assistant_text",
        text: "Found it. The current handler ignores the Retry-After header entirely and just waits 1s. Let me check what header formats Trello returns.",
      },
      {
        type: "tool_use",
        id: "toolu_01B",
        name: "grep",
        input: { pattern: "Retry-After", path: "node_modules/trello-sdk/" },
      },
      {
        type: "tool_result",
        toolUseId: "toolu_01B",
        result:
          "node_modules/trello-sdk/dist/types.d.ts:42: header may be seconds (number) OR HTTP-date (string)",
      },
      {
        type: "assistant_text",
        text: "Both formats. I'll add a parser that handles both, cap at 5min, and add unit tests.",
      },
      {
        type: "tool_use",
        id: "toolu_01C",
        name: "edit_file",
        input: {
          path: "src/poller/trello-client.ts",
          description: "Add parseRetryAfter helper",
        },
      },
      {
        type: "tool_result",
        toolUseId: "toolu_01C",
        result:
          "Patched. Added parseRetryAfter() at line 138, updated handleRateLimit() to consume it.",
      },
      {
        type: "tool_use",
        id: "toolu_01D",
        name: "edit_file",
        input: {
          path: "src/poller/trello-client.test.ts",
          description: "Tests for both formats",
        },
      },
      {
        type: "tool_result",
        toolUseId: "toolu_01D",
        result: "Patched. 4 new test cases added.",
      },
      {
        type: "tool_use",
        id: "toolu_01E",
        name: "bash",
        input: { command: "pnpm test trello-client" },
      },
      {
        type: "tool_result",
        toolUseId: "toolu_01E",
        result: "✓ 12 tests passed (4 new). Coverage on handleRateLimit() now 100%.",
      },
      {
        type: "assistant_text",
        text: "Done. ISS-102 is ready for review:\n\n• `parseRetryAfter()` handles both seconds-as-number and HTTP-date\n• Capped at 5min\n• 4 new unit tests, all passing\n\nCommits: 3a91c2 (impl), f02bb1 (tests).",
      },
    ],
  },
  "ISS-101": {
    id: "sess_iss101_planning",
    title: "Epic planning: poller resilience",
    dispatchId: "epic-101-planning",
    trigger: "slack",
    repo: "platform",
    turns: 8,
    toolCalls: 16,
    subagentCount: 0,
    tokensTotal: 18_204,
    tokensIn: 13_890,
    tokensOut: 4_314,
    cacheRead: 8_800,
    cacheWrite: 2_100,
    contextWindow: 200_000,
    startedAt: NOW - 4 * 86_400_000,
    completedAt: NOW - 4 * 86_400_000 + 22 * 60_000,
    status: "completed",
    timeline: [
      {
        type: "user",
        text: "Trello poller has had three retry storms this month. Plan an epic to harden it.",
      },
      {
        type: "thinking",
        text: "Need to investigate the existing poller, count failure modes, and propose phased work.",
      },
      {
        type: "tool_use",
        id: "toolu_p1",
        name: "read_file",
        input: { path: "src/poller/index.ts" },
      },
      {
        type: "tool_result",
        toolUseId: "toolu_p1",
        result: "[file: src/poller/index.ts] 142 lines…",
      },
      {
        type: "tool_use",
        id: "toolu_p2",
        name: "grep",
        input: { pattern: "retry|429|backoff", path: "src/poller/" },
      },
      {
        type: "tool_result",
        toolUseId: "toolu_p2",
        result:
          "12 matches across 3 files. Most concerning: trello-client.ts line 142 (unbounded retry).",
      },
      {
        type: "assistant_text",
        text: "Drafted the epic with 4 phases:\n\n1. Spike: reproduce retry storm\n2. Honor Retry-After header\n3. Backoff queue + drop policy\n4. Metrics + alerting\n\nWrote it to `.danxbot/issues/open/ISS-101.yml` with child issues ISS-102 through ISS-105.",
      },
    ],
  },
};

export function getIssueSession(issueId: string): ChatSession | null {
  return FIXTURE_ISSUE_SESSIONS[issueId] ?? null;
}

export function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function fmtChatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
