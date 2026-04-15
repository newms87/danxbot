/**
 * Agent Launcher — Spawns Claude Code with the Schema MCP server.
 *
 * Each launch creates an isolated Claude Code process with:
 * - The Schema MCP server as an MCP tool provider
 * - Environment variables for API auth and schema targeting
 * - A heartbeat loop that PUTs to status_url every 10 seconds
 * - Real-time event streaming via --output-format stream-json
 * - Crash detection that reports terminal status to status_url
 * - A timeout that kills the process if it runs too long
 */

import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { getReposBase } from "../poller/constants.js";
import {
  buildCleanEnv,
  attachStreamParser,
  logPromptToDisk,
  createInactivityTimer,
  setupProcessHandlers,
  writeJobLogs,
} from "./process-utils.js";

const HEARTBEAT_INTERVAL_MS = 10_000;
const TERMINAL_STATUS_RETRIES = 3;
const TERMINAL_STATUS_RETRY_DELAY_MS = 2_000;

export interface LaunchOptions {
  task: string;
  agents?: Array<Record<string, unknown>>;
  apiToken: string;
  apiUrl: string;
  statusUrl?: string;
  schemaDefinitionId?: string;
  schemaRole?: string;
  timeout: number;
  maxRuntimeMs?: number;
  repoName: string;
}

export interface AgentJob {
  id: string;
  status: "running" | "completed" | "failed" | "timeout" | "canceled";
  summary: string;
  startedAt: Date;
  completedAt?: Date;
  statusUrl?: string;
  process?: ChildProcess;
  heartbeatInterval?: ReturnType<typeof setInterval>;
}

/**
 * PUT status update to the dispatch's status_url.
 * Terminal statuses (completed, failed, canceled) retry up to 3 times.
 */
async function putStatus(
  job: AgentJob,
  apiToken: string,
  status: string,
  message?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!job.statusUrl) return;

  const body = JSON.stringify({
    status,
    message: message || undefined,
    data: data || undefined,
  });

  const isTerminal = status !== "running";
  const maxAttempts = isTerminal ? TERMINAL_STATUS_RETRIES : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(job.statusUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body,
      });

      if (response.ok) return;

      console.error(
        `[Job ${job.id}] Status PUT failed (attempt ${attempt}/${maxAttempts}): HTTP ${response.status}`,
      );
    } catch (err) {
      console.error(
        `[Job ${job.id}] Status PUT error (attempt ${attempt}/${maxAttempts}):`,
        err,
      );
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, TERMINAL_STATUS_RETRY_DELAY_MS),
      );
    }
  }

  if (isTerminal) {
    console.error(
      `[Job ${job.id}] All ${maxAttempts} status PUT attempts failed for terminal status '${status}'. Remote dead-detection will handle cleanup.`,
    );
  }
}

/**
 * POST a progress event to the MCP progress endpoint.
 * Non-blocking — errors are logged but don't affect the agent.
 */
async function postProgress(
  apiUrl: string,
  apiToken: string,
  message: string,
  phase?: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/schemas/mcp/progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify({ message, phase }),
    });
  } catch {
    // Non-fatal — progress is best-effort
  }
}

/**
 * Start the heartbeat loop for a running job.
 * Sends PUT {status_url} with { status: "running" } every 10 seconds.
 */
