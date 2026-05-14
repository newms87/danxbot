import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { Ref } from "vue";

// ─── Mocks ───────────────────────────────────────────────────────────

const mockSendChatMessage = vi.fn();
const mockFetchWithAuth = vi.fn();
vi.mock("../api", () => ({
  sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

type Handler = (e: { topic: string; data: unknown }) => void;

interface StreamMock {
  connectionState: Ref<"connecting" | "connected" | "disconnected">;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit(topic: string, data: unknown): void;
  handlerCount(topic: string): number;
  topics(): string[];
}

function makeStreamMock(): StreamMock {
  const handlers = new Map<string, Set<Handler>>();
  return {
    connectionState: ref<"connecting" | "connected" | "disconnected">("connected"),
    subscribe: vi.fn().mockImplementation((topic: string, h: Handler) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    disconnect: vi.fn(),
    emit(topic, data) {
      handlers.get(topic)?.forEach((h) => h({ topic, data }));
    },
    handlerCount(topic) {
      return handlers.get(topic)?.size ?? 0;
    },
    topics() {
      return [...handlers.keys()];
    },
  };
}

let currentStream: StreamMock;
vi.mock("./useStream", async () => {
  const actual = await vi.importActual<typeof import("./useStream")>("./useStream");
  return {
    ...actual,
    useStream: () => currentStream,
  };
});

import { useIssueChat } from "./useIssueChat";

// ─── Fixtures ────────────────────────────────────────────────────────

function userBlock(text: string, ts = 1_000): unknown {
  return { type: "user", text, timestampMs: ts };
}
function assistantTextBlock(text: string, ts = 2_000): unknown {
  return { type: "assistant_text", text, timestampMs: ts };
}

beforeEach(() => {
  currentStream = makeStreamMock();
  mockSendChatMessage.mockReset();
  mockFetchWithAuth.mockReset();
  // Default probe response: chat alias exists.
  mockFetchWithAuth.mockResolvedValue(new Response(null, { status: 200 }));
});

// ─── Tests ───────────────────────────────────────────────────────────

describe("useIssueChat — subscription wiring", () => {
  it("subscribes to chat:<ISS-N> on mount when the alias resolves", async () => {
    const repo = ref("danxbot");
    const issueId = ref("DX-352");
    const chat = useIssueChat(repo, issueId);
    await flushPromises();
    expect(currentStream.handlerCount("chat:DX-352")).toBe(1);
    expect(chat.blocks.value).toEqual([]);
  });

  it("does NOT subscribe when the probe returns 404 (no prior chat for the card)", async () => {
    mockFetchWithAuth.mockResolvedValue(new Response(null, { status: 404 }));
    const repo = ref("danxbot");
    const issueId = ref("DX-352");
    useIssueChat(repo, issueId);
    await flushPromises();
    expect(currentStream.handlerCount("chat:DX-352")).toBe(0);
  });

  it("ingests JsonlBlock[] events into chat blocks via the dedup-aware pusher", async () => {
    const chat = useIssueChat(ref("danxbot"), ref("DX-352"));
    await flushPromises();
    currentStream.emit("chat:DX-352", [
      userBlock("hello"),
      assistantTextBlock("hi back"),
    ]);
    expect(chat.blocks.value).toEqual([
      { type: "user", text: "hello", ts: 1_000 },
      { type: "assistant_text", text: "hi back" },
    ]);
  });

  it("dedupes replayed JSONL hydration on re-subscribe (same key → no duplicate)", async () => {
    const chat = useIssueChat(ref("danxbot"), ref("DX-352"));
    await flushPromises();
    currentStream.emit("chat:DX-352", [userBlock("hello", 5_000)]);
    expect(chat.blocks.value).toHaveLength(1);
    // Simulate watcher re-hydration (re-subscribe after send) — same block id replayed.
    currentStream.emit("chat:DX-352", [userBlock("hello", 5_000)]);
    expect(chat.blocks.value).toHaveLength(1);
  });
});

describe("useIssueChat — send", () => {
  it("POSTs /api/chat via sendChatMessage and pushes an optimistic user block", async () => {
    mockSendChatMessage.mockResolvedValue({
      job_id: "new-job",
      parent_job_id: null,
      status: "launched",
    });
    const chat = useIssueChat(ref("danxbot"), ref("DX-352"));
    await flushPromises();
    await chat.send("rebuild the readme");
    expect(mockSendChatMessage).toHaveBeenCalledWith(
      "danxbot",
      "DX-352",
      "rebuild the readme",
    );
    // Optimistic block surfaces immediately.
    expect(chat.blocks.value.some(
      (b) => b.type === "user" && b.text === "rebuild the readme",
    )).toBe(true);
  });

  it("re-subscribes after a successful POST so the stream re-resolves to the new leaf", async () => {
    mockSendChatMessage.mockResolvedValue({
      job_id: "new-job",
      parent_job_id: "old-job",
      status: "launched",
    });
    const chat = useIssueChat(ref("danxbot"), ref("DX-352"));
    await flushPromises();
    expect(currentStream.subscribe.mock.calls.length).toBe(1);
    await chat.send("next turn");
    await flushPromises();
    // Two subscribes total: mount + post-send re-attach.
    expect(currentStream.subscribe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("rolls back the optimistic user block when POST fails", async () => {
    mockSendChatMessage.mockRejectedValue(new Error("network down"));
    const chat = useIssueChat(ref("danxbot"), ref("DX-352"));
    await flushPromises();
    await chat.send("doomed message");
    expect(chat.error.value).toMatch(/network down/);
    expect(chat.blocks.value.find(
      (b) => b.type === "user" && b.text === "doomed message",
    )).toBeUndefined();
  });

  it("drops the optimistic block once the matching live user message arrives via SSE", async () => {
    mockSendChatMessage.mockResolvedValue({
      job_id: "new-job",
      parent_job_id: null,
      status: "launched",
    });
    const chat = useIssueChat(ref("danxbot"), ref("DX-352"));
    await flushPromises();
    await chat.send("hello there");
    await flushPromises();
    const beforeLive = chat.blocks.value.filter(
      (b) => b.type === "user" && b.text === "hello there",
    );
    expect(beforeLive).toHaveLength(1);
    expect(beforeLive[0]).toEqual({ type: "user", text: "hello there" }); // no ts → optimistic
    // Live user block arrives via JSONL stream (claude's clock).
    currentStream.emit("chat:DX-352", [userBlock("hello there", 9_999)]);
    const afterLive = chat.blocks.value.filter(
      (b) => b.type === "user" && b.text === "hello there",
    );
    expect(afterLive).toHaveLength(1);
    expect(afterLive[0]).toEqual({ type: "user", text: "hello there", ts: 9_999 });
  });
});

describe("useIssueChat — issueId reactivity", () => {
  it("re-attaches on issueId change", async () => {
    const issueId = ref("DX-352");
    useIssueChat(ref("danxbot"), issueId);
    await flushPromises();
    expect(currentStream.topics()).toContain("chat:DX-352");
    issueId.value = "DX-9999";
    await flushPromises();
    expect(currentStream.topics()).toContain("chat:DX-9999");
  });
});

describe("useIssueChat — source-level no-poll guard", () => {
  it("composable file contains no setInterval (server state flows via SSE)", () => {
    const source = readFileSync(
      resolve(__dirname, "useIssueChat.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
  });
  it("composable file contains no polling-shaped setTimeout", () => {
    const source = readFileSync(
      resolve(__dirname, "useIssueChat.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(
      /setTimeout\s*\([\s\S]{0,100}?(fetch|reload|refresh|poll)/i,
    );
  });
});
