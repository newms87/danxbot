/**
 * Unified dispatch core — the one `dispatch()` function every dispatch
 * entry-point calls. Owns MCP resolution, the per-dispatch settings.json
 * file, the single spawnAgent call, dispatch row creation, stall recovery,
 * activeJobs registration, and TTL-based eviction.
 *
 * Today's callers:
 *   - `handleLaunch` / `handleResume` in `src/worker/dispatch.ts`
 *
 * Later callers (planned in the XCptaJ34 card):
 *   - Poller `spawnClaude` (Phase 4) — migrates off direct `spawnAgent`
 *
 * Runs identically for launches and resumes — the only differences are
 * `input.resumeSessionId` (appended to the claude invocation via `spawnAgent`)
 * and `input.parentJobId` (persisted on the dispatch row).
 *
 * See `.claude/rules/agent-dispatch.md` for the full contract.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { resolveDispatchTools } from "../agent/resolve-dispatch-tools.js";
import {
  defaultMcpRegistry,
  DANXBOT_COMPLETE_TOOL,
  DANXBOT_SERVER_NAME,
} from "../agent/mcp-registry.js";
import type { ResolveDispatchToolsOptions } from "../agent/mcp-types.js";
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
 * Everything a dispatch needs. Caller-facing shape — HTTP handlers map their
 * body into this; the poller constructs one from a Trello trigger; the Slack
 * listener constructs one for every deep-agent reply. All three paths share
 * the same `allowTools` input via `resolveDispatchTools`.
 */
