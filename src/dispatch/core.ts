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
 * `<repo>/.danxbot/workspaces/<name>/` declaring the MCP servers (in
 * `.mcp.json`) and the `.claude/settings.json` env block. The MCP set
 * (combined with `--strict-mcp-config`) IS the agent's tool surface;
 * built-ins are all available by default. Callers pass the workspace name
 * + an overlay (placeholder substitutions). Danxbot does NOT ship a
 * default workspace; callers without one (e.g. external HTTP callers)
 * MUST provide one in their target repo or be rejected upstream by the
 * API handler.
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
import type { YamlPairedWrite } from "../agent/paired-host-pid-write.js";
import { TerminalOutputWatcher } from "../agent/terminal-output-watcher.js";
import { StallDetector } from "../agent/stall-detector.js";
import {
  defaultMcpRegistry,
  DANXBOT_SERVER_NAME,
} from "../agent/mcp-registry.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";
import { updateDispatch } from "../dashboard/dispatches-db.js";
import {
  resolveWorkspace,
  cleanupWorkspaceMcpSettings,
  cleanupWorkspaceSettings,
} from "../workspace/resolve.js";
import {
  cleanupStagedFiles,
  prepareStagedFiles,
  writeStagedFiles,
  type StagedFileInput,
} from "./staged-files.js";
import { prependPersona, type PersonaContext } from "../agent/persona.js";
import { releaseLock } from "../issue-tracker/lock.js";
import type { IssueTracker } from "../issue-tracker/interface.js";

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
 * Phase 2c (DX-209) seam — register a job into the activeJobs map outside
 * of `dispatch()`'s spawn loop. Used exclusively by the worker boot reattach
 * pass (`src/worker/reattach.ts`): a non-terminal dispatch row whose host
 * PID is still alive needs the same `getActiveJob` / `cancelJob` /
 * `/api/status` parity as a freshly-spawned job, but the spawn loop is
 * NOT what produced it.
 *
 * Invariants enforced at registration time — fail-loud at register beats
 * discovering a half-built job at `/api/cancel` time when the operator's
 * cancel request silently no-ops:
 *   - `job.id === jobId` and matches the dispatch row's id.
 *   - `job.handle` is wired (via `createReattachHandle`) so cancel + stop
 *     reach the existing PID.
 *   - `job.stop` is wired by `attachMonitoringStack` BEFORE this call so
 *     `/api/stop` can finalize via the agent's own `danxbot_complete`.
 *
 * Caller invariant NOT enforced (would need a DB lookup): the row's
 * `status` is still `running`. Reattach upholds this by gating on
 * `findNonTerminalDispatches`; misuse from another callsite would race a
 * duplicate finalize against the original tracker.
 *
 * Idempotent: re-registering the same id silently overwrites the prior
 * entry (the reattach pass is single-pass per repo per boot, so the
 * collision is theoretical).
 */
