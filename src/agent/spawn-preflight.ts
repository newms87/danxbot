/**
 * spawnAgent() preflight — input validation, auth + projects-dir checks,
 * MCP server probe, jobId allocation, AgentJob skeleton construction,
 * and `claude` invocation building.
 *
 * Lives outside `launcher.ts` so the orchestrator function stays focused
 * on observer wiring + the runtime fork. Every check here either:
 *   - throws loudly (caller never sees a half-initialized job), OR
 *   - returns a fully-validated `PreflightResult` ready for the rest of
 *     `spawnAgent` to attach observers and pick a runtime fork.
 *
 * No fallbacks, no silent recoveries — see `.claude/rules/code-quality.md`
 * "Fallbacks are bugs".
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { buildCleanEnv, logPromptToDisk } from "./process-utils.js";
import { buildClaudeInvocation } from "./claude-invocation.js";
import { probeAllMcpServers } from "./mcp-server-probe.js";
import {
  preflightClaudeAuth,
  ClaudeAuthError,
} from "./claude-auth-preflight.js";
import {
  preflightProjectsDir,
  ProjectsDirError,
} from "./projects-dir-preflight.js";
import type { AgentJob, SpawnAgentOptions } from "./agent-types.js";

const log = createLogger("spawn-preflight");

export interface PreflightResult {
  jobId: string;
  job: AgentJob;
  env: Record<string, string>;
  flags: string[];
  firstMessage: string;
  promptDir: string | null;
  agentCwd: string;
}

/**
 * Run all spawn-time checks and build the immutable inputs the runtime
 * fork needs. On success, returns the partial AgentJob (still missing
 * `handle`, `_cleanup`, real `stop`) along with the resolved invocation.
 *
 * Throws:
 *   - Plain `Error` — invalid options (e.g., parentJobId without dispatch).
 *   - `ClaudeAuthError` — broken claude-auth chain (RO bind, expired token).
 *   - `ProjectsDirError` — `~/.claude/projects/` not writable by the worker.
 *   - Plain `Error` — MCP probe failed for any configured server.
 *
 * On MCP probe failure the function self-cleans the prompt temp dir before
 * throwing — the caller's catch in `dispatch()` only knows about the MCP
 * settings dir, NOT about `promptDir`. Skipping this would leak a
 * `/tmp/danxbot-prompt-*` dir on every broken dispatch.
 */
export async function runSpawnPreflight(
  options: SpawnAgentOptions,
): Promise<PreflightResult> {
  // Fail loud: a parent lineage without a dispatch row is a silent drop of
  // resume context — callers that want resume MUST opt into tracking.
  if (options.parentJobId && !options.dispatch) {
    throw new Error(
      "spawnAgent: parentJobId requires dispatch metadata — a resume without a dispatch row silently drops lineage",
    );
  }

  // Claude-auth preflight (Trello 3l2d7i46). RO bind / expired token / missing
  // credentials all surface as silent dispatch timeouts — `claude -p` exits
  // 0 with empty stdout, the watcher never attaches, and the worker reports
  // "Agent timed out after N seconds of inactivity" pointing at network
  // instead of at the actual broken auth chain. Run this BEFORE
  // `buildClaudeInvocation` (which writes a prompt temp dir) so the early
  // failure path needs no cleanup. Cheap — single stat + read on the bind.
  const authPreflight = await preflightClaudeAuth();
  if (!authPreflight.ok) {
    throw new ClaudeAuthError(authPreflight);
  }

  // Trello cjAyJpgr-followup: parallel silent-failure mode on the projects
  // dir bind. If `~/.claude/projects/` is owned by root (Docker auto-create
  // when the OLD `${CLAUDE_PROJECTS_DIR:?...}` mount resolved to a
  // non-existent path on first compose-up), claude `-p` silently fails
  // to write JSONL, the watcher never attaches, and the dispatch times
  // out with no useful summary. Same pattern as auth-preflight: fail
  // loud at spawn so the operator sees the actionable chown command.
  const projectsPreflight = await preflightProjectsDir();
  if (!projectsPreflight.ok) {
    throw new ProjectsDirError(projectsPreflight);
  }

  const jobId = options.jobId ?? randomUUID();

  // `stop` is assigned later (after the cleanup closure is built in
  // launcher.ts). Use a throwing placeholder so the type contract stays
  // non-optional — calling stop() before the real handler is wired would
  // be a construction bug, not a legitimate race we need to tolerate.
  const job: AgentJob = {
    id: jobId,
    status: "running",
    summary: "",
    startedAt: new Date(),
    statusUrl: options.statusUrl,
    stop: async () => {
      throw new Error(
        `spawnAgent: job.stop called before initialization (jobId=${jobId})`,
      );
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };

  const env = buildCleanEnv(options.env);

  // Single builder — docker and host paths share the exact flags + firstMessage.
  // Runtime only decides whether firstMessage is appended via `-p` (docker
  // headless) or passed as a positional argument inside the bash wrapper
  // (host interactive). See `.claude/rules/agent-dispatch.md`.
  const invocation = buildClaudeInvocation({
    prompt: options.prompt,
    jobId,
    title: options.title,
    mcpConfigPath: options.mcpConfigPath,
    agents: options.agents,
    topLevelAgent: options.topLevelAgent,
    resumeSessionId: options.resumeSessionId,
  });
  const { flags, firstMessage, promptDir } = invocation;

  // Dispatched agents cwd into the resolved plural workspace at
  // `<repo>/.danxbot/workspaces/<name>/`. The repo root belongs to the
  // developer's interactive claude session (use case #1) — the
  // agent-isolation contract forbids dispatched cwd at the repo root.
  // See Trello card `7ha2CSpc` and `.claude/rules/agent-dispatch.md`.
  const agentCwd = options.cwd;

  log.info(`[Job ${jobId}] Launching agent`);
  log.info(`[Job ${jobId}] Prompt: ${options.prompt.substring(0, 200)}`);

  logPromptToDisk(config.logsDir, jobId, options.prompt, options.agents);

  // Pre-launch MCP probe — verify every configured MCP server can actually
  // start and respond to an `initialize` request before claude is spawned.
  // Claude launches happily even when an MCP server crashes on startup; the
  // tools silently disappear from the agent's tool set and the agent either
  // burns credits before noticing or never notices at all. Failing loudly
  // here preserves the "fallbacks are bugs" invariant (see
  // `.claude/rules/code-quality.md`).
  //
  // Cleanup on failure: we must rmSync `promptDir` ourselves because the
  // outer `cleanup()` closure (built in launcher.ts after this returns)
  // isn't in scope yet. The caller-side catch in `dispatch()` (see
  // `src/dispatch/core.ts`'s `spawnForDispatch`) handles the MCP settings
  // temp dir but does NOT know about `promptDir`. Skipping this would leak
  // a `/tmp/danxbot-prompt-*` dir on every broken dispatch.
  if (options.mcpConfigPath) {
    const probeResult = await probeAllMcpServers(
      options.mcpConfigPath,
      config.dispatch.mcpProbeTimeoutMs,
    );
    if (!probeResult.ok) {
      if (promptDir) rmSync(promptDir, { recursive: true, force: true });
      const names = probeResult.failures.map((f) => f.serverName).join(", ");
      const details = probeResult.failures
        .map((f) => `  - ${f.message}`)
        .join("\n");
      throw new Error(
        `MCP server probe failed for [${names}] before launching agent:\n${details}`,
      );
    }
  }

  return { jobId, job, env, flags, firstMessage, promptDir, agentCwd };
}
