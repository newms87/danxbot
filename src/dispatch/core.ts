/**
 * Unified dispatch core — the one `dispatch()` function every dispatch
 * entry-point calls. Owns workspace resolution, MCP server materialization
 * (workspace's `.mcp.json` + danxbot infrastructure server), the per-dispatch
 * settings.json file, the single spawnAgent call, dispatch row creation,
 * stall recovery, activeJobs registration, and TTL-based eviction.
 *
 * Callers:
 *   - HTTP `handleLaunch` / `handleResume` in `src/worker/dispatch.ts`
 *   - Trello poller (`src/poller/index.ts`)
 *   - Slack listener (`src/slack/listener.ts`)
 *
 * Every dispatch lands in a workspace — a directory at
 * `<repo>/.danxbot/workspaces/<name>/` declaring the MCP servers,
 * allowed tools, and `.claude/settings.json` env block. Callers pass
 * the workspace name + an overlay (placeholder substitutions). Danxbot
 * does NOT ship a default workspace; callers without one (e.g. external
 * HTTP callers) MUST provide one in their target repo or be rejected
 * upstream by the API handler.
 *
 * Runs identically for launches and resumes — the only differences are
 * `input.resumeSessionId` (appended to the claude invocation via spawnAgent)
 * and `input.parentJobId` (persisted on the dispatch row).
 *
 * See `.claude/rules/agent-dispatch.md` for the full contract.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";
import {
  spawnAgent,
  buildCompletionInstruction,
  terminateWithGrace,
  type AgentJob,
} from "../agent/launcher.js";
import { TerminalOutputWatcher } from "../agent/terminal-output-watcher.js";
import { StallDetector } from "../agent/stall-detector.js";
import {
  defaultMcpRegistry,
  DANXBOT_COMPLETE_TOOL,
  DANXBOT_SERVER_NAME,
} from "../agent/mcp-registry.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";
import { updateDispatch } from "../dashboard/dispatches-db.js";
import {
  resolveWorkspace,
  cleanupWorkspaceMcpSettings,
} from "../workspace/resolve.js";

const log = createLogger("dispatch-core");

/** Maximum number of stall-recovery respawns before giving up and marking failed. */
const MAX_STALL_RESUMES = 3;

/** How long an evicted-but-finished job lingers in `activeJobs` for late pollers. */
const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_POLL_INTERVAL_MS = 60_000;

/**
 * All dispatched jobs keyed by their stable `dispatchId`. Reused across stall-
 * recovery respawns (each respawn is a fresh claude process under a fresh
 * internal UUID, but `activeJobs` remains keyed by the first `dispatchId` so
 * external pollers see one conceptual run).
 *
 * Module-scoped singleton — worker HTTP handlers (`handleCancel`, `handleStop`,
 * `handleStatus`) read through `getActiveJob(jobId)`. Worker shutdown calls
 * `clearJobCleanupIntervals()` to drain the TTL timers.
 */
const activeJobs = new Map<string, AgentJob>();

/** TTL timers — one per dispatch — that evict finished jobs after the grace window. */
const jobCleanupIntervals = new Set<NodeJS.Timeout>();

/** Lookup a currently-tracked job (running or recently finished). */
export function getActiveJob(jobId: string): AgentJob | undefined {
  return activeJobs.get(jobId);
}

/**
 * Snapshot of every job currently tracked — running and recently-finished
 * (still within the TTL grace window). Returns a fresh array so callers can
 * iterate safely without worrying about concurrent eviction.
 *
 * Used by `src/shutdown.ts` to drain in-flight dispatches on SIGTERM.
 * Callers that only care about live work should filter by
 * `job.status === "running"` themselves.
 */
export function listActiveJobs(): AgentJob[] {
  return Array.from(activeJobs.values());
}

/** Drain all TTL eviction timers; call during worker shutdown. */
export function clearJobCleanupIntervals(): void {
  for (const interval of jobCleanupIntervals) {
    clearInterval(interval);
  }
  jobCleanupIntervals.clear();
}

/**
 * Reset module state for tests. Drains both the activeJobs registry and
 * any pending TTL eviction timers. Test-only — never call from
 * production code paths. Used by handlers that need to assert on the
 * full active-jobs map without inheriting jobs registered by sibling
 * describe blocks earlier in the same vitest worker.
 */
export function _resetForTesting(): void {
  activeJobs.clear();
  clearJobCleanupIntervals();
}

