import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseJsonlLine,
  parseJsonlContent,
  parseJsonlFile,
} from "./jsonl-reader.js";

function line(raw: Record<string, unknown>): string {
  return JSON.stringify(raw);
}

describe("parseJsonlLine", () => {
  it("returns [] for unknown/irrelevant top-level types", () => {
    expect(parseJsonlLine({ type: "permission-mode" })).toEqual([]);
    expect(parseJsonlLine({ type: "file-history-snapshot" })).toEqual([]);
    expect(parseJsonlLine({ type: "last-prompt" })).toEqual([]);
  });

  it("parses a plain-text user message", () => {
    const blocks = parseJsonlLine({
      type: "user",
      timestamp: "2026-04-14T22:00:00.000Z",
      message: { role: "user", content: "Hello bot" },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "user",
      text: "Hello bot",
    });
    expect(blocks[0].timestampMs).toBeGreaterThan(0);
  });

  it("parses a tool_result user message", () => {
    const blocks = parseJsonlLine({
      type: "user",
      timestamp: "2026-04-14T22:00:01.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            is_error: false,
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    });
    expect(blocks).toEqual([
      {
        type: "tool_result",
        toolUseId: "toolu_01",
        content: "file contents",
        isError: false,
        timestampMs: expect.any(Number),
      },
    ]);
  });

  it("flags tool_result isError when is_error is true", () => {
    const blocks = parseJsonlLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_02",
            is_error: true,
            content: [{ type: "text", text: "boom" }],
          },
        ],
      },
    });
    expect(blocks[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("parses an assistant message with thinking, text, tool_use, and usage", () => {
    const blocks = parseJsonlLine({
      type: "assistant",
      timestamp: "2026-04-14T22:00:02.000Z",
      message: {
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Here is the answer" },
          {
            type: "tool_use",
            id: "toolu_03",
            name: "Read",
            input: { file_path: "/tmp/x" },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
    });

    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "thinking",
      "assistant_text",
      "tool_use",
      "usage",
    ]);

    expect(blocks[2]).toMatchObject({
      type: "tool_use",
      id: "toolu_03",
      name: "Read",
      input: { file_path: "/tmp/x" },
    });

    expect(blocks[3]).toMatchObject({
      type: "usage",
      usage: {
        tokensIn: 10,
        tokensOut: 5,
        cacheRead: 100,
        cacheWrite: 20,
      },
    });
  });

  // Contract pin for the dashboard side of the dedup chain. The dedup in
  // `parseJsonlContent` keys off `block.messageId`; if `parseJsonlLine`
  // ever stops populating it from `message.id`, the dedup silently fails
  // open and per-turn usage doubles again.
  it("populates UsageBlock.messageId from message.id when present", () => {
    const blocks = parseJsonlLine({
      type: "assistant",
      message: {
        id: "msg_018gee6QUUd7HAcWhENVKgzV",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const usage = blocks.find((b) => b.type === "usage");
    expect(usage).toMatchObject({ messageId: "msg_018gee6QUUd7HAcWhENVKgzV" });
  });

  it("leaves UsageBlock.messageId undefined when message.id is missing or empty", () => {
    const noId = parseJsonlLine({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const empty = parseJsonlLine({
      type: "assistant",
      message: {
        id: "",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const noIdUsage = noId.find((b) => b.type === "usage");
    const emptyUsage = empty.find((b) => b.type === "usage");
    expect(noIdUsage).toMatchObject({ type: "usage" });
    expect((noIdUsage as { messageId?: string }).messageId).toBeUndefined();
    expect((emptyUsage as { messageId?: string }).messageId).toBeUndefined();
  });

  it("skips the usage block when all counters are zero", () => {
    const blocks = parseJsonlLine({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    expect(blocks.map((b) => b.type)).toEqual(["assistant_text"]);
  });

  it("parses a system line with subtype", () => {
    const blocks = parseJsonlLine({
      type: "system",
      subtype: "stop_hook_summary",
      summary: "ok",
      timestamp: "2026-04-14T22:00:03.000Z",
    });
    expect(blocks[0]).toMatchObject({
      type: "system",
      subtype: "stop_hook_summary",
      summary: "ok",
    });
  });
});

describe("parseJsonlContent", () => {
  it("ignores malformed JSON lines", () => {
    const text = [
      line({ type: "user", message: { content: "hi" } }),
      "{not json",
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    ].join("\n");

    const { blocks } = parseJsonlContent(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("user");
    expect(blocks[1].type).toBe("assistant_text");
  });

  it("captures sessionId from the first line that has one", () => {
    const text = [
      line({ type: "permission-mode" }),
      line({ type: "user", sessionId: "sess-xyz", message: { content: "q" } }),
      line({ type: "user", sessionId: "other", message: { content: "q2" } }),
    ].join("\n");
    expect(parseJsonlContent(text).sessionId).toBe("sess-xyz");
  });

  it("aggregates tokens across distinct API responses (different message.id)", () => {
    const text = [
      line({
        type: "assistant",
        message: {
          id: "msg_A",
          content: [{ type: "text", text: "a" }],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      line({
        type: "assistant",
        message: {
          id: "msg_B",
          content: [{ type: "text", text: "b" }],
          usage: {
            input_tokens: 5,
            output_tokens: 15,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
      }),
    ].join("\n");

    const { totals } = parseJsonlContent(text);
    expect(totals.tokensIn).toBe(15);
    expect(totals.tokensOut).toBe(35);
    expect(totals.cacheRead).toBe(100);
    expect(totals.cacheWrite).toBe(50);
    expect(totals.tokensTotal).toBe(200);
  });

  it("counts a single API response exactly once when its message.usage is stamped on multiple JSONL lines (Claude Code splits content blocks into separate entries)", () => {
    // Production reproduction (gpt-manager job 830cbd99): the API returned
    // ONE message with in=6, out=110, cache_creation=100,362. Claude Code
    // wrote it as TWO assistant lines (one per content block) — each line
    // carrying the IDENTICAL response-level `message.usage`. Totals must
    // count the response once, not twice.
    const sharedUsage = {
      input_tokens: 6,
      output_tokens: 110,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_362,
    };
    const text = [
      line({
        type: "assistant",
        message: {
          id: "msg_018gee6QUUd7HAcWhENVKgzV",
          content: [{ type: "text", text: "PONG" }],
          usage: sharedUsage,
        },
      }),
      line({
        type: "assistant",
        message: {
          id: "msg_018gee6QUUd7HAcWhENVKgzV",
          content: [
            { type: "tool_use", id: "t1", name: "danxbot_complete", input: {} },
          ],
          usage: sharedUsage,
        },
      }),
    ].join("\n");

    const { blocks, totals } = parseJsonlContent(text);
    expect(totals.tokensIn).toBe(6);
    expect(totals.tokensOut).toBe(110);
    expect(totals.cacheRead).toBe(0);
    expect(totals.cacheWrite).toBe(100_362);
    expect(totals.tokensTotal).toBe(100_478);

    const usageBlocks = blocks.filter((b) => b.type === "usage");
    expect(usageBlocks).toHaveLength(1);
  });

  it("scopes the dedup Set per parseJsonlContent call so subagent files (separate streams) keep their own usage", () => {
    // parseJsonlFile calls parseJsonlContent separately for the parent
    // JSONL and each sub-agent JSONL. They are independent response
    // streams with unrelated `message.id` namespaces. If the dedup Set
    // were ever hoisted to module scope, the same msg_id appearing in
    // a parent and a subagent would silently drop the second one.
    // Calling parseJsonlContent twice with the SAME id must produce the
    // same result both times — proving the Set is per-call.
    const sharedId = "msg_PARENT_OR_SUB";
    const text = line({
      type: "assistant",
      message: {
        id: sharedId,
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 9,
          output_tokens: 17,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const first = parseJsonlContent(text);
    const second = parseJsonlContent(text);

    expect(first.totals).toMatchObject(second.totals);
    expect(first.totals.tokensIn).toBe(9);
    expect(second.totals.tokensIn).toBe(9);
  });

  it("counts each API response when messageId is missing on assistant entries (defensive — never silently drops billable usage)", () => {
    // Real Claude Code always stamps `message.id`. If a malformed entry
    // arrives without one, treat it as its own response — over-count a
    // malformed line rather than under-count a real one.
    const text = [
      line({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "a" }],
          usage: {
            input_tokens: 4,
            output_tokens: 8,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      line({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "b" }],
          usage: {
            input_tokens: 4,
            output_tokens: 8,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    ].join("\n");

    const { totals } = parseJsonlContent(text);
    expect(totals.tokensIn).toBe(8);
    expect(totals.tokensOut).toBe(16);
  });

  it("counts tool_use calls and Agent/Task sub-agent calls", () => {
    const text = [
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: {} },
            { type: "tool_use", id: "t2", name: "Agent", input: {} },
            { type: "tool_use", id: "t3", name: "Task", input: {} },
            { type: "tool_use", id: "t4", name: "Grep", input: {} },
          ],
        },
      }),
    ].join("\n");

    const { totals } = parseJsonlContent(text);
    expect(totals.toolCallCount).toBe(4);
    expect(totals.subagentCount).toBe(2);
  });
});

describe("parseJsonlFile with subagents", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jsonl-reader-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hydrates sub-agent timelines from the sibling subagents/ directory", async () => {
    const parentPath = join(tmp, "parent-session.jsonl");
    const subagentsDir = join(tmp, "parent-session", "subagents");
    mkdirSync(subagentsDir, { recursive: true });

    const childPath = join(subagentsDir, "agent-abc.jsonl");
    const childMeta = join(subagentsDir, "agent-abc.meta.json");

    writeFileSync(
      parentPath,
      [
        line({
          type: "assistant",
          timestamp: "2026-04-14T22:00:00.000Z",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_parent_1",
                name: "Agent",
                input: {
                  subagent_type: "Explore",
                  description: "find deploy config",
                  prompt: "search",
                },
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ].join("\n"),
    );

    writeFileSync(
      childMeta,
      JSON.stringify({ agentType: "Explore", description: "find deploy config" }),
    );
    writeFileSync(
      childPath,
      [
        line({
          type: "user",
          sessionId: "child-session-123",
          message: { content: "search" },
        }),
        line({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "results" },
              { type: "tool_use", id: "toolu_child_1", name: "Grep", input: {} },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ].join("\n"),
    );

    const result = await parseJsonlFile(parentPath);

    const agentBlock = result.blocks.find(
      (b) => b.type === "tool_use" && b.name === "Agent",
    );
    expect(agentBlock).toBeDefined();
    if (!agentBlock || agentBlock.type !== "tool_use") {
      throw new Error("Expected Agent tool_use block");
    }

    expect(agentBlock.subagent).toBeDefined();
    expect(agentBlock.subagent!.agentType).toBe("Explore");
    expect(agentBlock.subagent!.sessionId).toBe("child-session-123");
    expect(
      agentBlock.subagent!.blocks.some((b) => b.type === "assistant_text"),
    ).toBe(true);
    expect(agentBlock.subagent!.totals.tokensIn).toBe(100);
    expect(agentBlock.subagent!.totals.toolCallCount).toBe(1);

    // Parent totals include sub-agent tokens and tool calls
    expect(result.totals.tokensIn).toBe(101);
    expect(result.totals.tokensOut).toBe(52);
    expect(result.totals.toolCallCount).toBe(2); // 1 parent Agent + 1 child Grep
    expect(result.totals.subagentCount).toBe(1);
  });

  it("returns empty result when file is missing", async () => {
    const result = await parseJsonlFile(join(tmp, "missing.jsonl"));
    expect(result.blocks).toEqual([]);
    expect(result.totals.tokensTotal).toBe(0);
  });

  it("leaves subagent undefined when no matching meta.json is found", async () => {
    const parentPath = join(tmp, "p.jsonl");
    writeFileSync(
      parentPath,
      line({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Agent",
              input: { description: "no match" },
            },
          ],
        },
      }),
    );

    const result = await parseJsonlFile(parentPath);
    const toolUse = result.blocks.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    if (toolUse && toolUse.type === "tool_use") {
      expect(toolUse.subagent).toBeUndefined();
    }
  });
});
