/**
 * Host runtime: launch an interactive Claude Code TUI in a Windows Terminal tab.
 *
 * The claude-facing invocation (flags + first-user-message) is built once by
 * `buildClaudeInvocation()` (src/agent/claude-invocation.ts) and handed to us
 * fully formed. This module is responsible ONLY for the host-mode envelope:
 * the bash wrapper that captures PID + terminal output + reports a "running"
 * status, and the wt.exe launch. Zero knowledge of prompt/mcp/agent semantics.
 */

import { spawn } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "./logger.js";
import { bashSingleQuote } from "./agent/claude-invocation.js";

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
  /** Pre-built claude CLI flags (e.g. --dangerously-skip-permissions,
   *  --mcp-config <path>, --agents <json>). Docker and host share this list
   *  verbatim — see buildClaudeInvocation(). */
  flags: string[];
  /** The exact first-user-message for claude. Includes the dispatch tag,
   *  the Read directive pointing at prompt.md, and the optional Tracking line.
   *  Passed as a positional argument to keep the TUI interactive. */
  firstMessage: string;
  /** Job ID — used to name the terminal log path via getTerminalLogPath() */
  jobId: string;
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
 * 1. Emits its own PID so the launcher can track and SIGTERM it later
 * 2. Reports "running" status so upstream learns the dispatch reached claude
 * 3. Execs `script -q -f` wrapping an interactive `claude flags firstMessage`
 *    (positional arg — not -p) so the ✻ thinking indicator lands in the log
 *    for StallDetector while the TUI stays attached for the user
 */
export function buildDispatchScript(
  settingsDir: string,
  options: DispatchScriptOptions,
): string {
  // Build the claude argv as a bash array literal. Each element is wrapped in
  // single quotes — safe for any content because single quotes don't interpret
  // `$`, `"`, `\`, `!`, etc. A literal `'` inside a value is handled by the
  // `'\''` idiom in bashSingleQuote.
  //
  // CRITICAL: we do NOT build `claude '--arg1' '--arg2' ...` inside an outer
  // `"..."` for `script -c`. JSON values contain `"`, which would close that
  // outer double-quote prematurely and produce an unparseable bash file. The
  // array + `"${CLAUDE_ARGV[@]}"` expansion sidesteps the problem entirely:
  // `printf '%q '` re-escapes each element for the nested `sh -c` that
  // `script -c` performs, so the claude invocation is a single word to
  // `script` regardless of what's inside the args.
  const claudeArgvLiteral = [
    "claude",
    ...options.flags,
    options.firstMessage,
  ]
    .map(bashSingleQuote)
    .join(" ");
  const quotedStatusUrl = bashSingleQuote(options.statusUrl || "");
  const quotedApiToken = bashSingleQuote(options.apiToken);
  const quotedTerminalLog = bashSingleQuote(options.terminalLogPath);

  const pidFileLine = options.pidFilePath
    ? `PID_FILE=${bashSingleQuote(options.pidFilePath)}\n`
    : "";
  // Writing $$ BEFORE exec'ing script -q -f captures the bash PID while it's
  // still bash. Immediately after, `exec` replaces bash with `script` in-place —
  // the PID stays the same, which means the value in PID_FILE is NOW the PID
  // of `script` (the parent of claude's pty). SIGTERM to that PID tears down
  // script -> claude cleanly. The terminal tab closes when script exits.
  //
  // Signal cascade: SIGTERM to `script`'s PID closes the pty that claude is
  // attached to; claude receives SIGHUP (standard util-linux `script`
  // behaviour on WSL2) and exits cleanly. No orphaned claude. This is the
  // mechanism `.claude/rules/agent-dispatch.md` ("Cancellation") relies on.
  //
  // `exec` is load-bearing: without it, bash would remain the parent of
  // script, and SIGTERM to bash's PID would NOT reliably propagate to script
  // (bash doesn't forward signals to foreground children by default). The
  // exec-to-script pattern is the idiomatic workaround.
  const pidEmit = options.pidFilePath
    ? `echo $$ > "$PID_FILE"\n`
    : "";

  const scriptPath = join(settingsDir, "run-agent.sh");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
source ~/.profile 2>/dev/null || true
unset \${!CLAUDECODE@}

STATUS_URL=${quotedStatusUrl}
API_TOKEN=${quotedApiToken}
TERMINAL_LOG=${quotedTerminalLog}
${pidFileLine}
report_status() {
  [ -n "$STATUS_URL" ] && curl -s -X PUT "$STATUS_URL" \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $API_TOKEN" \\
    -d "{\\"status\\": \\"$1\\", \\"summary\\": \\"$2\\"}" > /dev/null 2>&1 || true
}

report_status "running" ""
${pidEmit}
# CRITICAL: Host mode MUST be interactive. firstMessage is delivered as a
# positional argument (NOT piped via -p, which exits after one turn).
# See .claude/rules/host-mode-interactive.md.
#
# \`exec\` replaces this bash process with \`script\` in place, keeping the PID
# stable so the PID in PID_FILE wraps claude's pty directly — cancellation
# becomes a single clean SIGTERM. Post-claude status reporting is handled by
# the node-side launcher (putStatus).
#
# script -q -f wraps the interactive TUI so the ✻ thinking indicator is
# captured for the StallDetector; the inner claude process remains an attached
# TUI the user can read and type into.
CLAUDE_ARGV=(${claudeArgvLiteral})
exec script -q -f "$TERMINAL_LOG" -c "$(printf '%q ' "\${CLAUDE_ARGV[@]}")"
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