export function registerActiveJob(jobId: string, job: AgentJob): void {
  if (job.id !== jobId) {
    throw new Error(
      `registerActiveJob: jobId mismatch — got jobId="${jobId}" but job.id="${job.id}"`,
    );
  }
  if (!job.handle) {
    throw new Error(
      `registerActiveJob[${jobId}]: job.handle missing — cancel/stop cannot reach the agent process`,
    );
  }
  if (typeof job.stop !== "function") {
    throw new Error(
      `registerActiveJob[${jobId}]: job.stop missing — /api/stop has no handler. attachMonitoringStack must run before registration.`,
    );
  }
  activeJobs.set(jobId, job);
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
 * Await every in-flight cleanup chain — `_cleanup()` (cached promise,
 * cheap when already resolved) plus the `_forwarderFlush` queue-write
 * promise the launcher exposes for fire-and-forget forwarder flushes.
 *
 * Test-only. Production cleanup latency stays unchanged because the
 * launcher's `runCleanup` still fires `forwarderFlush` as fire-and-
 * forget — this helper is the test-side handle on that work so
 * teardown can `rmSync(<config.logsDir>)` without racing pending
 * `appendFile` calls into `<config.logsDir>/event-queue/<jobId>.jsonl`.
 *
 * Trello 69f77e9b77472aefac1317b2 — teardown leak in
 * `yaml-lifecycle-memory-tracker.test.ts`. The previous unhandled-
 * rejection fix (commit fa15457) wrapped `drainAndSend` so ENOENT
 * never escapes; this helper closes the underlying race so the test
 * suite stops keeping vitest's event loop warm with pending writes
 * after each dispatch terminates.
 *
 * Both promises are awaited per-job; both are guaranteed not to
 * reject (drainAndSend swallows internally), so we don't wrap in
 * try/catch here — a future refactor that breaks that contract should
 * surface loudly in the test that consumes this helper.
 */
export async function _drainPendingCleanupsForTesting(): Promise<void> {
  const jobs = Array.from(activeJobs.values());
  await Promise.all(
    jobs.map(async (job) => {
      if (job._cleanup) await job._cleanup();
      if (job._forwarderFlush) await job._forwarderFlush;
    }),
  );
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
   * Two groups are auto-injected from `RepoContext` + `dispatchId` so
   * callers don't have to pre-compute them:
   *   - **Danxbot infra URLs** — `DANXBOT_STOP_URL`, `DANXBOT_WORKER_PORT`,
   *     the Slack URL pair, the issue-tool URL pair, and
   *     `DANXBOT_RESTART_WORKER_URL`. Derived from `repo.workerPort` +
   *     `dispatchId`.
   *   - **Per-repo MCP env block** — `DANX_REPO_ROOT`. Derived from
   *     `repo.localPath`. Consumed by the workspace-declared
   *     `danx-issue` MCP server (`@thehammer/danx-issue-mcp`). DX-203
   *     retired the `DANX_TRACKER` / `TRELLO_API_KEY` / `TRELLO_API_TOKEN`
   *     triple — the MCP server is purely a YAML manipulator and reads no
   *     tracker creds.
   * Everything else (`SCHEMA_*`, etc.) is caller-supplied. Caller overlay
   * wins over auto-injected values — tests rely on that.
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
  /**
   * Local issue id (`<PREFIX>-N`) the dispatch is bound to, threaded
   * through to the dispatch row's `issue_id` column. Set only by the
   * poller path (it owns the per-issue YAML); Slack/ideator/external
   * launch leave it undefined and the column stays NULL. DX-84 (Agent
   * Chat Phase 2) — the dashboard's per-card chat list filters on this.
   */
  issueId?: string | null;
  /**
   * Optional caller-supplied dispatchId. When provided, `dispatch()` uses
   * this value verbatim for the dispatch row, the spawned agent's `jobId`,
   * and every dispatchId-derived URL in the danxbot MCP server's env block.
   * When omitted, `dispatch()` generates one via `randomUUID()`.
   *
   * Use case: the Trello poller (Phase 2 of the tracker-agnostic-agents
   * epic) pre-generates the UUID so it can stamp the same value into the
   * per-issue YAML at `<repo>/.danxbot/issues/open/<id>.yml`
   * BEFORE the spawn happens. The dashboard's job_id then matches the
   * `dispatch_id` field on disk — one identity end-to-end. External
   * callers (HTTP `/api/launch`, Slack listener) keep omitting this and
   * inherit the auto-generated UUID.
   */
  dispatchId?: string;
  /**
   * Optional `staged_files` entries from `/api/launch`. Written to disk
   * before the agent spawns and removed when the dispatch reaches a
   * terminal state. Every path is placeholder-substituted against
   * `overlay` and validated against the workspace's declared
   * `staging-paths` allowlist. Validation failures throw
   * `StagedFilesError("validation")`; write failures throw
   * `StagedFilesError("write")` — neither path leaves files on disk.
   */
  stagedFiles?: readonly StagedFileInput[];
  /**
   * YAML write/clear pair for the paired host_pid stamp (DX-140). Set
   * only by the poller path — it's the only caller that owns a
   * per-dispatch YAML. `spawnAgent` invokes
   * `pairedWriteHostPid({yaml: input.pairedWriteYaml, ...})` after the
   * runtime fork resolves the agent PID; both stamps land atomically or
   * roll back together. Slack and `/api/launch` omit this and only get
   * the DB-side stamp.
   */
  pairedWriteYaml?: YamlPairedWrite;
  /**
   * Resolved agent persona for this dispatch (DX-162 / multi-worker
   * dispatch epic DX-158). When set, `dispatch()` prepends a persona
   * block (`You are <name>.\n<bio>\nYour worktree: <path>\nYour
   * branch: <name>`) to `task` before any downstream consumption — the
   * agent reads its identity + branch + worktree path on the very
   * first turn.
   *
   * Pass `undefined` for legacy dispatches that don't resolve an agent
   * (today: every caller). Phase 5 (DX-200) wires the poller to pick a
   * free agent and pass it here. The recovery-mode helper
   * (`src/dispatch/recovery-mode.ts`) routes through `dispatch()` with
   * `...input` spread, so a recovery dispatch on an agent-bound card
   * automatically inherits the persona without explicit wiring.
   *
   * The persona is applied to the original `task` body, BEFORE
   * `buildCompletionInstruction` is appended in `runResolved` and
   * BEFORE the stall-recovery respawn note is appended. This keeps
   * the persona a stable first paragraph for every spawn under this
   * dispatch.
   */
  agent?: PersonaContext;
  /**
   * Tracker dispatch lock to release when this dispatch reaches a
   * terminal state. Set by the poller path (Trello multi-agent
   * dispatch) — when present, `dispatch()` fires
   * `releaseLock(tracker, externalId, dispatchId)` as part of the
   * onComplete cleanup chain, BEFORE the caller's `onComplete`.
   *
   * Failures (`released: false`) are logged but never thrown — the
   * cleanup path must keep running. Includes:
   *  - `no-lock`           — fine, the lock was already cleared.
   *  - `unparseable`       — fine, next acquire reclaims via the
   *                          existing legacy-corruption path.
   *  - `not-mine`          — surprising; another holder rewrote the
   *                          comment between dispatch + completion.
   *  - `already-released`  — fine, idempotent.
   *
   * Also fired from the spawn-failure catch in `spawnForDispatch` so a
   * dispatch that crashes before reaching a terminal status still
   * releases its lock instead of leaking it for 2h.
   *
   * Slack listener / `/api/launch` / system tests omit this — they
   * don't acquire a tracker lock, so there is nothing to release. DX-241.
   */
  lockRelease?: {
    tracker: IssueTracker;
    externalId: string;
  };
}

export interface DispatchResult {
  dispatchId: string;
  job: AgentJob;
}

/**
 * Write the per-dispatch MCP settings file to a fresh temp directory and
 * return its absolute path. Called by `dispatch()` after the resolver has
 * produced the `mcpServers` map. Caller is responsible for the
 * temp-dir cleanup (wired through `onComplete` below).
 */
function writeMcpSettingsFile(mcpServers: Record<string, unknown>): {
  settingsDir: string;
  settingsPath: string;
} {
  const settingsDir = mkdtempSync(join(tmpdir(), "danxbot-mcp-"));
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ mcpServers }, null, 2));
  return { settingsDir, settingsPath };
}