function startHeartbeat(job: AgentJob, apiToken: string): void {
  if (!job.statusUrl) return;

  job.heartbeatInterval = setInterval(() => {
    if (job.status !== "running") {
      stopHeartbeat(job);
      return;
    }
    putStatus(job, apiToken, "running");
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(job: AgentJob): void {
  if (job.heartbeatInterval) {
    clearInterval(job.heartbeatInterval);
    job.heartbeatInterval = undefined;
  }
}

/**
 * Build the MCP settings JSON for this agent session.
 * Creates a temporary directory with settings.json that configures
 * the Schema MCP server as a tool provider for Claude Code.
 */
export function buildMcpSettings(options: LaunchOptions): string {
  const tempDir = mkdtempSync(join(tmpdir(), "danxbot-mcp-"));

  const settings = {
    mcpServers: {
      schema: {
        command: "npx",
        args: ["@thehammer/schema-mcp-server"],
        env: {
          SCHEMA_API_URL: options.apiUrl,
          SCHEMA_API_TOKEN: options.apiToken,
          ...(options.schemaDefinitionId
            ? { SCHEMA_DEFINITION_ID: String(options.schemaDefinitionId) }
            : {}),
          ...(options.schemaRole ? { SCHEMA_ROLE: options.schemaRole } : {}),
        },
      },
    },
  };

  const settingsPath = join(tempDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  return tempDir;
}

/**
 * Parse a stream-json event from Claude Code CLI and forward relevant
 * events as progress updates to gpt-manager.
 */
function handleStreamEvent(
  event: Record<string, unknown>,
  apiUrl: string,
  apiToken: string,
  jobId: string,
): void {
  const type = event.type as string;

  if (type === "assistant") {
    // Assistant text message — forward as thinking/progress
    const message = event.message as
      | { content?: Array<{ type: string; text?: string }> }
      | undefined;
    if (message?.content) {
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          const text =
            block.text.length > 500
              ? block.text.substring(0, 500) + "…"
              : block.text;
          console.log(`[Job ${jobId}] 💬 ${text}`);
          postProgress(apiUrl, apiToken, text, "thinking");
        }
      }
    }
  } else if (type === "tool_use") {
    // Tool call — forward tool name as progress
    const toolName = (event.tool_name as string) || "unknown tool";
    const toolInput = event.input as Record<string, unknown> | undefined;
    let message = `Using ${toolName}`;
    if (toolInput?.message) {
      message += `: ${toolInput.message}`;
    } else if (toolInput?.field_name) {
      message += `: ${toolInput.field_name}`;
    } else if (toolInput?.title) {
      message += `: ${toolInput.title}`;
    }
    console.log(`[Job ${jobId}] 🔧 ${message}`);
    postProgress(apiUrl, apiToken, message, "tool_use");
  }
}

/**
 * Launch a Claude Code agent in piped mode (headless).
 *
 * Spawns `claude` CLI with stream-json output, starts a heartbeat loop,
 * parses events in real-time, and monitors for clean exit, crash, or timeout.
 * Reports all status changes to the status_url via PUT.
 *
 * For interactive terminal mode, the dashboard server handles launching
 * directly via spawnInTerminal (same mechanism as the Trello poller).
 */
export async function launchAgent(options: LaunchOptions): Promise<AgentJob> {
  const jobId = randomUUID();
  const settingsDir = buildMcpSettings(options);

  const job: AgentJob = {
    id: jobId,
    status: "running",
    summary: "",
    startedAt: new Date(),
    statusUrl: options.statusUrl,
  };

  const env = buildCleanEnv();

  const args = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    join(settingsDir, "settings.json"),
    "-p",
    options.task,
  ];

  if (options.agents && options.agents.length > 0) {
    args.push("--agents", JSON.stringify(options.agents));
  }

  console.log(`[Job ${jobId}] Launching Claude Code agent`);
  console.log(`[Job ${jobId}] Task: ${options.task.substring(0, 200)}`);

  logPromptToDisk(config.logsDir, jobId, options.task, options.agents);

  const agentCwd = join(getReposBase(), options.repoName);

  const child = spawn("claude", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: agentCwd,
  });

  job.process = child;

  // Stream parser with dispatch-specific progress forwarding
  const { getLastAssistantText } = attachStreamParser(child, (event) => {
    handleStreamEvent(event, options.apiUrl, options.apiToken, jobId);
  });

  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // Start heartbeat loop for status reporting
  startHeartbeat(job, options.apiToken);

  // Inactivity timeout — kills the agent if no stdout for the configured duration
  const inactivityTimer = createInactivityTimer(
    child,
    options.timeout,
    () => {
      stopHeartbeat(job);
      putStatus(job, options.apiToken, "failed", job.summary);
      cleanupSettingsDir();
    },
    job,
  );

  // Max runtime timeout — hard cap that does NOT reset on activity
  let maxRuntimeHandle: ReturnType<typeof setTimeout> | undefined;
  if (options.maxRuntimeMs) {
    maxRuntimeHandle = setTimeout(() => {
      if (job.status === "running") {
        console.log(
          `[Job ${jobId}] Max runtime exceeded — ${options.maxRuntimeMs! / 1000}s — killing process`,
        );
        child.kill("SIGTERM");
        job.status = "timeout";
        job.summary = `Agent exceeded max runtime of ${Math.round(options.maxRuntimeMs! / 1000 / 60)} minutes`;
        job.completedAt = new Date();
        stopHeartbeat(job);
        putStatus(job, options.apiToken, "failed", job.summary);
        cleanupAll();
      }
    }, options.maxRuntimeMs);
  }

  function cleanupSettingsDir(): void {
    try {
      rmSync(settingsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  function cleanupAll(): void {
    inactivityTimer.clear();
    if (maxRuntimeHandle) clearTimeout(maxRuntimeHandle);
    cleanupSettingsDir();
  }

  setupProcessHandlers(child, job, getLastAssistantText, () => stderr, {
    onComplete: (j) => {
      stopHeartbeat(j);
      const isSuccess = j.status === "completed";
      putStatus(j, options.apiToken, isSuccess ? "completed" : "failed", j.summary);
    },
    cleanup: cleanupAll,
  });

  return job;
}

/**
 * Cancel a running job by sending SIGTERM, then SIGKILL after 5 seconds.
 */
export async function cancelJob(
  job: AgentJob,
  apiToken: string,
): Promise<void> {
  if (job.status !== "running" || !job.process) return;

  console.log(`[Job ${job.id}] Cancel requested — sending SIGTERM`);

  job.process.kill("SIGTERM");

  // Wait 5 seconds for graceful shutdown
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Force kill if still running
  if (job.status === "running" && job.process) {
    console.log(`[Job ${job.id}] Still running after 5s — sending SIGKILL`);
    job.process.kill("SIGKILL");
  }

  if (job.status === "running") {
    job.status = "canceled";
    job.summary = "Agent was canceled by user request";
    job.completedAt = new Date();
  }

  stopHeartbeat(job);
  await putStatus(job, apiToken, "canceled", job.summary);
}

export interface HeadlessAgentOptions {
  /** The prompt/command to pass to claude CLI (e.g. "/danx-next") */
  prompt: string;
  /** Repo name — used to resolve cwd to repos/<name> */
  repoName: string;
  /** Inactivity timeout in milliseconds — kills the agent if no stdout for this duration */
  timeoutMs: number;
  /** Additional env vars to merge into the spawned process environment */
  env?: Record<string, string>;
  /** Called when the agent finishes (success, failure, or timeout) */
  onComplete?: (job: AgentJob) => void;
}

/**
 * Spawn a headless Claude Code agent without dispatch/MCP dependencies.
 *
 * Used by the poller (Docker mode) and any other caller that needs a simple
 * Claude CLI process with stream-json output, inactivity timeout, and
 * completion tracking — but no MCP schema server, heartbeat, or status PUT.
 */
export async function spawnHeadlessAgent(options: HeadlessAgentOptions): Promise<AgentJob> {
  const jobId = randomUUID();

  const job: AgentJob = {
    id: jobId,
    status: "running",
    summary: "",
    startedAt: new Date(),
  };

  const env = buildCleanEnv(options.env);

  const args = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "-p",
    options.prompt,
  ];

  const agentCwd = join(getReposBase(), options.repoName);

  console.log(`[Job ${jobId}] Launching headless agent`);
  console.log(`[Job ${jobId}] Prompt: ${options.prompt.substring(0, 200)}`);

  logPromptToDisk(config.logsDir, jobId, options.prompt);

  const child = spawn("claude", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: agentCwd,
  });

  job.process = child;

  const { getLastAssistantText } = attachStreamParser(child);

  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // Accumulate raw stdout for disk logging
  let stdout = "";
  child.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  const inactivityTimer = createInactivityTimer(
    child,
    options.timeoutMs,
    (j) => {
      writeJobLogs(config.logsDir, jobId, stderr, stdout);
      options.onComplete?.(j);
    },
    job,
  );

  setupProcessHandlers(child, job, getLastAssistantText, () => stderr, {
    onComplete: (j) => {
      writeJobLogs(config.logsDir, jobId, stderr, stdout);
      options.onComplete?.(j);
    },
    cleanup: () => inactivityTimer.clear(),
  });

  return job;
}

/**
 * Get the status of a job for the API response.
 */
export function getJobStatus(job: AgentJob): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    summary: job.summary,
    started_at: job.startedAt.toISOString(),
    completed_at: job.completedAt?.toISOString() || null,
    elapsed_seconds: Math.round(
      ((job.completedAt?.getTime() || Date.now()) - job.startedAt.getTime()) /
        1000,
    ),
  };
}