export interface DispatchInput {
  repo: RepoContext;
  task: string;
  /**
   * External API token for status/heartbeat PUTs and schema MCP calls.
   * Required when `statusUrl` is set (heartbeat) or when the allowlist
   * enables `mcp__schema__*` (schema MCP envs). Absent for the poller and
   * any dispatch with no schema or status callback.
   */
  apiToken?: string;
  /**
   * External API URL for the schema MCP server env. Required only when the
   * allowlist enables `mcp__schema__*`. Absent for the poller and any
   * dispatch that doesn't touch schema tools.
   */
  apiUrl?: string;
  /**
   * Explicit tool allowlist — REQUIRED. Built-ins bare (`Read`, `Bash`), MCP
   * tools as `mcp__<server>__<tool>` with optional `mcp__<server>__*` wildcards.
   * Empty array is valid and means "only `mcp__danxbot__danxbot_complete`."
   */
  allowTools: readonly string[];
  statusUrl?: string;
  schemaDefinitionId?: string;
  schemaRole?: string;
  title?: string;
  agents?: Record<string, Record<string, unknown>>;
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
 * Build the `ResolveDispatchToolsOptions` from a `DispatchInput`. Trello
 * credentials are NOT sourced here — the trello MCP server is declared by
 * the `trello-worker` workspace's `.mcp.json` and resolved through
 * `dispatchWithWorkspace`, not the legacy registry path.
 */
function buildResolveOptions(
  input: DispatchInput,
  danxbotStopUrl: string,
  dispatchId: string,
): ResolveDispatchToolsOptions {
  const opts: ResolveDispatchToolsOptions = {
    allowTools: input.allowTools,
    danxbotStopUrl,
  };
  if (input.schemaDefinitionId || input.schemaRole) {
    // Normalize missing fields to empty strings so the schema registry's
    // explicit "missing apiUrl / apiToken / definitionId" `McpResolveError`
    // fires at resolve time (a loud, specific failure) — not an ambiguous
    // undefined read downstream. The `??` here is NOT a fallback; it's a
    // channeling step that keeps the fail-loud invariant.
    opts.schema = {
      apiUrl: input.apiUrl ?? "",
      apiToken: input.apiToken ?? "",
      definitionId: input.schemaDefinitionId ?? "",
      role: input.schemaRole,
    };
  }
  // TRANSITIONAL (workspace-dispatch epic P4): this branch is only exercised
  // by LEGACY callers that still invoke `dispatch()` with
  // `apiDispatchMeta.trigger === "slack"` and no workspace. Production Slack
  // dispatches migrated to `dispatchWithWorkspace({workspace: "slack-worker",
  // overlay: {...slack URLs}})` in P4 — the workspace declares the two
  // placeholders, and `dispatchWithWorkspace` threads them into
  // `DANXBOT_ENTRY.build({slack})` directly. The allowed-tools.txt in the
  // slack-worker workspace lists `mcp__danxbot__danxbot_slack_*` explicitly
  // (no runtime injection needed). Do not add new callers of the legacy
  // trigger-based path; P7 removes it once no production caller remains.
  if (input.apiDispatchMeta.trigger === "slack") {
    opts.slack = {
      replyUrl: `http://localhost:${input.repo.workerPort}/api/slack/reply/${dispatchId}`,
      updateUrl: `http://localhost:${input.repo.workerPort}/api/slack/update/${dispatchId}`,
    };
  }
  return opts;
}

/**
 * Resolved tool surface — the resolver-agnostic shape the spawn loop reads.
 * Both legacy `resolveDispatchTools` (today's `dispatch()`) and the new
 * `resolveWorkspace` path (`dispatchWithWorkspace()`) produce one of these.
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
 * Internal — the resolver-agnostic spawn loop. Both `dispatch()` and
 * `dispatchWithWorkspace()` produce a `ResolvedSurface` and funnel through
 * this. P5 collapses both callers into one entry point on top of the same
 * helper. Owns: per-dispatch settings file write, agent spawn, stall
 * recovery, completion callback chaining, activeJobs registration, TTL
 * eviction.
 */
async function runResolved(
  input: Omit<DispatchInput, "allowTools">,
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
        agents: input.agents,
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
    job._cleanup = () => {
      termWatcher.stop();
      stallDetector.stop();
      originalCleanup?.();
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
 * The one function every dispatch path calls. Owns the full per-dispatch
 * lifecycle (settings-file write, MCP resolution, agent spawn, stall
 * recovery, completion callback, activeJobs registration, TTL eviction).
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const dispatchId = randomUUID();
  const workerStopUrl = `http://localhost:${input.repo.workerPort}/api/stop/${dispatchId}`;

  // Resolve ONCE; reused on every stall-recovery respawn so the tool surface
  // stays identical across the lifetime of the dispatch slot.
  const resolveOptions = buildResolveOptions(input, workerStopUrl, dispatchId);
  const resolved = resolveDispatchTools(resolveOptions);

  return runResolved(input, dispatchId, {
    mcpServers: resolved.mcpServers,
    allowedTools: resolved.allowedTools,
  });
}

/**
 * Caller shape for `dispatchWithWorkspace`. Same as `DispatchInput` minus
 * `allowTools` (the workspace declares its own allowed-tools.txt) plus
 * `workspace` (the named workspace under `<repo>/.danxbot/workspaces/`)
 * and `overlay` (placeholder substitution map).
 */
export interface WorkspaceDispatchInput
  extends Omit<DispatchInput, "allowTools"> {
  /** Workspace name — resolves to `<repo>/.danxbot/workspaces/<workspace>/`. */
  workspace: string;
  /**
   * Placeholder substitution map. Every `${KEY}` in the workspace's
   * `.mcp.json` and `.claude/settings.json` is replaced from this map.
   * `DANXBOT_STOP_URL` is auto-injected from the dispatchId so callers
   * don't have to pre-compute it; everything else (TRELLO_*, etc.) is
   * caller-supplied.
   */
  overlay: Readonly<Record<string, string>>;
}

/**
 * Workspace-shaped dispatch — the new path that reads MCP servers and
 * allowed-tools declaratively from `<repo>/.danxbot/workspaces/<name>/`
 * instead of the TS `MCP_REGISTRY` factories. Phase 3 of the workspace-
 * dispatch epic (Trello `jAdeJgi5` / `q5aFuINM`).
 *
 * TEMPORARY: this is an adjacent helper to `dispatch()` until P5 collapses
 * both into one entry point. The shared `runResolved()` already does the
 * heavy lifting; the only differences are:
 *
 *   1. `resolveWorkspace` (vs `resolveDispatchTools`) reads the static
 *      workspace fixture and substitutes overlay placeholders.
 *   2. The danxbot infrastructure MCP server (with the `danxbot_complete`
 *      tool) is injected here, NOT by the workspace's `.mcp.json`. The
 *      server's command is an absolute filesystem path that depends on
 *      where danxbot is installed (`DANXBOT_MCP_SERVER_PATH`), which
 *      can't be encoded as a static value in committed source. The
 *      registry's `build()` produces it dynamically — same approach as
 *      the legacy resolver.
 *
 * Don't add new dispatch entry points here. P5 makes the legacy path
 * the deprecated branch; this becomes the only shape.
 */
export async function dispatchWithWorkspace(
  input: WorkspaceDispatchInput,
): Promise<DispatchResult> {
  const dispatchId = randomUUID();
  const workerStopUrl = `http://localhost:${input.repo.workerPort}/api/stop/${dispatchId}`;

  // Inject infrastructure placeholders the resolver expects but the caller
  // can't pre-compute (every URL below is dispatchId-derived, and
  // `dispatchId` is generated inside this function). Caller overlay wins
  // over auto-injected values — tests rely on that, see
  // `WorkspaceDispatchInput.overlay`. Non-Slack workspaces simply don't
  // declare the DANXBOT_SLACK_* placeholders and the extra keys are
  // ignored by the resolver; the slack-worker workspace declares both as
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
  // intentionally does NOT declare it — see header comment for the full
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

  // Always-present infrastructure tool. Stable suffix position matches
  // the legacy resolver (`resolveDispatchTools`) so claude's `--allowed-
  // tools` argv ordering is consistent across the two dispatch paths.
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
