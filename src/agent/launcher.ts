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

const HEARTBEAT_INTERVAL_MS = 10_000;
const TERMINAL_STATUS_RETRIES = 3;
const TERMINAL_STATUS_RETRY_DELAY_MS = 2_000;

/** Active jobs indexed by job ID for cancel/status lookups */
const activeJobs = new Map<string, AgentJob>();

/** Find an active job by ID */
export function findJob(jobId: string): AgentJob | undefined {
  return activeJobs.get(jobId);
}

export interface LaunchOptions {
  task: string;
  apiToken: string;
  apiUrl: string;
  statusUrl?: string;
  schemaDefinitionId?: string;
  mcpServerPath: string;
  timeout: number;
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
        args: ["tsx", options.mcpServerPath],
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
    } else if (toolInput?.model_name) {
      message += `: ${toolInput.model_name}`;
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

  // Build the prompt
  const prompt = [
    `You are a schema builder agent. Your task: ${options.task}`,
    "",
    "Use the schema MCP tools to read and modify the schema.",
    "Create annotations to document your research, decisions, and questions.",
    "When done, provide a summary of what you accomplished.",
  ].join("\n");

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

  console.log(`[Job ${jobId}] Launching Claude Code agent`);
  console.log(`[Job ${jobId}] Task: ${options.task.substring(0, 200)}`);

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

  // Timeout handler
  const timeoutHandle = setTimeout(() => {
    if (job.status === "running") {
      console.log(
        `[Job ${jobId}] Timeout after ${options.timeout / 1000}s — killing process`,
      );
      child.kill("SIGTERM");
      job.status = "timeout";
      job.summary = `Agent timed out after ${Math.round(options.timeout / 1000)} seconds`;
      job.completedAt = new Date();
      stopHeartbeat(job);
      putStatus(job, options.apiToken, "failed", job.summary);
      cleanup();
    }
  }, options.timeout);

  function cleanup(): void {
    clearTimeout(timeoutHandle);
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

  // Store in active jobs map for cancel/status lookups
  activeJobs.set(jobId, job);
  setTimeout(() => activeJobs.delete(jobId), 3600_000); // Clean up after 1 hour

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