/**
 * Everything a dispatch needs. Caller-facing shape — HTTP handlers map their
 * body into this; the poller constructs one from a Trello trigger; the Slack
 * listener constructs one for every deep-agent reply.
 *
 * Every dispatch names a `workspace` (resolves to
 * `<repo>/.danxbot/workspaces/<workspace>/` on disk) and supplies an `overlay`
 * — a string-map substituted into the workspace's `.mcp.json` and
 * `.claude/settings.json` placeholders. Tool surface, MCP servers, and rules
 * all flow from the workspace fixture; danxbot never knows what they mean.
 */
export interface DispatchInput {
  repo: RepoContext;
  task: string;
  /**
   * Workspace name — resolves to `<repo>/.danxbot/workspaces/<workspace>/`.
   * Required. Missing or empty workspace MUST be rejected at the entry-point
   * boundary (HTTP handler, poller skill loader, Slack listener) BEFORE
   * reaching this struct — `dispatch()` does not validate it itself.
   */
  workspace: string;
  /**
   * Placeholder substitution map. Every `${KEY}` in the workspace's
   * `.mcp.json` and `.claude/settings.json` is replaced from this map.
   * `DANXBOT_STOP_URL` and the Slack URL placeholders are auto-injected
   * from the dispatchId so callers don't have to pre-compute them;
   * everything else (TRELLO_*, SCHEMA_*, etc.) is caller-supplied.
   */
  overlay: Readonly<Record<string, string>>;
  /**
   * Bearer token for danxbot's `statusUrl` callbacks (Laravel forwarder
   * PUTs). Required when `statusUrl` is set; otherwise unused.
   *
   * NOTE: this is NOT a caller-app credential. Per-app secrets (e.g.
   * gpt-manager's schema MCP token) live in `overlay.SCHEMA_API_TOKEN`
   * or similar — danxbot never inspects them.
   */
  apiToken?: string;
  statusUrl?: string;
  title?: string;
  maxRuntimeMs?: number;
  /**
   * Inactivity timeout (ms) forwarded to spawnAgent. Defaults to
   * `config.dispatch.agentTimeoutMs`. The poller overrides this with its
   * own `pollerIntervalMs * 60` budget; HTTP handlers rely on the default.
   */
  timeoutMs?: number;
  /**
   * Open an interactive Windows Terminal tab alongside the headless claude.
   * Defaults to `config.isHost`. Callers rarely override — only scenarios
   * that need docker headless behavior inside host mode (tests) do.
   */
  openTerminal?: boolean;
  /**
   * Additional env overrides merged on top of the dispatch's base env.
   *
   * The dispatch always injects `DANXBOT_REPO_NAME=input.repo.name` into
   * the spawned agent's environment — callers never need to supply that.
   * This field is for everything else (test hooks, future integrations
   * that need custom env), and most callers can leave it undefined.
   *
   * Precedence when both are set: `input.env` wins over the auto-injected
   * invariants, which allows tests to override `DANXBOT_REPO_NAME` for
   * isolation. Don't rely on that in production callers — the auto-inject
   * is the contract.
   */
  env?: Record<string, string>;
  /**
   * Fired once the agent reaches a terminal state.
   *
   * Ordering guarantee (enforced inside `dispatch()`):
   *   1. Internal MCP-settings cleanup runs FIRST so the callback observes
   *      a fully disposed slot (no leftover temp dir).
   *   2. `onComplete(job)` runs SECOND with the final `AgentJob`.
   *   3. Any `statusUrl` PUT (fired by the Laravel forwarder and
   *      `putStatus` inside the launcher) is independent and may land
   *      before, during, or after this callback — they are NOT mutually
   *      exclusive. A caller that wants both a local callback AND an
   *      external PUT can set both fields.
   *
   * Today's consumer: the poller, for card-progress checks, stuck-card
   * recovery, and consecutive-failure backoff. HTTP handlers typically
   * omit this and rely on the dispatch-row stop endpoint instead — but
   * that's a choice, not an exclusion.
   */
  onComplete?: (job: AgentJob) => void;
  /** Dispatch metadata persisted on the new row. */
  apiDispatchMeta: DispatchTriggerMetadata;
  /** Claude session UUID to resume. Undefined for fresh launches. */
  resumeSessionId?: string;
  /** Parent dispatch ID. Present when this slot is a resume child. */
  parentJobId?: string;
}

