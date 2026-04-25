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

  it("firstMessage delivers the prompt via Claude's native @file syntax pointing at prompt.md", () => {
    // Phase 6 of the workspace-dispatch epic (Trello WWYKnQhc). The `@file`
    // positional syntax is Claude Code's native file-attachment mechanism —
    // small files inline into the first user message; large files fall back
    // to a Read-tool call automatically when `--dangerously-skip-permissions`
    // is set (which it always is). The previous `Read $PATH and execute...`
    // meta-instruction is retired — it was functionally equivalent but
    // semantically weaker (described the mechanism instead of attaching the
    // file). Keep the space between the dispatch tag `-->` delimiter and the
    // `@` so tokenizers treat `@path` as a standalone file reference.
    const inv = build();
    expect(inv.firstMessage).toContain(`@${inv.promptDir}/prompt.md`);
  });

  it("firstMessage does NOT contain the retired Read-directive text", () => {
    // Regression guard for the P6 cutover. The old meta-instruction
    // (`Read <path> and execute the task described in it.`) is gone. If a
    // future refactor reintroduces it, this assertion fails loudly instead
    // of letting the drift slip into a deployed session.
    const inv = build();
    expect(inv.firstMessage).not.toMatch(/Read .*\/prompt\.md/);
    expect(inv.firstMessage).not.toContain("execute the task described in it");
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

  it("flags always include --strict-mcp-config — agent-isolation invariant", () => {
    // Phase 2 of the agent-isolation epic (Trello 7ha2CSpc). Without
    // this flag, claude reads the workspace's project-scope `.mcp.json`
    // AND any user-scope `.mcp.json`, re-introducing the cross-contamination
    // bug that motivated the epic. The flag must be present on EVERY
    // dispatched invocation — docker, host, resumes, fresh launches.
    const inv = build();
    expect(inv.flags).toContain("--strict-mcp-config");
  });

  it("flags include --strict-mcp-config even when mcpConfigPath is absent", () => {
    // Defense-in-depth: if a caller ever forgets to wire an MCP config
    // file, claude must STILL refuse to fall back to project/user-scope
    // configs. Strictness is unconditional; --mcp-config is how you
    // grant tools, not a gate for the strict flag.
    const inv = build({ mcpConfigPath: undefined });
    expect(inv.flags).toContain("--strict-mcp-config");
  });

  it("flags include --strict-mcp-config on the resume path", () => {
    // The resume path is a historical source of flag-emission drift
    // (the ordering test for `--resume` exists for that reason). Assert
    // strictness survives resume.
    const inv = build({ resumeSessionId: "abc-123" });
    expect(inv.flags).toContain("--strict-mcp-config");
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

  it("flags include --resume <sessionId> when resumeSessionId is provided", () => {
    const inv = build({ resumeSessionId: "566c1776-4c8b-43ef-b1c2-76f262450c4a" });
    const idx = inv.flags.indexOf("--resume");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(inv.flags[idx + 1]).toBe("566c1776-4c8b-43ef-b1c2-76f262450c4a");
  });

  it("flags omit --resume when resumeSessionId is undefined", () => {
    const inv = build({ resumeSessionId: undefined });
    expect(inv.flags).not.toContain("--resume");
  });

  it("--resume comes before --mcp-config and --agents in the flag list", () => {
    // claude accepts flags in any order today, but locking resume at the front
    // of the optional-flag block makes the CLI invocation easier to read in
    // strace output and catches anyone reordering the emitter in a way that
    // could interact with future claude CLI parsers.
    const inv = build({
      resumeSessionId: "abc-def",
      mcpConfigPath: "/tmp/mcp/settings.json",
      agents: { Validator: { description: "v", prompt: "p" } },
    });
    const resumeIdx = inv.flags.indexOf("--resume");
    const mcpIdx = inv.flags.indexOf("--mcp-config");
    const agentsIdx = inv.flags.indexOf("--agents");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(resumeIdx).toBeLessThan(mcpIdx);
    expect(resumeIdx).toBeLessThan(agentsIdx);
  });

  it("firstMessage still carries the fresh dispatch tag on a resume so the watcher can disambiguate slices of the shared JSONL", () => {
    // The parent session and the resume child share the SAME Claude session
    // UUID (claude appends to the same JSONL on --resume). The dispatch tag
    // is the only way SessionLogWatcher can find the resume child's entries
    // inside that shared file.
    const inv = build({
      jobId: "resume-child-id",
      resumeSessionId: "parent-session-uuid",
    });
    expect(inv.firstMessage.startsWith(`${DISPATCH_TAG_PREFIX}resume-child-id -->`)).toBe(true);
  });

  it("never emits --allowed-tools — the allow-tools concept is gone from dispatch", () => {
    // The workspace's `.mcp.json` (combined with `--strict-mcp-config`) is the
    // single source of truth for the agent's MCP surface. Built-ins are all
    // available by default. There is no per-dispatch tool allowlist and no
    // CLI flag that purports to enforce one. If a future caller hands an
    // unknown field through, it never reaches the flag list.
    const inv = build();
    expect(inv.flags).not.toContain("--allowed-tools");
  });

  it("docker and host consumers receive IDENTICAL --mcp-config flags for the same input", () => {
    // Both CLI runtime paths must produce identical claude-facing flags for
    // the same dispatch input. Runtime differs only in the spawn envelope
    // (direct vs bash + wt.exe).
    const opts = {
      prompt: "p",
      jobId: "j",
      mcpConfigPath: "/tmp/mcp/settings.json",
    };
    const a = buildClaudeInvocation(opts);
    const b = buildClaudeInvocation(opts);
    cleanupDirs.push(a.promptDir, b.promptDir);

    const mcpAIdx = a.flags.indexOf("--mcp-config");
    const mcpBIdx = b.flags.indexOf("--mcp-config");
    expect(mcpAIdx).toBeGreaterThanOrEqual(0);
    expect(a.flags[mcpAIdx + 1]).toBe(b.flags[mcpBIdx + 1]);
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
