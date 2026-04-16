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
 * Build a bash script that launches claude interactively with `script -q -f`
 * to capture terminal output, and reports status back on exit via curl.
 *
 * The script:
 * 1. Writes the prompt to a temp file (avoids shell quoting issues)
 * 2. Wraps claude with `script -q -f <terminalLogPath>` so the thinking indicator
 *    (✻) is captured and the StallDetector can detect active vs stuck agents
 * 3. Reports status to statusUrl on completion
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

report_status() {
  [ -n "$STATUS_URL" ] && curl -s -X PUT "$STATUS_URL" \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $API_TOKEN" \\
    -d "{\\"status\\": \\"$1\\", \\"summary\\": \\"$2\\"}" > /dev/null 2>&1 || true
}

report_status "running" ""

script -q -f "$TERMINAL_LOG" -c "claude \\
${mcpLine}  --dangerously-skip-permissions \\
  --verbose \\
${agentsLine}  -p \\"\\$(cat '$PROMPT_FILE')\\""

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  report_status "completed" "Agent completed successfully"
else
  report_status "failed" "Process exited with code $EXIT_CODE"
fi
echo ""
echo "Agent finished (exit code $EXIT_CODE). Press Enter to close."
read
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
