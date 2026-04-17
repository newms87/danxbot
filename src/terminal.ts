/**
 * Shared utility for spawning Claude Code in a Windows Terminal tab.
 *
 * Used by both the Trello poller (card-triggered) and the dispatch API
 * (HTTP-triggered from GPT Manager). One mechanism, two triggers.
 */

import { spawn } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "./logger.js";

const log = createLogger("terminal");

export interface TerminalLaunchOptions {
  /** Title shown in the Windows Terminal tab */
  title: string;
  /** Absolute path to the bash script to run */
  script: string;
  /** Working directory for the spawned process */
  cwd: string;
  /** Environment variables (CLAUDECODE vars are stripped automatically) */
  env?: Record<string, string | undefined>;
}

export interface DispatchScriptOptions {
  /** The tagged prompt string (including dispatch tag) */
  prompt: string;
  /** Job ID — used to name the terminal log path via getTerminalLogPath() */
  jobId: string;
  /** Absolute path to the MCP settings.json (optional) */
  mcpConfigPath?: string;
  /** Agent definitions as JSON string (optional) */
  agentsJson?: string;
  /** Status URL for reporting back to Laravel */
  statusUrl?: string;
  /** API token for status reporting */
  apiToken: string;
  /** Path where terminal output is captured by `script -q -f` */
  terminalLogPath: string;
  /**
   * Absolute path where the bash script writes its own PID ($$) before
   * launching claude. Host-mode dispatches read this to track the running
   * process so they can SIGTERM it on cancel/stop/timeout without spawning a
   * second claude.
   */
  pidFilePath?: string;
}

/**
 * Returns the path for the terminal output log file for a given job.
 * The dispatch script writes to this path via `script -q -f`.
 * The TerminalOutputWatcher reads from this path to detect the thinking indicator.
 */
export function getTerminalLogPath(jobId: string): string {
  return join(tmpdir(), `danxbot-terminal-${jobId}.log`);
}

/**
 * Build a bash script that launches claude INTERACTIVELY in a host terminal tab.
 *
 * ============================================================================
 * CRITICAL INVARIANT — HOST MODE MUST BE INTERACTIVE. `claude -p` IS FORBIDDEN.
 * ============================================================================
 *
 * The entire point of host runtime is to give the user an interactive Claude Code
 * TUI they can read, scroll, and type into. Docker runtime handles the headless
 * case. If this script ever uses `claude -p "<prompt>"`, host mode has no reason
 * to exist — it becomes a slower, flakier duplicate of docker mode.
 *
 * See .claude/rules/host-mode-interactive.md for the full rule.
 *
 * Before editing this function, confirm:
 *   1. The inner `claude` invocation is NOT `-p` and does NOT exit after one turn
 *   2. The user gets a live TUI they can type into
 *   3. `script -q -f` wrapping is fine; the process it wraps must still be the
 *      interactive claude TUI
 *
 * The script:
 * 1. Writes the prompt to a temp file (avoids shell quoting issues with long
 *    or special-character prompts)
 * 2. Passes the file path as a positional prompt argument — claude reads the
 *    file and runs interactively, keeping the TUI attached
 * 3. Wraps claude with `script -q -f <terminalLogPath>` so the ✻ thinking
 *    indicator is captured for the StallDetector
 * 4. Reports status to statusUrl on completion
 */
export function buildDispatchScript(
  settingsDir: string,
  options: DispatchScriptOptions,
): string {
  const mcpLine = options.mcpConfigPath
    ? `  --mcp-config '${options.mcpConfigPath}' \\\n`
    : "";
  const agentsLine = options.agentsJson
    ? `  --agents '${options.agentsJson}' \\\n`
    : "";
  const promptFile = join(settingsDir, "prompt.txt");
  // Write the prompt to disk to avoid shell quoting issues with special characters
  writeFileSync(promptFile, options.prompt, "utf-8");

  const pidFileLine = options.pidFilePath
    ? `PID_FILE='${options.pidFilePath}'\n`
    : "";
  // Writing $$ BEFORE exec'ing script -q -f captures the bash PID while it's
  // still bash. Immediately after, `exec` replaces bash with `script` in-place —
  // the PID stays the same, which means the value in PID_FILE is NOW the PID
  // of `script` (the parent of claude's pty). SIGTERM to that PID tears down
  // script -> claude cleanly. The terminal tab closes when script exits.
  //
  // This is how `.claude/rules/agent-dispatch.md` specifies the cascade:
  // "killing the claude PID causes the bash script to exit and the Windows
  // Terminal tab to close". `exec` is the idiom that makes bash and script
  // the SAME tracked PID, avoiding orphan claude processes on cancel.
  const pidEmit = options.pidFilePath
    ? `echo $$ > "$PID_FILE"\n`
    : "";

  const scriptPath = join(settingsDir, "run-agent.sh");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
source ~/.profile 2>/dev/null || true
unset \${!CLAUDECODE@}

STATUS_URL='${options.statusUrl || ""}'
API_TOKEN='${options.apiToken}'
TERMINAL_LOG='${options.terminalLogPath}'
PROMPT_FILE='${promptFile}'
${pidFileLine}
report_status() {
  [ -n "$STATUS_URL" ] && curl -s -X PUT "$STATUS_URL" \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $API_TOKEN" \\
    -d "{\\"status\\": \\"$1\\", \\"summary\\": \\"$2\\"}" > /dev/null 2>&1 || true
}

report_status "running" ""
${pidEmit}
# CRITICAL: Host mode MUST be interactive. The prompt is delivered as a
# positional argument pointing at the prompt file — NOT piped via -p (headless
# mode, exits after one turn). See .claude/rules/host-mode-interactive.md.
#
# \`exec\` replaces this bash process with \`script\` in place, keeping the PID
# stable. Without exec, a SIGTERM to our bash PID may not reliably propagate
# to script+claude — exec makes \$\$ (what we wrote to PID_FILE) equal to the
# PID that actually wraps claude, so cancellation becomes a single, clean
# SIGTERM. Post-claude status reporting is handled by the node-side launcher
# (putStatus), so the bash "report exit code" branches are no longer needed.
#
# script -q -f wraps the interactive TUI so the ✻ thinking indicator is captured
# for the StallDetector; the inner claude process remains an attached TUI the
# user can read and type into.
exec script -q -f "$TERMINAL_LOG" -c "claude \\
${mcpLine}  --dangerously-skip-permissions \\
  --verbose \\
${agentsLine}  \\"Read $PROMPT_FILE and execute the task described in it.\\""
`,
  );
  chmodSync(scriptPath, 0o755);

  return scriptPath;
}

/**
 * Open a bash script in a new Windows Terminal tab via wt.exe.
 *
 * Returns immediately — the Claude process runs in the new tab.
 * CLAUDECODE env vars are stripped to prevent nesting issues.
 */
export function spawnInTerminal(options: TerminalLaunchOptions): void {
  const env = { ...(options.env ?? process.env) };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE")) {
      delete env[key];
    }
  }

  log.info(`Spawning in new terminal tab: ${options.title}`);

  const child = spawn(
    "wt.exe",
    [
      "-w",
      "0",
      "new-tab",
      "--title",
      options.title,
      "wsl.exe",
      "-e",
      "bash",
      options.script,
    ],
    { cwd: options.cwd, stdio: "ignore", env, detached: true },
  );
  child.on("error", (err) => {
    log.error(`Failed to spawn terminal: ${err.message} — is wt.exe available? (Docker containers need the dispatch API instead)`);
  });
  child.unref();
}
