import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { Issue } from "../../types";

// ─── Composable mock ─────────────────────────────────────────────────

const mockBlocks = ref<unknown[]>([]);
const mockLoading = ref<boolean>(false);
const mockError = ref<string | null>(null);
const mockSend = vi.fn();
const mockDisconnect = vi.fn();

vi.mock("../../composables/useIssueChat", () => ({
  useIssueChat: () => ({
    blocks: mockBlocks,
    loading: mockLoading,
    error: mockError,
    connectionState: ref("connected"),
    send: mockSend,
    disconnect: mockDisconnect,
  }),
}));

import IssueChatTab from "./IssueChatTab.vue";

// ─── Fixtures ────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 10,
    tracker: "memory",
    id: "DX-352",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Test",
    description: "Test",
    priority: 3,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    history: [],
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    ...overrides,
    db_updated_at: "",
  } as Issue;
}

beforeEach(() => {
  mockBlocks.value = [];
  mockLoading.value = false;
  mockError.value = null;
  mockSend.mockReset();
  mockDisconnect.mockReset();
  window.localStorage.clear();
});

describe("IssueChatTab", () => {
  it("renders an empty state when no blocks and not loading", () => {
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    expect(w.find('[data-test="chat-empty"]').exists()).toBe(true);
    expect(w.text()).toContain("Chat with danxbot about DX-352");
  });

  it("forwards composer @send to chat.send", async () => {
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    const textarea = w.find("textarea");
    await textarea.setValue("hi");
    await w.find(".send").trigger("click");
    expect(mockSend).toHaveBeenCalledWith("hi");
  });

  it("hides Bash tool_use blocks AND their matching tool_results when hideBash is true (default)", () => {
    mockBlocks.value = [
      { type: "user", text: "list-the-files-now" },
      { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", toolUseId: "tu-1", result: "a-b-c-marker" },
      { type: "assistant_text", text: "done-marker" },
    ];
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    // Scope to the timeline body (filter chips contain "Bash" as a label).
    const timeline = w.get('[data-test="chat-scroll"]').html();
    expect(timeline).not.toContain("ls");
    expect(timeline).not.toContain("a-b-c-marker");
    expect(timeline).toContain("done-marker");
    expect(timeline).toContain("list-the-files-now");
  });

  it("does NOT leak a Bash tool_result when it arrives before its matching tool_use (orphan ordering)", () => {
    // Defensive: the timeline-pair builder in ChatTimeline.vue skips
    // bare tool_result blocks, but the filter's bashIds set is built
    // from tool_use in one pass — if a tool_result preceded its
    // tool_use, an early implementation could miss filtering it.
    // Asserting the orphan ordering both at the filter level here AND
    // implicitly in ChatTimeline pins the contract end-to-end.
    mockBlocks.value = [
      { type: "tool_result", toolUseId: "tu-orphan", result: "orphan-result-marker" },
      { type: "tool_use", id: "tu-orphan", name: "Bash", input: { command: "ls-marker" } },
    ];
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    const timeline = w.get('[data-test="chat-scroll"]').html();
    expect(timeline).not.toContain("orphan-result-marker");
    expect(timeline).not.toContain("ls-marker");
  });

  it("shows Bash blocks when hideBash is toggled off", async () => {
    mockBlocks.value = [
      { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls-marker" } },
      { type: "tool_result", toolUseId: "tu-1", result: "a-b-c-marker" },
    ];
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    // Initial: Bash block hidden from timeline.
    expect(w.get('[data-test="chat-scroll"]').html()).not.toContain("ls-marker");
    await w.find('[data-test="filter-bash"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-test="chat-scroll"]').html()).toContain("ls-marker");
  });

  it("hides thinking blocks when hideThinking is true (default)", () => {
    mockBlocks.value = [
      { type: "thinking", text: "secret thought" },
      { type: "assistant_text", text: "public reply" },
    ];
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    const timeline = w.get('[data-test="chat-scroll"]').html();
    expect(timeline).not.toContain("secret thought");
    expect(timeline).toContain("public reply");
  });

  it("shows thinking blocks when hideThinking is toggled off", async () => {
    mockBlocks.value = [{ type: "thinking", text: "internal-marker" }];
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    expect(w.get('[data-test="chat-scroll"]').html()).not.toContain(
      "internal-marker",
    );
    await w.find('[data-test="filter-thinking"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-test="chat-scroll"]').html()).toContain(
      "internal-marker",
    );
  });

  it("restores filter preferences from localStorage on mount", async () => {
    window.localStorage.setItem("issues.chatFilter.hideBash", "false");
    window.localStorage.setItem("issues.chatFilter.hideThinking", "false");
    mockBlocks.value = [
      { type: "thinking", text: "should-show-marker" },
      { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "ls-marker" } },
    ];
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    const timeline = w.get('[data-test="chat-scroll"]').html();
    expect(timeline).toContain("should-show-marker");
    expect(timeline).toContain("ls-marker");
  });

  it("renders chat.error.value when set", async () => {
    mockError.value = "POST /api/chat 503";
    const w = mount(IssueChatTab, {
      props: { issue: makeIssue(), repo: "danxbot" },
    });
    await flushPromises();
    expect(w.find('[data-test="chat-error"]').text()).toContain(
      "POST /api/chat 503",
    );
  });
});

describe("IssueChatTab — source-level no-poll guard", () => {
  it("SFC source contains no setInterval call", () => {
    const source = readFileSync(
      resolve(__dirname, "IssueChatTab.vue"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
  });
});