function cleanupMcpSettings(settingsDir: string): void {
  try {
    rmSync(settingsDir, { recursive: true, force: true });
  } catch (err) {
    log.error(`Failed to clean up MCP settings dir ${settingsDir}:`, err);
  }
}

function releaseDispatchLock(
  dispatchId: string,
  lockRelease: { tracker: IssueTracker; externalId: string },
): void {
  releaseLock(lockRelease.tracker, lockRelease.externalId, dispatchId)
    .then((result) => {
      if (result.released) {
        log.info(
          `[Dispatch ${dispatchId}] released tracker lock on ${lockRelease.externalId}`,
        );
      } else if (result.reason === "not-mine") {
        // A sibling worker (local dev / production EC2 / parallel
        // host) reclaimed this lock between our acquire and our
        // terminal state. That means our work potentially raced
        // theirs against the same card — investigate before assuming
        // both runs were independent.
        log.warn(
          `[Dispatch ${dispatchId}] lock release on ${lockRelease.externalId} found a different dispatch as owner — another worker reclaimed mid-dispatch; our work may have raced theirs (investigate)`,
        );
      } else {
        log.info(
          `[Dispatch ${dispatchId}] lock release on ${lockRelease.externalId} no-op (${result.reason})`,
        );
      }
    })
    .catch((err) => {
      log.error(
        `[Dispatch ${dispatchId}] lock release on ${lockRelease.externalId} threw — leaking until TTL or next poll tick`,
        err,
      );
    });
}

/**
 * Resolved MCP surface — the shape the spawn loop reads. Produced inside
 * `dispatch()` from `resolveWorkspace` + the danxbot infrastructure server.
 *
 * Per the agent-dispatch contract, the workspace's `.mcp.json` (combined
 * with `--strict-mcp-config`) is the SINGLE source of truth for the
 * agent's MCP surface. There is no per-tool allowlist — claude built-ins
 * are all available by default; MCP tools are everything declared by
 * `mcpServers`.
 */
