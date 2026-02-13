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

describe("markdownToSlackMrkdwn edge cases", () => {
  it("converts standalone bold at string start", () => {
    expect(markdownToSlackMrkdwn("**bold**")).toBe("*bold*");
  });
});
