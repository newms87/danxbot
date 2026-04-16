import { describe, it, expect } from "vitest";
import {
  summarizeToolInput,
  truncStr,
  buildAssistantSummary,
  buildToolResultSummary,
} from "./tool-summary.js";

// ============================================================
// summarizeToolInput
// ============================================================

describe("summarizeToolInput", () => {
  it("summarizes Read tool with file path", () => {
    expect(summarizeToolInput("Read", { file_path: "/src/index.ts" })).toBe(
      "/src/index.ts",
    );
  });

  it("summarizes Grep tool with pattern", () => {
    expect(summarizeToolInput("Grep", { pattern: "filterBuilder" })).toBe(
      "filterBuilder",
    );
  });

  it("summarizes Glob tool with pattern", () => {
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("summarizes Bash tool with command", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("returns empty string for unknown tools", () => {
    expect(summarizeToolInput("Write", { content: "test" })).toBe("");
  });

  it("truncates long file paths", () => {
    const longPath = "/a".repeat(100);
    const result = summarizeToolInput("Read", { file_path: longPath });
    expect(result.length).toBe(83); // 80 chars + "..."
    expect(result.endsWith("...")).toBe(true);
  });
});

// ============================================================
// truncStr
// ============================================================

describe("truncStr", () => {
  it("returns short strings unchanged", () => {
    expect(truncStr("hello", 10)).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    expect(truncStr("hello world", 5)).toBe("hello...");
  });

  it("returns string unchanged when exactly at max", () => {
    expect(truncStr("12345", 5)).toBe("12345");
  });

  it("handles empty string", () => {
    expect(truncStr("", 10)).toBe("");
  });
});

// ============================================================
// buildAssistantSummary
// ============================================================

describe("buildAssistantSummary", () => {
  it("returns tool names for tool_use blocks", () => {
    const content = [
      { type: "tool_use", name: "Read", input: { file_path: "/src/index.ts" } },
    ];
    expect(buildAssistantSummary(content)).toBe("Tools: Read(/src/index.ts)");
  });

  it("returns text preview for text-only content", () => {
    const content = [
      { type: "text", text: "Here is my analysis of the code." },
    ];
    expect(buildAssistantSummary(content)).toBe(
      "Text: Here is my analysis of the code.",
    );
  });

  it("prefers tool names over text when both present", () => {
    const content = [
      { type: "text", text: "Let me check that file." },
      { type: "tool_use", name: "Read", input: { file_path: "/src/app.ts" } },
    ];
    expect(buildAssistantSummary(content)).toBe("Tools: Read(/src/app.ts)");
  });

  it("handles multiple tool_use blocks", () => {
    const content = [
      { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_use", name: "Grep", input: { pattern: "TODO" } },
    ];
    expect(buildAssistantSummary(content)).toBe(
      "Tools: Read(/a.ts), Grep(TODO)",
    );
  });

  it("handles unknown tool name gracefully", () => {
    const content = [
      { type: "tool_use", name: "CustomTool", input: { something: "value" } },
    ];
    expect(buildAssistantSummary(content)).toBe("Tools: CustomTool");
  });

  it("handles missing tool name", () => {
    const content = [
      { type: "tool_use", input: { something: "value" } },
    ];
    expect(buildAssistantSummary(content)).toBe("Tools: unknown");
  });

  it("handles missing input", () => {
    const content = [
      { type: "tool_use", name: "Read" },
    ];
    expect(buildAssistantSummary(content)).toBe("Tools: Read");
  });

  it("truncates long text preview to 200 characters", () => {
    const longText = "x".repeat(250);
    const content = [{ type: "text", text: longText }];
    const result = buildAssistantSummary(content);
    expect(result).toBe(`Text: ${"x".repeat(200)}`);
  });

  it("joins multiple text blocks", () => {
    const content = [
      { type: "text", text: "Part one." },
      { type: "text", text: "Part two." },
    ];
    expect(buildAssistantSummary(content)).toBe("Text: Part one. Part two.");
  });

  it("returns empty text indicator for empty content", () => {
    expect(buildAssistantSummary([])).toBe("Text: (empty)");
  });

  it("returns empty text indicator for content with no text or tools", () => {
    const content = [
      { type: "thinking", thinking: "hmm..." },
    ];
    expect(buildAssistantSummary(content)).toBe("Text: (empty)");
  });
});

// ============================================================
// buildToolResultSummary
// ============================================================

describe("buildToolResultSummary", () => {
  it("lists tool_use_ids from results", () => {
    const content = [
      { type: "tool_result", tool_use_id: "toolu_01abc" },
      { type: "tool_result", tool_use_id: "toolu_02def" },
    ];
    expect(buildToolResultSummary(content)).toBe(
      "Tool results: toolu_01abc, toolu_02def",
    );
  });

  it("uses 'result' fallback when tool_use_id is missing", () => {
    const content = [
      { type: "tool_result" },
    ];
    expect(buildToolResultSummary(content)).toBe("Tool results: result");
  });

  it("handles single result", () => {
    const content = [
      { type: "tool_result", tool_use_id: "toolu_single" },
    ];
    expect(buildToolResultSummary(content)).toBe("Tool results: toolu_single");
  });

  it("handles empty content array", () => {
    expect(buildToolResultSummary([])).toBe("Tool results: ");
  });

  it("ignores non-tool-result blocks in mixed content", () => {
    const content = [
      { type: "tool_result", tool_use_id: "toolu_01" },
      { type: "text", text: "some text" },
    ];
    expect(buildToolResultSummary(content)).toBe("Tool results: toolu_01");
  });
});

// ============================================================
// Edge cases from review
// ============================================================

describe("summarizeToolInput edge cases", () => {
  it("returns empty string when Read tool has no file_path key", () => {
    // input.file_path is undefined, || "" fallback produces empty string
    expect(summarizeToolInput("Read", {})).toBe("");
  });
});