interface ResolvedSurface {
  /** MCP server configs to write into the per-dispatch settings.json. */
  readonly mcpServers: Record<string, unknown>;
  /**
   * Spawned agent's cwd — the resolved
   * `<repo>/.danxbot/workspaces/<name>/` workspace dir. Required: there
   * is no longer a singular-workspace fallback in the launcher
   * (workspace-dispatch epic, Trello `jAdeJgi5`).
   */
  readonly cwd: string;
  /**
   * Env vars produced by the resolver (e.g. workspace `.claude/settings.json`
   * env block). Merged after the dispatch invariants and before `input.env`.
   */
  readonly envOverrides?: Record<string, string>;
  /**
   * Absolute paths of files written to disk before spawn via
   * `writeStagedFiles`. Cleaned up in the dispatch onComplete chain so
   * the workspace's staging dir doesn't accumulate stale files between
   * dispatches. Empty when the caller supplied no `staged_files`.
   */
  readonly stagedFilePaths: readonly string[];
  /**
   * Top-level agent name from the workspace manifest. Forwarded via
   * `--agent <name>` to claude so the top-level session BECOMES the
   * named agent — eager-loads its `tools:` frontmatter, eliminating the
   * ~4s ToolSearch tax MCP tools otherwise pay. Undefined when the
   * workspace omits `top_level_agent`.
   */
  readonly topLevelAgent?: string;
  /**
   * Absolute path to the workspace's `.claude/settings.json`, when one
   * exists at `<cwd>/.claude/settings.json`. Forwarded as
   * `--settings <path>` so Claude Code loads workspace-scope hooks
   * (SessionStart, SubagentStart, etc.) without requiring the trust
   * dialog. Undefined when the file does not exist.
   */
  readonly settingsPath?: string;
  /**
   * Phase 5c (gpt-manager ISS-102): already-substituted `staging-paths`
   * allowlist from the workspace manifest. Plumbed through to the
   * spawn loop so the dispatch handler can stamp it onto the
   * AgentJob — POST /api/restage/:dispatchId reads it back to validate
   * mid-dispatch staged-file rewrites against the same allowlist used
   * at launch time. Empty when the workspace declares no
   * `staging-paths` (no restage surface for that dispatch).
   */
  readonly stagingPaths: readonly string[];
  /**
   * Phase 5c: overlay used at launch (post-merge — caller overlay +
   * auto-injected danxbot infrastructure keys). Captured here so the
   * restage endpoint can substitute the same `${KEY}` placeholders
   * the launch path used.
   */
  readonly overlay: Readonly<Record<string, string>>;
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

  // DX-241: state shared across all respawns for one dispatch.
  // - `lockReleased`: at-most-once gate, idempotent across the
  //   `pairedWriteHostPid` rollback race (close-handler onComplete +
  //   spawnForDispatch's catch can both fire — without the gate the
  //   tracker eats a duplicate editComment call and the second invocation
  //   logs a misleading `not-mine`/`already-released` line).
  // - `respawnInProgress`: gates the lock-release call inside the
  //   per-respawn onComplete chain. Stall recovery's
  //   `terminateWithGrace` triggers the prior job's close handler →
  //   onComplete fires; without this flag the dispatch lock would be
  //   released between every respawn, opening a window where a sibling
  //   worker (local dev / production EC2) could grab the same card mid-
  //   recovery. Held=true while the next spawn is being prepared; reset
  //   in a finally so a respawn-failure path still releases at the end.
  let lockReleased = false;
  let respawnInProgress = false;

  function fireLockReleaseOnce(): void {
    if (lockReleased) return;
    lockReleased = true;
    if (input.lockRelease) {
      releaseDispatchLock(dispatchId, input.lockRelease);
    }
  }

