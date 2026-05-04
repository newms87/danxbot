/**
 * Agent type contracts — `AgentJob`, `AgentUsage`, `SpawnAgentOptions`, and
 * the runtime-agnostic `terminateWithGrace` helper.
 *
 * Lives in its own module so that `launcher.ts` (orchestration) and the
 * runtime-fork modules (`spawn-host-mode.ts`, `spawn-docker-mode.ts`) can
 * all share the contract without circular imports. The launcher re-exports
 * everything here for backwards-compatible callers (`import { AgentJob }
 * from "../agent/launcher.js"` still works).
 */

import type { AgentHandle } from "./agent-handle.js";
import type { SessionLogWatcher } from "./session-log-watcher.js";
import type { DispatchTracker } from "../dashboard/dispatch-tracker.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AgentJob {
  id: string;
  status: "running" | "completed" | "failed" | "timeout" | "canceled";
  summary: string;
  startedAt: Date;
  completedAt?: Date;
  statusUrl?: string;
  /**
   * Running totals accumulated from every assistant entry's `message.usage`
   * in the single dispatch JSONL. Claude Code emits per-turn usage on each
   * assistant entry; total = sum across entries. One JSONL per dispatch
   * (see `.claude/rules/agent-dispatch.md`) means no double-counting.
   */
  usage: AgentUsage;
  /**
   * Runtime handle for the spawned claude process. Set during the runtime
   * fork inside `spawnAgent`. Docker mode wraps a ChildProcess; host mode
   * wraps a tracked PID + its liveness-poll watcher. Every lifecycle site
   * (kill, isAlive, onExit, dispose) goes through this single interface;
   * the runtime branch is decided once at fork time, not at every callsite.
   * See `src/agent/agent-handle.ts` for the contract.
   */
  handle?: AgentHandle;
  heartbeatInterval?: ReturnType<typeof setInterval>;
  /** The SessionLogWatcher monitoring this job's JSONL session file. */
  watcher?: SessionLogWatcher;
  /**
   * Dispatch row tracker. Set when `options.dispatch` is passed to spawnAgent.
   * Undefined for runs that should not appear in the dispatch history.
   */
  dispatchTracker?: DispatchTracker;
  /**
   * Path where `script -q -f` writes terminal output when openTerminal is true.
   * Used by TerminalOutputWatcher + StallDetector for thinking indicator detection.
   */
  terminalLogPath?: string;
  /**
   * Internal cleanup callback — tears down watcher, forwarder, timers, and
   * awaits `dispatchTracker.finalize` so the dispatches DB row reflects the
   * full token + counter totals from the JSONL. Returns a promise so call
   * sites that issue terminal-state HTTP PUTs (cancelJob, job.stop) can
   * sequence the PUT after the final DB write. Fire-and-forget callers
   * (inactivity / max-runtime timers, defensive re-runs from
   * setupProcessHandlers) drop the promise — the launcher caches the
   * in-flight cleanup promise so concurrent callers observe the same chain.
   */
  _cleanup?: () => Promise<void>;
  /**
   * Promise tracking the in-flight `forwarderFlush?.()` started by
   * `runCleanup`. The launcher fires the final flush as fire-and-forget
   * (`void forwarderFlush?.()`) to keep production cleanup latency
   * short — Laravel POST retries can take up to ~60s under
   * exponential-backoff but the dispatch row + putStatus PUT must NOT
   * block on them. Tests need an awaitable handle on that work so
   * subsequent `rmSync(<config.logsDir>)` cannot race a pending
   * `appendFile` against `<config.logsDir>/event-queue/<jobId>.jsonl`
   * (Trello 69f77e9b77472aefac1317b2 — teardown leak in
   * `yaml-lifecycle-memory-tracker.test.ts`).
   *
   * Always set when the dispatch was created with `eventForwarding`;
   * `undefined` otherwise (poller-style dispatches that omit
   * apiToken/statusUrl). The promise resolves when `drainAndSend`
   * returns — drainAndSend's inner try/catch swallows ENOENT and
   * network errors, so awaiting this never rejects.
   */
  _forwarderFlush?: Promise<void>;
  /**
   * Fires options.onComplete with the job when a terminal state is reached
   * outside of the close/exit handler flow (i.e. from cancelJob). Lets
   * dispatch-layer teardown such as cleanupMcpSettings run on cancel — the
   * close handler would otherwise early-return because status is pre-set.
   */
  _onComplete?: () => void;
  /**
   * Agent-initiated stop — signals that the agent completed or failed gracefully.
   * Sends SIGTERM, waits 5s, then SIGKILL if needed, then fires onComplete.
   * Use for lifecycle tool callbacks (dispatch agents). For user cancellations, use cancelJob().
   *
   * Always set by `spawnAgent()` before the job is returned to the caller — required,
   * not optional, so call sites don't have to silently no-op on a missing handler.
   */
  stop: (status: "completed" | "failed", summary?: string) => Promise<void>;
}

