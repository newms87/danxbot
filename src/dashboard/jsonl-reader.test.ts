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

  it("aggregates tokens across assistant turns", () => {
    const text = [
      line({
        type: "assistant",
        message: {
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