  async function spawnForDispatch(
    prompt: string,
    isRespawn: boolean,
  ): Promise<AgentJob> {
    const jobId = isRespawn ? randomUUID() : dispatchId;
    const { settingsDir, settingsPath } = writeMcpSettingsFile(
      resolved.mcpServers,
    );

    // On stall-recovery respawn, the initial spawn's `dispatches` row was
    // stamped with the PRIOR `settings_dir/settings.json` path — that
    // dir was just removed by the previous job's `cleanupMcpSettings`
    // (the onComplete chain runs at terminateWithGrace). Without this
    // resync, Phase 2c (DX-209) reattach would read a path pointing at a
    // deleted file (or worse, after `mkdtempSync` randomness, a path
    // belonging to an unrelated dispatch's settings dir). The initial
    // spawn does not need this — `spawnAgent` → `startDispatchTracking`
    // → `insertDispatch` stamps the column atomically with the row
    // creation in that path.
    if (isRespawn) {
      updateDispatch(dispatchId, { mcpSettingsPath: settingsPath }).catch(
        (err) =>
          log.error(
            `[Dispatch ${dispatchId}] Failed to update mcp_settings_path on respawn`,
            err,
          ),
      );
    }

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
      // has to remember. Resolver-supplied `envOverrides` (the workspace's
      // `.claude/settings.json` env block, post-substitution) merge next,
      // then `input.env` wins last so tests can override anything for
      // isolation. See the `DispatchInput.env` docstring for the contract.
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
        settingsPath: resolved.settingsPath,
        topLevelAgent: resolved.topLevelAgent,
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
        issueId: input.issueId,
        agentName: input.agent?.name ?? null,
        // Per-dispatch MCP settings path (DX-207). On the initial spawn
        // this lands on the row via `startDispatchTracking` →
        // `insertDispatch`. On respawn `dispatch` is undefined →
        // `startDispatchTracking` is skipped → this argument is ignored,
        // and the respawn-only `updateDispatch` above is the path that
        // actually keeps the row in sync with the freshly written
        // settings dir. Forward it unconditionally so a future change
        // that decouples row creation from `dispatch !== undefined`
        // does not silently drop the column.
        mcpSettingsPath: settingsPath,
        // Paired host_pid write — only the initial spawn does this, and
        // only when the caller supplies a YAML pair. Stall-recovery
        // respawns reuse the existing dispatch row, so re-stamping
        // `host_pid` would race with the pre-existing record. The
        // launcher tolerates `pairedWriteYaml === undefined` and falls
        // back to a DB-only stamp; respawns explicitly skip even that
        // because the row already carries the prior PID's stamp +
        // `host_pid_at` from the initial spawn.
        pairedWriteYaml: isRespawn ? undefined : input.pairedWriteYaml,
        onComplete: (completedJob) => {
          // See `DispatchInput.onComplete` — cleanup runs before the
          // caller callback (the ordering guarantee is load-bearing).
          // Staged files cleanup runs alongside the MCP settings cleanup;
          // both must finish before the caller observes a terminal job.
          cleanupMcpSettings(settingsDir);
          cleanupStagedFiles(resolved.stagedFilePaths);
          if (resolved.settingsPath) {
            cleanupWorkspaceSettings(resolved.settingsPath);
          }
          // DX-241: fire-and-forget tracker lock release. Runs BEFORE
          // the caller's onComplete so the lock is gone by the time
          // the poller's card-progress check observes the terminal
          // job. Two gates: `respawnInProgress` skips release between
          // stall-recovery respawns (the dispatch is logically still
          // running); `fireLockReleaseOnce` makes the call idempotent
          // across the `pairedWriteHostPid` rollback race (the
          // close-handler onComplete + the catch path can both fire
          // — gate them so the tracker only eats one editComment).
          if (!respawnInProgress) {
            fireLockReleaseOnce();
          }
          input.onComplete?.(completedJob);
        },
      });
    } catch (spawnErr) {
      cleanupMcpSettings(settingsDir);
      cleanupStagedFiles(resolved.stagedFilePaths);
      if (resolved.settingsPath) {
        cleanupWorkspaceSettings(resolved.settingsPath);
      }
      // DX-241: spawn-failure path also releases the tracker lock so a
      // dispatch that died before reaching a terminal status doesn't
      // leak its lock until TTL. `fireLockReleaseOnce` short-circuits
      // when the close-handler onComplete already fired (the
      // `pairedWriteHostPid` rollback path SIGTERMs the process,
      // which triggers the close handler before throwing back up
      // here).
      fireLockReleaseOnce();
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

        // DX-241: hold the lock across the respawn. Without this flag
        // `terminateWithGrace` triggers the prior job's close handler →
        // onComplete fires → `releaseDispatchLock` runs, leaving the
        // tracker card unlocked between respawns. A sibling worker
        // (local dev vs production EC2) polling the same card could
        // grab it during the recovery window.
        respawnInProgress = true;
        try {
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
            // Respawn never landed — release the lock now so the next
            // poll tick can reclaim instead of waiting for TTL.
            fireLockReleaseOnce();
          }
        } finally {
          respawnInProgress = false;
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

  // Phase 5c (ISS-102): preserve the workspace's stagingPaths + the
  // overlay so a later POST /api/restage/:dispatchId can re-run the
  // same prepareStagedFiles + writeStagedFiles chain that produced
  // the original staged files at launch time. Single producer.
  if (resolved.stagingPaths.length > 0) {
    job.restageContext = {
      stagingPaths: resolved.stagingPaths,
      overlay: resolved.overlay,
    };
  }

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
  const dispatchId = input.dispatchId ?? randomUUID();
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
  const issueCreateUrl = `http://localhost:${input.repo.workerPort}/api/issue-create/${dispatchId}`;
  const restartWorkerUrl = `http://localhost:${input.repo.workerPort}/api/restart/${dispatchId}`;
  const overlay: Record<string, string> = {
    DANXBOT_STOP_URL: workerStopUrl,
    // `DANXBOT_WORKER_PORT` is auto-injected from `repo.workerPort` so
    // every dispatch caller (poller, slack, HTTP `/api/launch`) gets it
    // without duplicating the same `String(repo.workerPort)` line.
    // Workspaces that don't reference it (system-test) ignore the extra
    // overlay key; workspaces that do (issue-worker, slack-worker) get
    // the placeholder satisfied without per-call boilerplate.
    DANXBOT_WORKER_PORT: String(input.repo.workerPort),
    DANXBOT_SLACK_REPLY_URL: `http://localhost:${input.repo.workerPort}/api/slack/reply/${dispatchId}`,
    DANXBOT_SLACK_UPDATE_URL: `http://localhost:${input.repo.workerPort}/api/slack/update/${dispatchId}`,
    DANXBOT_ISSUE_CREATE_URL: issueCreateUrl,
    DANXBOT_RESTART_WORKER_URL: restartWorkerUrl,
    // Auto-inject the value the per-workspace `danx-issue` MCP server
    // (`@thehammer/danx-issue-mcp`) needs to find its own repo's
    // `.danxbot/issues/` store. `DANX_REPO_ROOT` is required (the MCP
    // server fails loud without it). DX-203 retired the
    // `DANX_TRACKER` / `TRELLO_API_KEY` / `TRELLO_API_TOKEN` triple —
    // the MCP server is purely a YAML manipulator and reads no tracker
    // creds; the worker's poll loop owns the YAML → Trello mirror
    // asynchronously. Workspaces that don't reference `DANX_REPO_ROOT`
    // simply ignore the extra overlay key.
    DANX_REPO_ROOT: input.repo.localPath,
    // Auto-inject the dispatch id so workspaces that need a per-dispatch
    // staging path (`staging-paths: - "/tmp/conflict-check/${DANXBOT_DISPATCH_ID}/"`)
    // can reference it directly without forcing every caller to plumb
    // it manually. DX-200 / multi-worker conflict-check uses this.
    DANXBOT_DISPATCH_ID: dispatchId,
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

  // Issue-create MCP tool (`danx_issue_create`) is exposed for every
  // worker-mode dispatch — the URL always resolves to the same worker
  // process this dispatch runs in. Absent the worker port (e.g.
  // dashboard-mode tests that bypass the worker server), we simply omit
  // the field and the tool doesn't appear. DX-157 retired the parallel
  // agent-facing save tool — agents `Edit` / `Write` the YAML directly
  // and the chokidar watcher mirrors the change.
  const issue = input.repo.workerPort
    ? { createUrl: issueCreateUrl }
    : undefined;

  // Worker-restart MCP tool — same workerPort gate as issue. Absent the
  // worker port (dashboard-mode tests), the tool simply doesn't appear
  // in `tools/list`.
  const restartWorker = input.repo.workerPort ? restartWorkerUrl : undefined;

  // DX-242: build the danxbot MCP fallback context. The MCP server
  // uses this to finalize a dispatch when the worker is unreachable —
  // direct DB UPDATE on the dispatches row, then a filesystem queue
  // entry the worker replays on its next boot. `repo.localPath` is
  // the queue's root directory; `dispatchId` keys the queue entry;
  // `config.db` is the same `DANXBOT_DB_*` block the worker itself
  // reads. Worker-port-less dispatches still get the fallback because
  // the worker boot replay can find the queue file regardless.
  //
  // The DB block is built defensively — test fixtures mock `../config`
  // with a partial shape that omits `db`; we don't want to force every
  // test mock to grow a db block. Production callers always have it.
  // When the db is incomplete, the MCP server still gets the fs-queue
  // path via `repoRoot` and skips the DB attempt at runtime via its
  // own `readFallbackDbConfig` undefined check.
  const dbConfig = config.db as typeof config.db | undefined;
  const fallbackDb =
    dbConfig &&
    typeof dbConfig.host === "string" &&
    typeof dbConfig.user === "string" &&
    typeof dbConfig.password === "string"
      ? {
          host: dbConfig.host,
          ...(typeof dbConfig.port === "number" ? { port: dbConfig.port } : {}),
          user: dbConfig.user,
          password: dbConfig.password,
          ...(typeof dbConfig.database === "string"
            ? { database: dbConfig.database }
            : {}),
        }
      : undefined;
  const fallback = {
    repoRoot: input.repo.localPath,
    dispatchId,
    ...(fallbackDb ? { db: fallbackDb } : {}),
  };

  const danxbotServer = defaultMcpRegistry[DANXBOT_SERVER_NAME].build({
    danxbotStopUrl: workerStopUrl,
    slack,
    issue,
    restartWorkerUrl: restartWorker,
    fallback,
  });
  const mcpServers: Record<string, unknown> = {
    ...workspaceMcp.mcpServers,
    [DANXBOT_SERVER_NAME]: danxbotServer,
  };

  // Stage files BEFORE spawn. Validation runs against the workspace's
  // already-substituted `staging-paths` allowlist; placeholder
  // substitution shares the same overlay used for the workspace's
  // `.mcp.json` and `.claude/settings.json`. A validation failure
  // surfaces to the HTTP handler as 400 (caller body bug); a write
  // failure as 500 (worker-side IO). Either way, no agent spawns.
  const prepared = prepareStagedFiles({
    stagedFiles: input.stagedFiles ?? [],
    stagingPaths: workspace.stagingPaths,
    overlay,
  });
  const stagedFilePaths = await writeStagedFiles(prepared);

  // Persona prepend (DX-162). When the caller resolved an agent, we
  // prepend a `You are <name>. <bio>. Your worktree: ... Your branch:
  // ...` block as the first paragraph of the task body. Done HERE, not
  // inside `runResolved`, so:
  //   - The completion instruction (appended in runResolved) lands AFTER
  //     the persona — agent identity stays the first line claude reads.
  //   - The stall-recovery respawn path inside runResolved uses the
  //     same `input.task` and therefore inherits the persona on every
  //     respawn without an extra prepend call.
  //   - Recovery-mode dispatches (`src/dispatch/recovery-mode.ts`) flow
  //     through `dispatch()` with `...input` spread; a recovery on an
  //     agent-bound card inherits the persona without explicit wiring.
  const personaTask = prependPersona({
    prompt: input.task,
    repo: input.repo,
    agent: input.agent,
  });
  const inputWithPersona =
    personaTask === input.task ? input : { ...input, task: personaTask };

  // No allowlist: the workspace's `.mcp.json` (with the danxbot
  // infrastructure server merged in here) IS the agent's MCP surface.
  // `--strict-mcp-config` keeps the agent confined to those servers, and
  // claude built-ins are all available by default. `danxbot_complete` is
  // reachable because the danxbot server registers it, not because it's
  // listed anywhere.
  try {
    return await runResolved(inputWithPersona, dispatchId, {
      mcpServers,
      cwd: workspace.cwd,
      envOverrides: workspace.env,
      stagedFilePaths,
      topLevelAgent: workspace.topLevelAgent,
      settingsPath: workspace.settingsPath,
      stagingPaths: workspace.stagingPaths,
      overlay,
    });
  } catch (err) {
    // runResolved already cleans up MCP settings + staged files in the
    // spawn-failure branch via the catch block in spawnForDispatch. This
    // outer catch covers anything that throws BEFORE spawnForDispatch
    // runs — keeps the all-or-nothing staging contract intact.
    cleanupStagedFiles(stagedFilePaths);
    throw err;
  }
}
