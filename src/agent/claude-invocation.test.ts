import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import {
  buildClaudeInvocation,
  bashSingleQuote,
} from "./claude-invocation.js";
import { DISPATCH_TAG_PREFIX } from "./session-log-watcher.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.length = 0;
});

function build(
  overrides: Partial<Parameters<typeof buildClaudeInvocation>[0]> = {},
) {
  const result = buildClaudeInvocation({
    prompt: "original user prompt body",
    jobId: "job-id-123",
    ...overrides,
  });
  cleanupDirs.push(result.promptDir);
  return result;
}

describe("buildClaudeInvocation — shared for docker + host runtimes", () => {
  it("writes the original prompt verbatim to prompt.md inside promptDir", () => {
    const inv = build({ prompt: "# Task\n\nDo the thing with `backticks` and 'quotes'" });
    const content = readFileSync(`${inv.promptDir}/prompt.md`, "utf-8");
    expect(content).toBe("# Task\n\nDo the thing with `backticks` and 'quotes'");
  });

  it.each([
    ["CRLF newlines", "line1\r\nline2\r\nline3"],
    ["mixed quotes + backslashes", 'He said "hi" and wrote \\path\\to\\file and \'it\'s ok\''],
    ["shell metacharacters", "$(rm -rf /) && $VAR && `command` ; | > <"],
    ["unicode emoji + CJK", "日本語 テスト 🚀 résumé"],
    ["embedded dispatch tag", "prompt body <!-- danxbot-dispatch:fake --> more body"],
    ["64KB+ body", "a".repeat(80_000)],
    ["tabs + vertical whitespace", "col1\tcol2\tcol3\n\vtwo\f"],
  ])("writes adversarial payload verbatim (%s)", (_label, body) => {
    const inv = build({ prompt: body });
    const content = readFileSync(`${inv.promptDir}/prompt.md`, "utf-8");
    expect(content).toBe(body);
  });

  it("exposes promptDir as a real directory (caller owns cleanup)", () => {
    const inv = build();
    expect(existsSync(inv.promptDir)).toBe(true);
  });

  it("firstMessage starts with the dispatch tag so SessionLogWatcher can find the JSONL", () => {
    const inv = build({ jobId: "watch-me" });
    expect(inv.firstMessage.startsWith(`${DISPATCH_TAG_PREFIX}watch-me -->`)).toBe(true);
  });

  it("firstMessage references the prompt.md file path as the Read target", () => {
    const inv = build();
    expect(inv.firstMessage).toContain(
      `Read ${inv.promptDir}/prompt.md and execute the task described in it.`,
    );
  });

  it("firstMessage includes the Tracking suffix when title is provided", () => {
    const inv = build({ title: "AgentDispatch #AGD-359" });
    expect(inv.firstMessage).toMatch(/ Tracking: AgentDispatch #AGD-359$/);
  });

  it("firstMessage omits the Tracking suffix when title is undefined (no empty tracking)", () => {
    const inv = build({ title: undefined });
    expect(inv.firstMessage).not.toMatch(/Tracking/);
  });

  it("firstMessage omits the Tracking suffix when title is an empty string (no silent fallback)", () => {
    const inv = build({ title: "" });
    expect(inv.firstMessage).not.toMatch(/Tracking/);
  });

  it("flags always include --dangerously-skip-permissions and --verbose", () => {
    const inv = build();
    expect(inv.flags).toContain("--dangerously-skip-permissions");
    expect(inv.flags).toContain("--verbose");
  });

  it("flags include --mcp-config when mcpConfigPath is provided", () => {
    const inv = build({ mcpConfigPath: "/tmp/mcp/settings.json" });
    const idx = inv.flags.indexOf("--mcp-config");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(inv.flags[idx + 1]).toBe("/tmp/mcp/settings.json");
  });

  it("flags omit --mcp-config when mcpConfigPath is absent", () => {
    const inv = build({ mcpConfigPath: undefined });
    expect(inv.flags).not.toContain("--mcp-config");
  });

  it("flags include --agents with a JSON blob when agents is a non-empty object", () => {
    const inv = build({ agents: { Validator: { description: "v", prompt: "p" } } });
    const idx = inv.flags.indexOf("--agents");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(inv.flags[idx + 1]!)).toEqual({
      Validator: { description: "v", prompt: "p" },
    });
  });

  it("flags omit --agents when agents object is empty", () => {
    const inv = build({ agents: {} });
    expect(inv.flags).not.toContain("--agents");
  });

  it("flags omit --agents when agents is undefined", () => {
    const inv = build({ agents: undefined });
    expect(inv.flags).not.toContain("--agents");
  });

  it("docker and host consumers receive IDENTICAL firstMessage and flags for the same input", () => {
    // Invariant: the same SpawnAgent inputs produce the same claude-facing
    // invocation. Runtime differs only in the spawn envelope (direct vs bash).
    const opts = {
      prompt: "unified prompt",
      jobId: "same-id",
      title: "Card #42",
      mcpConfigPath: "/tmp/mcp/settings.json",
      agents: { Validator: { description: "v", prompt: "p" } },
    };
    const a = buildClaudeInvocation(opts);
    const b = buildClaudeInvocation(opts);
    cleanupDirs.push(a.promptDir, b.promptDir);

    // firstMessage references promptDir, so the path differs — compare
    // everything EXCEPT the promptDir path.
    const stripPath = (s: string) => s.replace(/\/tmp\/[^/]+\//g, "/tmp/X/");
    expect(stripPath(a.firstMessage)).toBe(stripPath(b.firstMessage));
    expect(a.flags).toEqual(b.flags);
  });
});

describe("bashSingleQuote — embedding arbitrary strings in bash scripts", () => {
  it("wraps plain strings in single quotes", () => {
    expect(bashSingleQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes using the '\\'' idiom", () => {
    expect(bashSingleQuote("it's fine")).toBe("'it'\\''s fine'");
  });

  it("escapes multiple single quotes", () => {
    expect(bashSingleQuote("'a'b'")).toBe("''\\''a'\\''b'\\'''");
  });

  it("passes through shell metacharacters safely inside single quotes", () => {
    expect(bashSingleQuote("$(rm -rf /) && echo pwned"))
      .toBe("'$(rm -rf /) && echo pwned'");
  });
});