export interface SpawnAgentOptions {
  /** The prompt/command to pass to claude CLI */
  prompt: string;
  /** Short title shown in the agent's initial message alongside the prompt file reference.
   *  Typically includes tracking IDs (e.g. "AgentDispatch #AGD-359, SchemaDefinition #SD-176")
   *  so humans can identify the dispatch in session logs and thread UIs. */
  title?: string;
  /** Repo name — used to resolve cwd to repos/<name> */
  repoName: string;
  /**
   * Spawned agent's working directory — the resolved
   * `<repo>/.danxbot/workspaces/<name>/` workspace dir from
   * `resolveWorkspace`. Required: every dispatch goes through the
   * workspace resolver, no caller spawns without an explicit cwd. The
   * legacy singular `<repo>/.danxbot/workspace/` fallback was retired
   * with the workspace-dispatch epic (Trello `jAdeJgi5`).
   */
  cwd: string;
  /** Optional pre-generated job ID. If not set, a UUID is generated. Used to keep
   *  the activeJobs key stable across stall-recovery respawns. */
  jobId?: string;
  /** Inactivity timeout in milliseconds */
  timeoutMs: number;
  /** Additional env vars to merge into the spawned process environment */
  env?: Record<string, string>;
  /** Called when the agent finishes (success, failure, or timeout) */
  onComplete?: (job: AgentJob) => void;
  /** Path to MCP settings JSON. When set, adds --mcp-config to CLI args. */
  mcpConfigPath?: string;
  /**
   * Agent definitions forwarded to Claude CLI's `--agents <json>` flag.
   * Must be an object keyed by agent name (the shape Claude CLI requires) —
   * a list silently falls back to built-in agents and makes
   * `Agent(subagent_type: "<name>")` fail with "Agent type not found".
   * See `.claude/rules/agent-dispatch.md`.
   */
  agents?: Record<string, Record<string, unknown>>;
  /** Status URL for heartbeat/putStatus (stored on AgentJob for startHeartbeat) */
  statusUrl?: string;
  /** API token for heartbeat and event forwarding */
  apiToken?: string;
  /** When set, starts batched event forwarding to the Laravel API */
  eventForwarding?: {
    statusUrl: string;
    apiToken: string;
  };
  /** Hard runtime cap in milliseconds (does NOT reset on activity) */
  maxRuntimeMs?: number;
  /** If true, also opens an interactive Windows Terminal tab for the agent */
  openTerminal?: boolean;
  /**
   * When set, a `dispatches` row is created for this spawn and finalized when
   * the agent reaches a terminal state. Omit for runs that should not appear
   * in the dispatch history (e.g., Slack router-only responses).
   */
  dispatch?: DispatchTriggerMetadata;
  /**
   * Claude session UUID to resume via `claude --resume`. Passed through to
   * `buildClaudeInvocation`. When set, claude loads the prior session's
   * history; a fresh dispatch tag is still prepended so SessionLogWatcher can
   * disambiguate this spawn's slice inside the shared JSONL.
   */
  resumeSessionId?: string;
  /**
   * Parent dispatch ID when this spawn is a resume child. Forwarded to the
   * dispatches row so the resume chain is queryable. Requires `dispatch` to
   * also be set — a non-tracked run with a parent would silently drop the
   * lineage, so spawnAgent throws when parentJobId is set without dispatch.
   */
  parentJobId?: string | null;
}

/**
 * Send SIGTERM, wait `graceMs`, then SIGKILL if the process is still alive.
 * The two-phase pattern gives the agent a chance to flush state (final
 * assistant message, usage totals) before forceful termination. Works
 * identically in docker and host mode via `job.handle` — the runtime
 * branch was decided once at spawn time. No-op when no handle is attached
 * (e.g. after cleanup).
 *
 * Exported so callers outside the launcher (dispatch stall recovery, future
 * lifecycle tools) can drive termination without duplicating the runtime
 * fork — see `.claude/rules/agent-dispatch.md`, "Single Fork Principle".
 */
export async function terminateWithGrace(
  job: AgentJob,
  graceMs: number,
): Promise<void> {
  if (!job.handle) return;
  job.handle.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (job.handle.isAlive()) {
    job.handle.kill("SIGKILL");
  }
}
