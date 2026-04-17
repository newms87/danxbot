import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  function buildScript(overrides: Partial<Parameters<typeof buildDispatchScript>[1]> = {}) {
    return buildDispatchScript(dir, {
      prompt: "<!-- danxbot-dispatch:test-job-id -->\n\nDo the work",
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

  it("writes prompt to prompt.txt in the settings directory", () => {
    buildScript({ prompt: "my custom prompt content" });
    const promptContent = readFileSync(join(dir, "prompt.txt"), "utf-8");
    expect(promptContent).toBe("my custom prompt content");
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
    // `exec` is load-bearing: it makes the bash PID the same as the PID of
    // `script` (claude's parent), which makes the PID written to PID_FILE
    // usable for SIGTERM without spawning orphan claude processes.
    expect(content).toMatch(/^exec script -q -f /m);
  });

  it("references PROMPT_FILE via a positional argument (interactive, not -p)", () => {
    const scriptPath = buildScript();
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("PROMPT_FILE=");
    // Host mode MUST be interactive. The prompt is delivered as a positional
    // argument pointing at the file — NOT piped via `-p` (which is headless).
    expect(content).toContain("$PROMPT_FILE");
    expect(content).toMatch(/"Read \$PROMPT_FILE/);
  });

  it("MUST NOT invoke claude with -p — host mode is interactive (see .claude/rules/host-mode-interactive.md)", () => {
    const scriptPath = buildScript();
    const content = readFileSync(scriptPath, "utf-8");
    // The -p (print/headless) flag is FORBIDDEN in host terminal mode.
    // It exits claude after one turn and defeats the entire purpose of this path.
    // Strip bash comments and check remaining executable lines.
    const executable = content
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(executable).not.toMatch(/\s-p\s/);
  });

  it("includes --dangerously-skip-permissions in the claude invocation", () => {
    const scriptPath = buildScript();
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("--dangerously-skip-permissions");
  });

  it("includes --mcp-config when mcpConfigPath is set", () => {
    const scriptPath = buildScript({ mcpConfigPath: "/tmp/mcp/settings.json" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("--mcp-config '/tmp/mcp/settings.json'");
  });

  it("does not include --mcp-config when mcpConfigPath is omitted", () => {
    const scriptPath = buildScript({ mcpConfigPath: undefined });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).not.toContain("--mcp-config");
  });

  it("includes --agents when agentsJson is set", () => {
    const scriptPath = buildScript({
      agentsJson: '[{"name":"Validator"}]',
    });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("--agents '[{\"name\":\"Validator\"}]'");
  });

  it("does not include --agents when agentsJson is omitted", () => {
    const scriptPath = buildScript({ agentsJson: undefined });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).not.toContain("--agents");
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
    // The post-exec 'completed'/'failed' branches are gone: node-side putStatus
    // handles terminal status transitions. The 'running' PUT still fires before
    // exec so the upstream caller learns the dispatch actually reached claude.
    const scriptPath = buildScript({ statusUrl: "http://example.com/status" });
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("report_status() {");
    expect(content).toContain('report_status "running"');
  });

  it("guard in report_status skips curl when STATUS_URL is empty", () => {
    const scriptPath = buildScript({ statusUrl: undefined });
    const content = readFileSync(scriptPath, "utf-8");
    // The guard should be present: [ -n "$STATUS_URL" ]
    expect(content).toContain('[ -n "$STATUS_URL" ]');
  });

  it("writes its PID ($$) to pidFilePath before launching claude", () => {
    const pidFile = join(dir, "claude.pid");
    const scriptPath = buildScript({ pidFilePath: pidFile });
    const content = readFileSync(scriptPath, "utf-8");

    expect(content).toContain(`PID_FILE='${pidFile}'`);
    expect(content).toMatch(/echo \$\$ > "\$PID_FILE"/);

    // The PID write must appear BEFORE the script/claude invocation so the
    // launcher can read it while claude is starting up.
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
});
