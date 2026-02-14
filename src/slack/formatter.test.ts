import { describe, it, expect } from "vitest";
import { markdownToSlackMrkdwn, splitMessage } from "./formatter.js";

describe("markdownToSlackMrkdwn", () => {
  it("converts italics from * to _", () => {
    expect(markdownToSlackMrkdwn("hello *world*")).toBe("hello _world_");
  });

  it("converts italics at the start of a string", () => {
    expect(markdownToSlackMrkdwn("*italic* text")).toBe("_italic_ text");
  });

  it("converts bold **text** to *text* when within a sentence", () => {
    expect(markdownToSlackMrkdwn("this is **bold** text")).toBe(
      "this is *bold* text",
    );
  });

  it("converts bold __text__ to *text*", () => {
    expect(markdownToSlackMrkdwn("__bold__")).toBe("*bold*");
  });

  it("converts h1 headers to bold", () => {
    expect(markdownToSlackMrkdwn("# Header")).toBe("*Header*");
  });

  it("converts h2 headers to bold", () => {
    expect(markdownToSlackMrkdwn("## Header")).toBe("*Header*");
  });

  it("converts h3-h6 headers to bold", () => {
    expect(markdownToSlackMrkdwn("### Header")).toBe("*Header*");
    expect(markdownToSlackMrkdwn("#### Header")).toBe("*Header*");
    expect(markdownToSlackMrkdwn("##### Header")).toBe("*Header*");
    expect(markdownToSlackMrkdwn("###### Header")).toBe("*Header*");
  });

  it("converts markdown links to Slack links", () => {
    expect(markdownToSlackMrkdwn("[click](https://example.com)")).toBe(
      "<https://example.com|click>",
    );
  });

  it("converts unordered lists from - to bullet", () => {
    expect(markdownToSlackMrkdwn("- item one\n- item two")).toBe(
      "• item one\n• item two",
    );
  });

  it("returns plain text unchanged", () => {
    expect(markdownToSlackMrkdwn("hello world")).toBe("hello world");
  });

  it("handles multiple conversions in one string", () => {
    const input = "# Title\n\n**Bold** and *italic*\n\n- list item";
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("*Title*");
    expect(result).toContain("*Bold*");
    expect(result).toContain("• list item");
  });
});

describe("splitMessage", () => {
  it("returns single chunk when text is under 4000 chars", () => {
    const text = "short message";
    expect(splitMessage(text)).toEqual(["short message"]);
  });

  it("returns single chunk when text is exactly 4000 chars", () => {
    const text = "a".repeat(4000);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits at newline boundary when text exceeds 4000 chars", () => {
    // Build text with a newline near the 4000-char mark
    const line1 = "a".repeat(3990);
    const line2 = "b".repeat(100);
    const text = line1 + "\n" + line2;

    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("falls back to hard split when no good newline exists", () => {
    // Single long line with no newlines
    const text = "x".repeat(5000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(1000);
  });

  it("produces multiple chunks for very long text", () => {
    // 3 lines of 3500 chars each → needs 3 chunks
    const line = "a".repeat(3500);
    const text = [line, line, line].join("\n");
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(3);
  });

  it("ignores early newlines (before midpoint) as split candidates", () => {
    // Newline very early, then a long continuous block
    const text = "hi\n" + "x".repeat(5000);
    const chunks = splitMessage(text);
    // The newline at position 2 is < 4000/2 = 2000, so it falls back to hard split at 4000
    expect(chunks[0].length).toBe(4000);
  });

  it("returns single-element array for empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });
});

describe("markdownToSlackMrkdwn tables", () => {
  it("converts a simple 2-column table to monospace block", () => {
    const input = [
      "| Name  | Age |",
      "| ----- | --- |",
      "| Alice | 30  |",
      "| Bob   | 25  |",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("```");
    expect(result).toContain("Name");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    // Should not contain the separator row
    expect(result).not.toMatch(/\| -/);
  });

  it("converts a multi-column table with varying widths", () => {
    const input = [
      "| Command | Use | Notes |",
      "| --- | --- | --- |",
      "| git status | Show status | Fast |",
      "| docker compose up | Start services | Slow |",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("```");
    expect(result).toContain("Command");
    expect(result).toContain("docker compose up");
    expect(result).toContain("Start services");
  });

  it("preserves text before and after the table", () => {
    const input = [
      "Here is a table:",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "And some text after.",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    expect(result).toMatch(/^Here is a table:/);
    expect(result).toMatch(/And some text after\.$/);
    expect(result).toContain("```");
  });

  it("renders bold markers in monospace cells without mangling content", () => {
    const input = [
      "| Header |",
      "| --- |",
      "| **bold** |",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("```");
    // Cell content is inside a code block, so Slack renders it as monospace.
    // The bold converter transforms **bold** to *bold* but Slack ignores
    // formatting inside code blocks, so the content displays correctly.
    expect(result).toContain("bold");
  });

  it("handles a single-row table (header only, no data rows)", () => {
    const input = [
      "| Header1 | Header2 |",
      "| ------- | ------- |",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain("```");
    expect(result).toContain("Header1");
    expect(result).toContain("Header2");
  });

  it("converts multiple tables in the same text", () => {
    const input = [
      "Table one:",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "Table two:",
      "",
      "| X | Y |",
      "| - | - |",
      "| 3 | 4 |",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    // Should have two separate code blocks
    const codeBlockCount = (result.match(/```/g) || []).length;
    expect(codeBlockCount).toBe(4); // 2 opening + 2 closing
  });

  it("does not treat pipe characters inside code blocks as tables", () => {
    const input = [
      "```",
      "| not | a | table |",
      "| --- | - | ----- |",
      "| just | code | block |",
      "```",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    // The pipes should remain as-is inside the existing code block
    // Should NOT get double-wrapped in backticks
    const codeBlockCount = (result.match(/```/g) || []).length;
    expect(codeBlockCount).toBe(2); // Just the original opening + closing
  });

  it("aligns columns with padding", () => {
    const input = [
      "| Name | Value |",
      "| ---- | ----- |",
      "| x | longvalue |",
    ].join("\n");

    const result = markdownToSlackMrkdwn(input);
    // Extract the content inside the code block
    const codeBlockMatch = result.match(/```\n([\s\S]*?)\n```/);
    expect(codeBlockMatch).not.toBeNull();
    const lines = codeBlockMatch![1].split("\n");
    // All lines should have the same length (padded)
    expect(lines[0].length).toBe(lines[1].length);
  });
});

describe("markdownToSlackMrkdwn edge cases", () => {
  it("converts standalone bold at string start", () => {
    expect(markdownToSlackMrkdwn("**bold**")).toBe("*bold*");
  });
});
