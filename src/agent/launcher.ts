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
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

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
  timeout: number;
  maxRuntimeMs?: number;
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
function buildMcpSettings(options: LaunchOptions): string {
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
    postProgress(apiUrl, apiToken, message, "tool_use");
  }
}

/**
 * Launch a Claude Code agent for schema building.
 *
 * Spawns `claude` CLI with the Schema MCP server configured, starts a heartbeat
 * loop, streams events in real-time, and monitors the process for clean exit,
 * crash, or timeout. Reports all status changes to the status_url via PUT.
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

  // The task field contains the full orchestrator prompt from SchemaBuilderContextBuilder
  const prompt = options.task;

  // Clean environment — remove CLAUDECODE vars to prevent nesting issues
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("CLAUDECODE") && value !== undefined) {
      env[key] = value;
    }
  }

  const args = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    join(settingsDir, "settings.json"),
    "-p",
    prompt,
  ];

  // Add sub-agent definitions if provided
  if (options.agents && options.agents.length > 0) {
    args.push("--agents", JSON.stringify(options.agents));
  }

  console.log(`[Job ${jobId}] Launching Claude Code agent`);
  console.log(`[Job ${jobId}] Task: ${options.task.substring(0, 200)}`);

  // Write full prompt and agents to persistent logs dir for debugging
  const logDir = join(config.logsDir, jobId);
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "prompt.md"), prompt);
    if (options.agents && options.agents.length > 0) {
      writeFileSync(
        join(logDir, "agents.json"),
        JSON.stringify(options.agents, null, 2),
      );
    }
    console.log(`[Job ${jobId}] Prompt and agents logged to ${logDir}`);
  } catch (err) {
    console.error(`[Job ${jobId}] Failed to write agent logs:`, err);
  }

  let lastAssistantText = "";
  let stderr = "";
  let stdoutBuffer = "";

  const child = spawn("claude", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: settingsDir,
  });

  job.process = child;

  // Parse stream-json output line by line
  child.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();

    // Process complete JSON lines
    let newlineIdx: number;
    while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.substring(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIdx + 1);

      if (!line) continue;

      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        handleStreamEvent(event, options.apiUrl, options.apiToken, jobId);

        // Capture last assistant text for the summary
        if (event.type === "assistant") {
          const message = event.message as
            | { content?: Array<{ type: string; text?: string }> }
            | undefined;
          if (message?.content) {
            for (const block of message.content) {
              if (block.type === "text" && block.text) {
                lastAssistantText = block.text;
              }
            }
          }
        }
      } catch {
        // Not JSON — accumulate as raw output
      }
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // Start heartbeat loop
  startHeartbeat(job, options.apiToken);

  // Inactivity timeout — resets on every stdout event (MCP calls, assistant messages, tool results).
  // If the agent produces no output for the configured duration, it is presumed stuck and killed.
  let inactivityHandle: ReturnType<typeof setTimeout>;
  const inactivityMs = options.timeout;

  function resetInactivityTimeout(): void {
    clearTimeout(inactivityHandle);
    inactivityHandle = setTimeout(() => {
      if (job.status === "running") {
        console.log(
          `[Job ${jobId}] Inactivity timeout — no output for ${inactivityMs / 1000}s — killing process`,
        );
        child.kill("SIGTERM");
        job.status = "timeout";
        job.summary = `Agent timed out after ${Math.round(inactivityMs / 1000)} seconds of inactivity`;
        job.completedAt = new Date();
        stopHeartbeat(job);
        putStatus(job, options.apiToken, "failed", job.summary);
        cleanup();
      }
    }, inactivityMs);
  }

  // Reset on every stdout chunk — the agent is alive as long as it produces output
  child.stdout?.on("data", () => resetInactivityTimeout());

  // Start the initial inactivity timer
  resetInactivityTimeout();

  // Max runtime timeout — hard cap on total agent execution time (does NOT reset)
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
        cleanup();
      }
    }, options.maxRuntimeMs);
  }

  function cleanup(): void {
    clearTimeout(inactivityHandle);
    if (maxRuntimeHandle) clearTimeout(maxRuntimeHandle);
    try {
      rmSync(settingsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  child.on("close", (code: number | null) => {
    if (job.status === "running") {
      const isSuccess = code === 0;
      job.status = isSuccess ? "completed" : "failed";
      job.summary = isSuccess
        ? lastAssistantText.trim() || "Agent completed successfully"
        : `Process exited with code ${code}: ${stderr.trim() || lastAssistantText.trim() || "No output"}`;
      job.completedAt = new Date();

      console.log(`[Job ${jobId}] ${job.status} (exit code: ${code})`);

      stopHeartbeat(job);
      putStatus(
        job,
        options.apiToken,
        isSuccess ? "completed" : "failed",
        job.summary,
      );
      cleanup();
    }
  });

  child.on("error", (err: Error) => {
    if (job.status === "running") {
      job.status = "failed";
      job.summary = `Process error: ${err.message}`;
      job.completedAt = new Date();

      console.error(`[Job ${jobId}] Process error:`, err);

      stopHeartbeat(job);
      putStatus(job, options.apiToken, "failed", job.summary);
      cleanup();
    }
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
