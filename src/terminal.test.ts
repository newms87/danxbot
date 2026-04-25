import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildDispatchScript, getTerminalLogPath } from "./terminal.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "terminal-test-"));
}

describe("getTerminalLogPath", () => {
  it("returns a path in tmpdir with the expected filename format", () => {
    const jobId = "abc-123-def";
    const logPath = getTerminalLogPath(jobId);

    expect(logPath).toContain("danxbot-terminal-abc-123-def.log");
    expect(logPath).toContain(tmpdir());
  });

  it("returns different paths for different job IDs", () => {
    const path1 = getTerminalLogPath("job-1");
    const path2 = getTerminalLogPath("job-2");

    expect(path1).not.toBe(path2);
    expect(path1).toContain("job-1");
    expect(path2).toContain("job-2");
  });
});

describe("buildDispatchScript", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildScript(
    overrides: Partial<Parameters<typeof buildDispatchScript>[1]> = {},
  ) {
    return buildDispatchScript(dir, {
      flags: ["--dangerously-skip-permissions", "--verbose"],
      firstMessage:
        "<!-- danxbot-dispatch:test-job-id --> @/tmp/p/prompt.md",
      jobId: "test-job-id",
      terminalLogPath: "/tmp/danxbot-terminal-test-job-id.log",
      apiToken: "test-token",
      ...overrides,
    });
  }

  it("returns the path to run-agent.sh in the settings directory", () => {
    const scriptPath = buildScript();
    expect(scriptPath).toBe(join(dir, "run-agent.sh"));
  });

  it("creates an executable run-agent.sh script", () => {
    const scriptPath = buildScript();
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("#!/usr/bin/env bash");
  });

  it("passes the firstMessage verbatim as claude's positional argument", () => {
    const scriptPath = buildScript({
      firstMessage:
        "<!-- danxbot-dispatch:id --> @/tmp/X/prompt.md Tracking: Card #42",
    });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain(
      "'<!-- danxbot-dispatch:id --> @/tmp/X/prompt.md Tracking: Card #42'",
    );
  });

  // Regression: claude's `--mcp-config` is a variadic flag (see `claude
  // --help`: `<configs...>`). Without a `--` separator, the positional
  // firstMessage gets absorbed as an additional value for whichever variadic
  // flag appears last, and claude's interactive TUI boots with no first
  // message — it sits idle on `❯` forever. Inserting `--` before the
  // positional is the POSIX convention that tells commander.js (claude's
  // CLI parser) "no more flag values, what follows is positional." See
  // Trello card `kwZOGOrQ` for the full investigation.
  it("inserts a `--` separator before the firstMessage so variadic flags don't absorb the positional", () => {
    const scriptPath = buildScript({
      flags: ["--mcp-config", "/tmp/mcp/settings.json"],
      firstMessage: "the user message",
    });
    const content = readFileSync(scriptPath, "utf-8");
    // The CLAUDE_ARGV bash array must contain `'--'` immediately before the
    // single-quoted firstMessage. A missing separator regresses host mode to
    // the silent-hang state (card kwZOGOrQ) — the agent TUI boots but never
    // processes the first turn.
    expect(content).toMatch(/'--mcp-config' '\/tmp\/mcp\/settings\.json' '--' 'the user message'/);
  });

  it("does NOT write prompt.txt — firstMessage is delivered inline, not via a file", () => {
    // Host mode used to write the prompt to disk as prompt.txt and have claude
    // "Read $PROMPT_FILE and execute..." — that double-indirection hid the
    // Tracking line. The firstMessage is now passed directly, identical to
    // how docker passes it via -p.
    buildScript();
    expect(() => readFileSync(join(dir, "prompt.txt"), "utf-8")).toThrow();
  });

  it("wraps claude with script -q -f for terminal output capture", () => {
    const scriptPath = buildScript({
      terminalLogPath: "/tmp/test-terminal.log",
    });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain('script -q -f "$TERMINAL_LOG"');
    expect(content).toContain("TERMINAL_LOG='/tmp/test-terminal.log'");
  });

  it("exec's script -q -f so bash is replaced in-place (PID cascade integrity)", () => {
    const scriptPath = buildScript();
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toMatch(/^exec script -q -f /m);
  });

  it("MUST NOT invoke claude with -p — host mode is interactive (see .claude/rules/host-mode-interactive.md)", () => {
    const scriptPath = buildScript();
    const content = readFileSync(scriptPath, "utf-8");
    const executable = content
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/\s-p\s/);
  });

  it("embeds every flag as a bash single-quoted literal in the CLAUDE_ARGV array", () => {
    const scriptPath = buildScript({
      flags: [
        "--dangerously-skip-permissions",
        "--verbose",
        "--mcp-config",
        "/tmp/mcp/settings.json",
      ],
    });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain(
      "CLAUDE_ARGV=('claude' '--dangerously-skip-permissions' '--verbose' '--mcp-config' '/tmp/mcp/settings.json'",
    );
  });

  it("safely quotes flag values containing JSON (--agents)", () => {
    const agentsJson = '{"Validator":{"description":"v","prompt":"p"}}';
    const scriptPath = buildScript({
      flags: ["--dangerously-skip-permissions", "--verbose", "--agents", agentsJson],
    });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain(`'--agents' '${agentsJson}'`);
  });

  // Regression guard: every generated script MUST be valid bash. `bash -n` does
  // a parse-only check (no side effects). Previous tests verified that the JSON
  // appeared in the file as a substring — they did NOT verify the resulting
  // file was parseable. The real bug: the outer double-quote wrapper in
  // `exec script -c "claude ... '--agents' '{"x":"y"}' ..."` closes prematurely
  // on the first `"` inside the JSON, leaving the file with an unterminated
  // string. bash errors with: unexpected EOF while looking for matching `"`.
  // This test reproduces that real-world dispatch failure at unit-test speed.
  it("generated script parses as valid bash when --agents contains JSON with double quotes", () => {
    const agentsJson = JSON.stringify({
      "template-builder": {
        description: "Builds templates",
        prompt: "Instructions with \"quoted\" words and 'apostrophes' too.",
      },
      "schema-builder": {
        description: "Builds the data model",
        prompt: "Another prompt with \"embedded\" double quotes.",
      },
    });
    const scriptPath = buildScript({
      flags: [
        "--dangerously-skip-permissions",
        "--verbose",
        "--mcp-config",
        "/tmp/mcp/settings.json",
        "--agents",
        agentsJson,
      ],
      firstMessage:
        "<!-- danxbot-dispatch:test --> @/tmp/p/prompt.md Tracking: AgentDispatch #AGD-99",
    });

    const result = spawnSync("bash", ["-n", scriptPath], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("generated script parses as valid bash with a realistic large JSON payload", () => {
    // Mirror the shape GPT Manager's orchestrator sends — multiple agents,
    // each with multi-line prompts and embedded quotes.
    const bigPrompt = Array.from({ length: 40 }, (_, i) =>
      `Line ${i}: An "instruction" with 'various' "punctuation" including $special and \\escapes.`,
    ).join("\n");
    const agentsJson = JSON.stringify({
      "schema-builder": { description: "Schema sub-agent", prompt: bigPrompt },
      "behavior-builder": { description: "Directive sub-agent", prompt: bigPrompt },
      "template-builder": { description: "Template sub-agent", prompt: bigPrompt },
    });
    const scriptPath = buildScript({
      flags: ["--dangerously-skip-permissions", "--verbose", "--agents", agentsJson],
    });

    const result = spawnSync("bash", ["-n", scriptPath], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("sets STATUS_URL to the given statusUrl", () => {
    const scriptPath = buildScript({ statusUrl: "http://example.com/api/status" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("STATUS_URL='http://example.com/api/status'");
  });

  it("sets STATUS_URL to empty string when statusUrl is omitted", () => {
    const scriptPath = buildScript({ statusUrl: undefined });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("STATUS_URL=''");
  });

  it("defines and invokes report_status with the running state before claude starts", () => {
    const scriptPath = buildScript({ statusUrl: "http://example.com/status" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("report_status() {");
    expect(content).toContain('report_status "running"');
  });

  it("guard in report_status skips curl when STATUS_URL is empty", () => {
    const scriptPath = buildScript({ statusUrl: undefined });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain('[ -n "$STATUS_URL" ]');
  });

  it("writes its PID ($$) to pidFilePath before launching claude", () => {
    const pidFile = join(dir, "claude.pid");
    const scriptPath = buildScript({ pidFilePath: pidFile });
    const content = readFileSync(scriptPath, "utf-8");

    expect(content).toContain(`PID_FILE='${pidFile}'`);
    expect(content).toMatch(/echo \$\$ > "\$PID_FILE"/);

    const pidIndex = content.indexOf("echo $$");
    const claudeIndex = content.indexOf("script -q -f");
    expect(pidIndex).toBeGreaterThan(-1);
    expect(claudeIndex).toBeGreaterThan(-1);
    expect(pidIndex).toBeLessThan(claudeIndex);
  });

  it("does not emit PID_FILE when pidFilePath is omitted", () => {
    const scriptPath = buildScript({ pidFilePath: undefined });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).not.toMatch(/PID_FILE=/);
    expect(content).not.toMatch(/echo \$\$ > "\$PID_FILE"/);
  });

  // Defense-in-depth: every interpolated value that reaches bash MUST pass
  // through bashSingleQuote so an adversarial value can't break out of the
  // single-quoted literal. These tests feed an embedded single quote through
  // each var and assert the `'\''` escape survives end-to-end.
  it("bash-quotes apiToken so embedded single quotes cannot break out", () => {
    const scriptPath = buildScript({ apiToken: "abc'def" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("API_TOKEN='abc'\\''def'");
  });

  it("bash-quotes statusUrl so embedded single quotes cannot break out", () => {
    const scriptPath = buildScript({ statusUrl: "http://ex.com/a'b" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("STATUS_URL='http://ex.com/a'\\''b'");
  });

  it("bash-quotes terminalLogPath so spaces and metachars are safe", () => {
    const scriptPath = buildScript({ terminalLogPath: "/tmp/log'with $HOME" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("TERMINAL_LOG='/tmp/log'\\''with $HOME'");
  });

  it("bash-quotes pidFilePath so unusual paths cannot break out", () => {
    const scriptPath = buildScript({ pidFilePath: "/tmp/pid'file" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("PID_FILE='/tmp/pid'\\''file'");
  });
});
