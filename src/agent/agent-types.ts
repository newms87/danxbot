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
import type { YamlPairedWrite } from "./paired-host-pid-write.js";
import type { PrepVerdictPayload } from "../mcp/danxbot-prep-verdict.js";

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * DX-296 — discriminator the multi-agent picker stamps on every
 * dispatch it spawns for an issue card. Threaded through
 * `DispatchInput` → `SpawnAgentOptions` → `AgentJob`; read by the
 * prep-verdict route to decide whether `verdict: "ok"` should
 * terminate the dispatch or let it continue into `/danx-next`.
 *
 * Values:
 *   - `"prep"` — separate-mode prep-only dispatch. Route stops on
 *     `ok`; next tick self-claims and dispatches the work pass.
 *   - `"work"` — combined dispatch (combined mode, OR separate-mode
 *     self-claim work pass). Route lets the dispatch run past `ok`
 *     so the agent proceeds into `/danx-next`.
 *   - `"triage"` — per-card triage dispatch (DX-515). Spawned by the
 *     poller's empty-ToDo branch OR `POST /api/triage`. Runs the
 *     `danx-triage-card` skill; the agent never calls the prep-verdict
 *     tool. Distinct from `"work"` so `dispatch/core.ts` does NOT
 *     auto-flip the candidate YAML from ToDo → In Progress (triage
 *     decides Review→ToDo / Demote / Confirm-Block via Edit, not via
 *     auto-flip).
 *
 * Undefined for every non-multi-agent-pick / non-triage caller (Slack,
 * ideator, external `/api/launch`, tests bypassing the picker). The
 * route's `ok` branch defensively keeps the dispatch running on
 * undefined so a misconfigured non-prep dispatch can't accidentally
 * finalize.
 */
export type DispatchKind = "prep" | "work" | "triage";