export interface DispatchResult {
  dispatchId: string;
  job: AgentJob;
}

/**
 * Write the per-dispatch MCP settings file to a fresh temp directory and
 * return its absolute path. Called by `dispatch()` after the resolver has
 * produced `{mcpServers, allowedTools}`. Caller is responsible for the
 * temp-dir cleanup (wired through `onComplete` below).
 */
function writeMcpSettingsFile(
  mcpServers: Record<string, unknown>,
): { settingsDir: string; settingsPath: string } {
  const settingsDir = mkdtempSync(join(tmpdir(), "danxbot-mcp-"));
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ mcpServers }, null, 2));
  return { settingsDir, settingsPath };
}

function cleanupMcpSettings(settingsDir: string): void {
  try {
    rmSync(settingsDir, { recursive: true, force: true });
  } catch (err) {
    log.error(
      `Failed to clean up MCP settings dir ${settingsDir}:`,
      err,
    );
  }
}

/**
 * Resolved tool surface — the shape the spawn loop reads. Produced inside
 * `dispatch()` from `resolveWorkspace` + the danxbot infrastructure server.
 */
interface ResolvedSurface {
  /** MCP server configs to write into the per-dispatch settings.json. */
  readonly mcpServers: Record<string, unknown>;
  /** Allowlist passed to claude's `--allowed-tools`. */
  readonly allowedTools: readonly string[];
  /**
   * Optional cwd override for the spawned agent. When set, replaces the
   * launcher's default `workspacePath(repoName)`. Used by the workspace
   * path so claude lands in `<repo>/.danxbot/workspaces/<name>/`.
   */
  readonly cwd?: string;
  /**
   * Env vars produced by the resolver (e.g. workspace `.claude/settings.json`
   * env block). Merged after the dispatch invariants and before `input.env`.
   */
  readonly envOverrides?: Record<string, string>;
}

/**
 * Internal — the spawn loop. Owns: per-dispatch settings file write,
 * agent spawn, stall recovery, completion callback chaining, activeJobs
 * registration, TTL eviction. The `dispatch()` entry-point produces a
 * `ResolvedSurface` and funnels through this.
 */
