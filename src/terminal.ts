/**
 * Shared utility for spawning Claude Code in a Windows Terminal tab.
 *
 * Used by both the Trello poller (card-triggered) and the dispatch API
 * (HTTP-triggered from GPT Manager). One mechanism, two triggers.
 */

import { spawn } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
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
  /** Absolute path to the prompt file */
  promptFile: string;
  /** Absolute path to the MCP settings.json */
  mcpConfigPath: string;
  /** Absolute path to agents.json (optional) */
  agentsFile?: string;
  /** Status URL for reporting back to Laravel */
  statusUrl?: string;
  /** API token for status reporting */
  apiToken: string;
}

/**
 * Build a bash script that launches claude interactively with MCP config
 * and reports status back to Laravel on exit via curl.
 */
export function buildDispatchScript(
  settingsDir: string,
  options: DispatchScriptOptions,
): string {
  const agentsFlag = options.agentsFile
    ? `--agents "$(cat '${options.agentsFile}')"`
    : "";

  const scriptPath = join(settingsDir, "run-agent.sh");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
source ~/.profile 2>/dev/null || true
unset \${!CLAUDECODE@}

STATUS_URL='${options.statusUrl || ""}'
API_TOKEN='${options.apiToken}'

report_status() {
  [ -n "$STATUS_URL" ] && curl -s -X PUT "$STATUS_URL" \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $API_TOKEN" \\
    -d "{\\"status\\": \\"$1\\", \\"summary\\": \\"$2\\"}" > /dev/null 2>&1 || true
}

report_status "running" ""

claude --dangerously-skip-permissions \\
  --verbose \\
  --mcp-config '${options.mcpConfigPath}' \\
  ${agentsFlag} \\
  "Read ${options.promptFile} and execute the task described in it."

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

  spawn(
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
  ).unref();
}