export interface AgentJob {
  id: string;
  /**
   * In-memory job state. `recovered` (DX-260 / Phase 2 of DX-246) marks
   * the dispatch as terminated by the API-error recover handler — the
   * launcher will POST `/api/resume` to continue the chain on a fresh
   * dispatch row whose `parent_recover_id` points at this one. Distinct
   * from `failed` so `buildCleanup` can finalize the dispatches row with
   * status `"recovered"` (DispatchStatus) instead of `"failed"`.
   *
   * `throttled` (DX-322) marks the dispatch as killed by the rate-limit
   * throttle handler — the worker wrote a throttle flag with
   * `resume_at` and the poller auto-resumes past the deadline.
   * Distinct from `recovered` (no /api/resume POST) and from `failed`
   * (no operator clearing required).
   */
  status: "running" | "completed" | "failed" | "timeout" | "canceled" | "recovered" | "throttled";
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
   * DX-260 (Phase 2 of DX-246) — number of times the dispatch chain
   * containing THIS spawn has auto-recovered from a Claude API stream-
   * idle synthetic error. Seeded from `SpawnAgentOptions.initialRecoverCount`
   * (which the launcher / poller pulls off the dispatches row at spawn
   * time, or `0` for a fresh dispatch). The `ApiErrorDetector` recover
   * handler bumps this counter and the `MAX_RECOVERS = 3` cap reads it
   * to decide failed-vs-recovered branching. Persisted to the
   * `dispatches.recover_count` column via `DispatchTracker.recordRecoverCount`.
   */
  recoverCount: number;
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
  /**
   * Phase 4b.2 (DX-289) — per-dispatch TTL window in milliseconds. Set
   * by `dispatch()` when the dispatch is bound to an issue card; the
   * heartbeat loop reads this on every tick and calls `rearmTtlTimer`
   * so a healthy long-running dispatch never trips the dead-PID check.
   * Undefined for non-poller dispatches (Slack, external /api/launch
   * without an issue id) where there is no YAML `dispatch{}` block to
   * clear on expiry.
   */
  ttlMs?: number;
  /**
   * Phase 4b.2 (DX-289) — stable dispatch id used to key the per-
   * dispatch TTL timer. Same as `id` on the initial spawn, but
   * preserved across stall-recovery respawns (where `id` cycles to a
   * fresh UUID while the dispatch row + TTL timer stay keyed on the
   * original). The launcher / dispatch core stamps this after the
   * job is constructed.
   */
  dispatchId?: string;
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
   * `yaml-lifecycle-fake-tracker.test.ts`).
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
   *
   * Accepted `status` values mirror `CompleteStatus` from
   * `src/mcp/danxbot-server.ts`. The launcher-internal `api_error_recover`
   * / `api_error_failed` values (DX-260) are emitted by the API-error
   * recover handler in `attach-monitoring-stack.ts` — agents never call
   * these directly because the MCP tool schema only advertises
   * `AGENT_COMPLETE_STATUSES`.
   */
  stop: (
    status: import("../mcp/danxbot-server.js").CompleteStatus,
    summary?: string,
  ) => Promise<void>;
  /**
   * Restage context preserved at /api/launch + /api/resume time so a
   * later POST /api/restage/:dispatchId can re-run the same
   * `prepareStagedFiles + writeStagedFiles` chain that produced the
   * original staged files.
   *
   * Stamped by `dispatch()` after the workspace + overlay are resolved.
   * Undefined for dispatches whose workspace omits `staging-paths`
   * (no allowlist → no restage surface).
   *
   * @see ../worker/restage-route.ts Caller (HTTP endpoint)
   */
  restageContext?: {
    /** Already-substituted allowlist roots from the workspace manifest. */
    readonly stagingPaths: readonly string[];
    /**
     * Same overlay used at launch — restage payloads with `${KEY}`
     * placeholders are substituted via this map before validation +
     * write so the per-dispatch `${SCHEMA_DEFINITION_ID}` etc. stay
     * consistent with the original staging.
     */
    readonly overlay: Readonly<Record<string, string>>;
  };
  /**
   * DX-326 — per-dispatch systemd scope unit name (no `.scope` suffix),
   * stamped at spawn time when running on host runtime. Undefined on
   * docker runtime (the container boundary is already the cgroup; no
   * scope wrap, no scope unit).
   *
   * Read by `stopAgentTree` (`src/agent/job-stop.ts`) to target the
   * cgroup atomically via `systemctl --user stop` so backgrounded
   * grandchildren (`yes &`, double-forks, daemons the Bash tool spawns)
   * die with the parent instead of reparenting to PID 1 — the prod
   * incident class DX-262 motivated. Set in `spawn-preflight.ts`
   * alongside the `DANXBOT_DISPATCH_SCOPE` env var the dispatched
   * agent reads.
   */
  scopeName?: string;
  /**
   * DX-294 — verdict the prep agent signaled via `danxbot_prep_verdict`.
   * Stamped by `handlePrepVerdict` so the wrapping multi-agent-pick
   * onComplete handler (Phase 5 of DX-291) can read the verdict's
   * outcome WITHOUT re-parsing the YAML / settings side-effects the
   * route already applied. Undefined for any dispatch that never
   * called the tool (every non-prep dispatch — the tool itself is
   * advertise-filtered off when the URL is absent, and even prep
   * dispatches set this only at apply time).
   */
  prepVerdict?: PrepVerdictPayload;
  /**
   * DX-296 — discriminator the picker stamps to tell the prep-verdict
   * route what KIND of dispatch this is, independent of `prepMode`.
   * See the `DispatchKind` type alias for the value semantics.
   * Undefined on every non-multi-agent-pick dispatch (Slack, ideator,
   * external `/api/launch`); those callers never invoke `/danx-prep`,
   * so the verdict route is never called and the field stays unset.
   */
  dispatchKind?: DispatchKind;
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
   * DX-365 — repo `localPath` (`<repo>/.danxbot` parent). Forwarded to
   * `startDispatchTracking` so the strike accumulator can `mutateAgents`
   * the repo's `settings.json` from inside `DispatchTracker.finalize`.
   * Optional for back-compat with tests + ad-hoc spawns that don't bind
   * to a real repo on disk; when unset, strike recording is skipped.
   */
  repoLocalPath?: string;
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
   * Absolute path to a Claude Code settings JSON. When set, adds
   * `--settings <path>` to CLI args. Used to load workspace-level
   * `.claude/settings.json` (e.g. SessionStart / SubagentStart hook
   * registrations) without relying on Claude Code's project-trust dialog —
   * dispatched workers run untrusted workspace dirs, so the project-scope
   * settings file is otherwise ignored.
   */
  settingsPath?: string;
  /**
   * Agent definitions forwarded to Claude CLI's `--agents <json>` flag.
   * Must be an object keyed by agent name (the shape Claude CLI requires) —
   * a list silently falls back to built-in agents and makes
   * `Agent(subagent_type: "<name>")` fail with "Agent type not found".
   * See `.claude/rules/agent-dispatch.md`.
   */
  agents?: Record<string, Record<string, unknown>>;
  /**
   * Top-level agent name forwarded as `--agent <name>` to claude. When set,
   * claude makes the top-level session BECOME the named agent — its
   * `<cwd>/.claude/agents/<name>.md` frontmatter (notably the `tools:`
   * allowlist) applies, so MCP tools are eager-loaded instead of deferred
   * behind ToolSearch. Resolved by `resolveWorkspace` from the manifest's
   * `top_level_agent` field; threaded into spawnAgent by `dispatch()`.
   */
  topLevelAgent?: string;
  /**
   * Optional Claude model override forwarded as `--model <name>` to the
   * spawned claude CLI. Use for dispatches that want to pin to a
   * specific model regardless of the host's default. When omitted,
   * claude uses its own default model resolution (env / settings /
   * built-in default).
   */
  model?: string;
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
  /**
   * Local issue id (`<PREFIX>-N`) the dispatch is bound to, when relevant.
   * Forwarded to `startDispatchTracking` so the dispatches row carries
   * `issue_id` for the Agent Chat tab's per-card listing (DX-84).
   * Card-less dispatches (Slack, ideator, board-chat, external launch)
   * omit this; the column is stamped NULL. Requires `dispatch` to also be
   * set since the issue id only matters to the dispatch row.
   */
  issueId?: string | null;
  /**
   * YAML write/clear pair invoked by `pairedWriteHostPid` after the runtime
   * fork resolves the agent PID. Set only by the poller path (it owns the
   * per-issue YAML); Slack and `/api/launch` omit this and only get the
   * DB-side stamp. See `paired-host-pid-write.ts` and DX-140 for the
   * paired-write contract.
   */
  pairedWriteYaml?: YamlPairedWrite;
  /**
   * Resolved persona name (`AGENT_NAME_SHAPE`) when the multi-worker pick
   * algorithm chose this agent for the dispatch (DX-200). Forwarded to
   * `startDispatchTracking` so the row's `agent_name` column carries the
   * value the poller's `busyAgents()` lookup queries on the next tick.
   * Omitted by every non-agent caller (Slack, ideator, external launch).
   */
  agentName?: string | null;
  /**
   * Absolute path to the per-dispatch MCP settings JSON written by
   * `dispatch()` (`src/dispatch/core.ts#writeMcpSettingsFile`). Forwarded
   * to `startDispatchTracking` so the row's `mcp_settings_path` column
   * captures the location for Phase 2c's reattach pass (DX-209) — the
   * reader rewrites `DANXBOT_STOP_URL` in this file when the worker
   * restarts on a different port. Omitted by callers that do not write a
   * per-dispatch settings file (none today, but the field is optional
   * for symmetry with other dispatch-row stamps).
   */
  mcpSettingsPath?: string | null;
  /**
   * DX-44 — per-spawn MCP settings dir (the parent of `mcpSettingsPath`).
   * When set, `_cleanup`'s finally block removes it on every termination
   * path. Set by `dispatch()` for every spawn so the cleanup is universal
   * (inactivity timeout, max-runtime timeout, host-mode exit, docker
   * close, jobStop, cancelJob). Pre-DX-44 cleanup lived in the dispatch-
   * layer `onComplete` closure and leaked on every path that ran
   * `_cleanup` but NOT `onComplete`.
   */
  mcpSettingsDir?: string;
  /**
   * DX-44 — per-dispatch staged file paths (absolute) written by
   * `writeStagedFiles` before spawn. `_cleanup`'s finally block removes
   * each file individually (the parent dir is the workspace's staging
   * root and is shared across dispatches). Empty / omitted when the
   * caller supplied no `staged_files`.
   */
  stagedFilePaths?: readonly string[];
  /**
   * DX-44 — per-dispatch substituted-settings file (absolute path to
   * `settings.json` inside a `mkdtemp` dir under `os.tmpdir()`).
   * `_cleanup`'s finally block removes the parent dir. Omitted when the
   * workspace had no substituted settings file.
   */
  workspaceSettingsPath?: string;
  /**
   * DX-260 (Phase 2 of DX-246) — inherited recover count for this
   * spawn's chain. Seeds `AgentJob.recoverCount` AND the new dispatch
   * row's `recover_count` column. Fresh launches get `0`; recover-
   * spawned resumes (via `POST /api/resume` with `recover_count` set)
   * inherit the parent's count so the `MAX_RECOVERS = 3` cap sees the
   * whole chain.
   */
  initialRecoverCount?: number;
  /**
   * DX-260 — parent dispatch ID when THIS dispatch is the
   * recover-child of an earlier dispatch. Stamped on the new
   * `dispatches.parent_recover_id` column so the dashboard can walk
   * the chain. Set only by the API-error recover handler's POST to
   * `/api/resume`; every other caller leaves it `null`.
   */
  parentRecoverId?: string | null;
  /**
   * DX-296 — see `AgentJob.dispatchKind` for the contract. Plumbed
   * through `dispatch()` → `spawnAgent` so the launcher can stamp the
   * field on the constructed `AgentJob` BEFORE the agent's first turn
   * (eliminates the race where `danxbot_prep_verdict` fires before
   * the picker has had a chance to stamp post-spawn).
   */
  dispatchKind?: DispatchKind;
  /**
   * DX-260 — context the API-error recover handler needs to drive the
   * recover flow. Set by `dispatch()` for every spawn; absent for ad-
   * hoc spawns that should NOT auto-recover (tests, future scenarios
   * that opt out). When unset, `attachMonitoringStack` still wires the
   * `ApiErrorDetector`, but the handler fails-loud (kills the job
   * without POSTing `/api/resume`) so the misconfiguration surfaces
   * instead of being silently swallowed.
   */
  recoverContext?: {
    /**
     * Original task body (BEFORE `buildCompletionInstruction` is
     * appended in `runResolved`). Posted to `/api/resume` as the new
     * user turn — claude `--resume` restores the prior session's
     * conversation, so the task is effectively re-attached for the
     * safety-net path the description references.
     */
    originalTask: string;
    /**
     * Workspace name the dispatch ran under. Resume needs to re-
     * resolve the workspace to rebuild the MCP surface; reusing the
     * same workspace name guarantees the recover child inherits the
     * original tool set.
     */
    workspace: string;
    /** Worker port for the `POST /api/resume` URL. */
    workerPort: number;
    /**
     * Repo localPath — passed to `writeFlag` on the cap-exhausted
     * path so the `CRITICAL_FAILURE` flag lands in the right
     * `<repo>/.danxbot/` directory (the worker is per-repo, but
     * `attachMonitoringStack` only has the repo name in
     * `options.repoName`; the path lives on the dispatch's
     * `RepoContext`).
     */
    repoLocalPath: string;
  };
}

/**
 * Send SIGTERM, wait `graceMs`, then SIGKILL if the process is still
 * alive. Used by stall recovery (`dispatch/core.ts`) to tear down the
 * pre-respawn job — the call site is exempted from the DX-326 systemctl
 * route per the "Don't touch SessionLogWatcher/StallDetector code paths"
 * anti-goal. Every OTHER terminal stop (cancelJob, agent self-stop) goes
 * through `stopAgentTree` (`src/agent/job-stop.ts`), which delegates HERE
 * for its docker branch — so this function is the single shared
 * SIGTERM/grace/SIGKILL primitive. No-op when no handle is attached.
 *
 * The `onExit` short-circuit skips SIGKILL when the kernel reaps the
 * process during the grace window — `isAlive()` lags `close` by a tick
 * in mock harnesses + some runtime shapes, so the explicit exit signal
 * is the load-bearing check.
 */
export async function terminateWithGrace(
  job: AgentJob,
  graceMs: number,
): Promise<void> {
  if (!job.handle) return;
  let processExited = false;
  job.handle.onExit(() => {
    processExited = true;
  });
  job.handle.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (!processExited && job.handle.isAlive()) {
    job.handle.kill("SIGKILL");
  }
}