async function runResolved(
  input: Omit<DispatchInput, "workspace" | "overlay">,
  dispatchId: string,
  resolved: ResolvedSurface,
): Promise<DispatchResult> {
  const taskWithInstruction = input.task + buildCompletionInstruction();
  let resumeCount = 0;

  async function spawnForDispatch(
    prompt: string,
    isRespawn: boolean,
  ): Promise<AgentJob> {
    const jobId = isRespawn ? randomUUID() : dispatchId;
    const { settingsDir, settingsPath } = writeMcpSettingsFile(
      resolved.mcpServers,
    );

    let job: AgentJob;
    try {
      // eventForwarding needs BOTH statusUrl and apiToken — skip the callback
      // entirely when apiToken is absent (poller-style dispatches) even if
      // statusUrl happens to be set, since Laravel PUTs require bearer auth.
      // See `DispatchInput.apiToken` docstring for the required-when rules.
      const eventForwarding =
        input.statusUrl && input.apiToken
          ? { statusUrl: input.statusUrl, apiToken: input.apiToken }
          : undefined;
      // Dispatch-level env invariants. Every dispatched agent ALWAYS gets
      // `DANXBOT_REPO_NAME` set from `input.repo.name`; the caller never
      // has to remember. Resolver-supplied `envOverrides` (e.g. workspace
      // `DANXBOT_WORKER_PORT`) merge next, then `input.env` wins last so
      // tests can override anything for isolation. See the
      // `DispatchInput.env` docstring for the contract.
      const env: Record<string, string> = {
        DANXBOT_REPO_NAME: input.repo.name,
        ...resolved.envOverrides,
        ...input.env,
      };
      job = await spawnAgent({
        jobId,
        prompt,
        title: input.title,
        repoName: input.repo.name,
        cwd: resolved.cwd,
        timeoutMs: input.timeoutMs ?? config.dispatch.agentTimeoutMs,
        env,
        mcpConfigPath: settingsPath,
        allowedTools: resolved.allowedTools,
        statusUrl: input.statusUrl,
        apiToken: input.apiToken,
        maxRuntimeMs: input.maxRuntimeMs,
        eventForwarding,
        openTerminal: input.openTerminal ?? config.isHost,
        // Only the initial spawn records the dispatch row — stall-recovery
        // respawns reuse the same dispatchId in `activeJobs` and must NOT
        // create a second row for the same conceptual run.
        dispatch: isRespawn ? undefined : input.apiDispatchMeta,
        resumeSessionId: input.resumeSessionId,
        parentJobId: input.parentJobId,
        onComplete: (completedJob) => {
          // See `DispatchInput.onComplete` — cleanup runs before the
          // caller callback (the ordering guarantee is load-bearing).
          cleanupMcpSettings(settingsDir);
          input.onComplete?.(completedJob);
        },
      });
    } catch (spawnErr) {
      cleanupMcpSettings(settingsDir);
      throw spawnErr;
    }

    // Index under the stable dispatchId so callers can still poll.
    activeJobs.set(dispatchId, job);
    return job;
  }

  function setupStallDetection(job: AgentJob): void {
    if (
      !config.isHost ||
      !input.statusUrl ||
      !job.watcher ||
      !job.terminalLogPath
    )
      return;

    const termWatcher = new TerminalOutputWatcher(job.terminalLogPath);
    const stallDetector = new StallDetector({
      watcher: job.watcher,
      terminalWatcher: termWatcher,
      maxNudges: 1, // Each detector fires once; resumeCount tracks the total.
      onStall: async () => {
        resumeCount++;
        const currentJob = activeJobs.get(dispatchId);
        if (!currentJob || currentJob.status !== "running") return;

        termWatcher.stop();
        stallDetector.stop();

        if (resumeCount >= MAX_STALL_RESUMES) {
          log.warn(
            `[Dispatch ${dispatchId}] Max stall resumes (${MAX_STALL_RESUMES}) reached — marking job failed`,
          );
          await currentJob.stop(
            "failed",
            "Agent stalled repeatedly and did not recover",
          );
          return;
        }

        log.warn(
          `[Dispatch ${dispatchId}] Stall detected (resume ${resumeCount}/${MAX_STALL_RESUMES}) — killing and resuming`,
        );

        updateDispatch(dispatchId, { nudgeCount: resumeCount }).catch((err) =>
          log.error(
            `[Dispatch ${dispatchId}] Failed to record nudge count`,
            err,
          ),
        );

        await terminateWithGrace(currentJob, 5_000);

        // Use the original task (not taskWithInstruction) as the base so the
        // completion instruction appears exactly once, followed by the stall note.
        const nudgePrompt =
          input.task +
          buildCompletionInstruction() +
          `\n\n---\nNOTE: Your previous session appeared to stall after receiving ` +
          `a tool result (resume ${resumeCount}/${MAX_STALL_RESUMES}). ` +
          `Continue your work from where it was left off.`;

        try {
          const newJob = await spawnForDispatch(nudgePrompt, true);
          setupStallDetection(newJob);
        } catch (err) {
          log.error(
            `[Dispatch ${dispatchId}] Failed to respawn after stall:`,
            err,
          );
        }
      },
    });

    termWatcher.start();
    stallDetector.start();

    const originalCleanup = job._cleanup;
    job._cleanup = async () => {
      termWatcher.stop();
      stallDetector.stop();
      await originalCleanup?.();
    };
  }

  const job = await spawnForDispatch(taskWithInstruction, false);
  setupStallDetection(job);

  // TTL eviction — keep finished jobs in `activeJobs` for an hour after
  // completion so late `/api/status` polls still succeed, then drop them.
  const cleanupInterval = setInterval(() => {
    const currentJob = activeJobs.get(dispatchId);
    if (
      currentJob &&
      currentJob.status !== "running" &&
      Date.now() - (currentJob.completedAt?.getTime() ?? 0) >
        COMPLETED_JOB_TTL_MS
    ) {
      activeJobs.delete(dispatchId);
      clearInterval(cleanupInterval);
      jobCleanupIntervals.delete(cleanupInterval);
    }
  }, CLEANUP_POLL_INTERVAL_MS);
  jobCleanupIntervals.add(cleanupInterval);

  return { dispatchId, job };
}

/**
 * The one entry point every dispatch path calls. Resolves the named
 * workspace under `<repo>/.danxbot/workspaces/<input.workspace>/`,
 * substitutes overlay placeholders into its `.mcp.json` +
 * `.claude/settings.json`, merges the danxbot infrastructure MCP server,
 * and hands control to the spawn loop.
 *
 * Owns the full per-dispatch lifecycle: workspace resolution, settings-file
 * write, agent spawn, stall recovery, completion callback chaining,
 * activeJobs registration, TTL eviction.
 *
 * The danxbot infrastructure MCP server (with `danxbot_complete` and the
 * Slack tools when applicable) is merged HERE, not declared in the
 * workspace's `.mcp.json`. Its `command` is an absolute filesystem path
 * that depends on where danxbot is installed (`DANXBOT_MCP_SERVER_PATH`),
 * which can't be encoded statically in committed source — the registry's
 * `build()` produces it dynamically.
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const dispatchId = randomUUID();
  const workerStopUrl = `http://localhost:${input.repo.workerPort}/api/stop/${dispatchId}`;

  // Inject infrastructure placeholders the resolver expects but the caller
  // can't pre-compute (every URL below is dispatchId-derived, and
  // `dispatchId` is generated inside this function). Caller overlay wins
  // over auto-injected values — tests rely on that, see
  // `DispatchInput.overlay`. Non-Slack workspaces simply don't declare
  // the DANXBOT_SLACK_* placeholders and the extra keys are ignored by
  // the resolver; the slack-worker workspace declares both as
  // `required-placeholders` so these auto-injected values satisfy its
  // overlay contract without forcing the caller to compute per-dispatch
  // URLs.
  const overlay: Record<string, string> = {
    DANXBOT_STOP_URL: workerStopUrl,
    DANXBOT_SLACK_REPLY_URL: `http://localhost:${input.repo.workerPort}/api/slack/reply/${dispatchId}`,
    DANXBOT_SLACK_UPDATE_URL: `http://localhost:${input.repo.workerPort}/api/slack/update/${dispatchId}`,
    ...input.overlay,
  };

  const workspace = resolveWorkspace({
    repo: input.repo,
    workspaceName: input.workspace,
    overlay,
  });

  // Merge the danxbot infrastructure server. The workspace's `.mcp.json`
  // intentionally does NOT declare it — see function header for the full
  // rationale. We read back the resolver's substituted file, merge, then
  // immediately free the resolver's temp dir (we'll write our own per-
  // dispatch settings via writeMcpSettingsFile inside runResolved).
  const workspaceMcp = JSON.parse(
    readFileSync(workspace.mcpSettingsPath, "utf-8"),
  ) as { mcpServers: Record<string, unknown> };
  cleanupWorkspaceMcpSettings(workspace.mcpSettingsPath);

  // Slack workspace integration: a workspace that declares both slack URL
  // placeholders (slack-worker) uses overlay substitution to deliver per-
  // dispatch reply/update endpoints. We thread those into the danxbot
  // server factory's `opts.slack` so the server advertises
  // `danxbot_slack_*` and receives the URLs via env. The check is on
  // both keys together — a half-declared slack surface is a
  // misconfiguration, not a partial feature, and would surface as a
  // Slack call hitting an undefined URL at runtime. `DANXBOT_ENTRY.build`
  // (`src/agent/mcp-registry.ts`) is the single place that turns opts.slack
  // into the `DANXBOT_SLACK_*_URL` env block; this caller never writes
  // those env vars directly.
  const slackReplyUrl = overlay.DANXBOT_SLACK_REPLY_URL;
  const slackUpdateUrl = overlay.DANXBOT_SLACK_UPDATE_URL;
  const slack =
    slackReplyUrl && slackUpdateUrl
      ? { replyUrl: slackReplyUrl, updateUrl: slackUpdateUrl }
      : undefined;

  const danxbotServer = defaultMcpRegistry[DANXBOT_SERVER_NAME].build({
    allowTools: [],
    danxbotStopUrl: workerStopUrl,
    slack,
  });
  const mcpServers: Record<string, unknown> = {
    ...workspaceMcp.mcpServers,
    [DANXBOT_SERVER_NAME]: danxbotServer,
  };

  // Always-present infrastructure tool, appended after the workspace's
  // declared tools.
  const allowedTools: readonly string[] = [
    ...workspace.allowedTools,
    `mcp__${DANXBOT_SERVER_NAME}__${DANXBOT_COMPLETE_TOOL}`,
  ];

  return runResolved(input, dispatchId, {
    mcpServers,
    allowedTools,
    cwd: workspace.cwd,
    envOverrides: workspace.env,
  });
}
