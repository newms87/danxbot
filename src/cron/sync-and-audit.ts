/**
 * Cron sync + audit sweep — Phase 5 of Event-Driven Worker (DX-220).
 *
 * Renamed from the pre-DX-220 `src/poller/index.ts` once the dispatch decisions moved
 * to `src/dispatch/scheduler.ts` (Phase 4 / DX-219 + DX-287's 4b chain
 * via DX-288/289/290). What remains here is the per-minute cron sweep:
 * an inbound mirror from Trello (the only direction Trello cannot
 * push) plus an audit reconcile pass over every open YAML (the safety
 * net for any chokidar event the watcher missed).
 *
 * The cron body (`_sync`) calls:
 *
 *   1. `syncRepoFiles(repo)` — re-run the inject pipeline every tick
 *      so changes inside `.danxbot/config/` propagate to dispatched
 *      agents without a restart.
 *   2. `reapOrphans` — process-table orphan scan; SIGTERMs dispatched
 *      claude processes the DB lost track of.
 *   3. `runInvariantHeal` — clears the `dispatch` slot on cards whose
 *      dispatch is verifiably dead (orphan pre-stamp from legacy
 *      unscoped path / mid-spawn crash). `assigned_agent` is durable
 *      audit and is preserved. Surfaces back to scheduler via the
 *      reconcile-driven `onReconcileResult` event chain on the same
 *      tick.
 *   4. `runOrphanInProgressHeal` (DX-329) — flips cards stuck at
 *      `In Progress` + `dispatch: null` back to `ToDo` so the picker
 *      can re-claim them. Complements `runInvariantHeal` (which
 *      clears `dispatch` blocks but never flips `status`).
 *   5. `runInboundFetch` — Trello inbound: Needs Help comment scan +
 *      `tracker.fetchOpenCards` + bulk hydrate missing YAMLs. Gated
 *      on `trelloSync` per-repo toggle (DX-302).
 *   6. `runAuditPass` — for each open YAML: `reconcileIssue(card,
 *      "audit")`. Drift surfaces as `recordSystemError({source:
 *      "audit-drift"})` so the dashboard banner counts divergence.
 *   7. `firePickerWithMutex(repo.name)` — DX-368 convergence safety
 *      net. Fires the picker unconditionally after audit-pass so a
 *      dropped event-driven poke (reconcile / roster / dispatch
 *      termination) self-heals within ~60s. The scheduler's single-
 *      flight mutex coalesces this with any concurrent event-driven
 *      fire so we never double-pick.
 *
 * Everything else `runSync` used to do is gone — dispatch decisions,
 * triage walk, dead-dispatch eviction, parent-status derive,
 * waiting-on auto-clear, orphan push. Each moved to either reconcile
 * (DX-217/DX-218), per-card / per-dispatch `setTimeout` timers
 * (DX-289), or the scheduler engine (DX-288/DX-290).
 *
 * Pre-DX-220 sibling — `runStartupReattach` — moved to
 * `scheduler.bootRehydrate` so worker boot has one consolidated
 * surface for "re-arm every per-card/per-dispatch timer + clear dead
 * dispatch records".
 */

import { config } from "../config.js";
import { repoContexts } from "../repo-context.js";
import { createIssueTracker } from "../issue-tracker/index.js";
import type { IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";
import { isFeatureEnabled } from "../settings-file.js";
import { readFlag } from "../critical-failure.js";
import { reapOrphans } from "../worker/process-scan.js";
import { runInvariantHeal, runOrphanInProgressHeal } from "../poller/heal.js";
import {
  liveDispatchIssueIds,
  lastTerminalDispatchStatusByIssue,
} from "../agent/agent-locks.js";
import { readAgents } from "../settings-file.js";
import { syncRepoFiles } from "../inject/sync.js";
import { runAuditPass } from "./audit-pass.js";
import { runInboundFetch } from "./inbound-fetch.js";
import { firePickerWithMutex } from "../dispatch/scheduler.js";
import { hasRepoRootSyncError, syncRepoRoot } from "../worker/sync-root.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSimpleYaml } from "../poller/parse-yaml.js";
import { createLogger } from "../logger.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const log = createLogger("cron");

/**
 * Per-repo cron state.
 *
 * DX-290 slimmed this from the legacy seven-field shape to a
 * re-entrancy guard plus the timer handle. The legacy single-fork
 * `spawnClaude` dispatch path's bookkeeping fields all moved
 * elsewhere when DX-290 retired that path. The multi-agent dispatch
 * path (`src/poller/multi-agent-pick.ts`, scheduled via
 * `src/dispatch/scheduler.ts`) tracks per-dispatch state inside
 * `dispatch()` itself; the post-dispatch "card didn't move" check
 * lives in `runPostDispatchProgressCheck`.
 */
interface RepoCronState {
  syncing: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
}

const repoState = new Map<string, RepoCronState>();

/**
 * DX-322 — render `remainingMs` as a human-readable `Xh Ym Zs` /
 * `Ym Zs` / `Zs` string for the throttle halt log. Operators reading
 * `make logs` get the resume ETA at a glance without parsing ISO
 * timestamps.
 */
function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "0s";
  const totalSeconds = Math.floor(remainingMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getState(repoName: string): RepoCronState {
  let state = repoState.get(repoName);
  if (!state) {
    state = {
      syncing: false,
      intervalId: null,
    };
    repoState.set(repoName, state);
  }
  return state;
}

/**
 * Cache of one IssueTracker per repo, populated lazily by `getRepoTracker`.
 *
 * The cache is essential for the test-only tracker stub (see
 * `src/__tests__/helpers/` for the in-memory implementation) used by
 * suites that drive a full ToDo → In Progress → Done lifecycle
 * through repeated `poll()` calls: a fresh tracker per tick would
 * lose every card it ever stored. With caching, the stored card
 * sequence survives the entire run. `TrelloTracker` also benefits —
 * `checklistIdCache` and `triagedLabelIdCache` survive across ticks
 * instead of cold-starting every minute.
 *
 * **Lifecycle invariant:** the cache lives until process restart. The
 * worker never rotates `RepoContext` at runtime — credential changes
 * require a redeploy, which recreates the worker container, which
 * tears down this Map naturally. Adding a future tracker with
 * refreshable / short-lived auth (OAuth, rotating tokens) would need
 * to invalidate selectively here; until then, no production code path
 * reads or writes the cache outside `getRepoTracker`.
 *
 * Cleared by `_resetForTesting` so per-test isolation works.
 */
const trackerByRepo = new Map<string, IssueTracker>();

/**
 * DX-342 — repos with no tracker (no Trello creds) hit this branch on
 * every tick. Caching the "no tracker" verdict separately from the
 * populated map saves a `createIssueTracker` allocation per tick.
 */
const noTrackerRepos = new Set<string>();

function getRepoTracker(repo: RepoContext): IssueTracker | null {
  if (noTrackerRepos.has(repo.name)) return null;
  let tracker = trackerByRepo.get(repo.name);
  if (!tracker) {
    const fresh = createIssueTracker(repo);
    if (fresh === null) {
      noTrackerRepos.add(repo.name);
      return null;
    }
    tracker = fresh;
    trackerByRepo.set(repo.name, tracker);
  }
  return tracker;
}

/**
 * Top-level entrypoint — one cron tick per repo. Skipped when:
 *   - Another tick is already in flight (re-entrancy guard).
 *   - `issuePoller` per-repo toggle is `false` (runtime override).
 *   - `<repo>/.danxbot/CRITICAL_FAILURE` is present (env-level halt
 *     gate; operator must clear via dashboard or `rm`).
 *
 * Kept the legacy name `poll` (not `sync`) so test fixtures + boot
 * order stay compatible without a per-call rename.
 */
export async function poll(repo: RepoContext): Promise<void> {
  const state = getState(repo.name);
  if (state.syncing) {
    return;
  }

  // Runtime toggle — when the Trello poller is disabled for this repo
  // via the settings file, skip the tick entirely. Checked per-tick so
  // operators can toggle without a worker restart. See
  // `.claude/rules/settings-file.md`.
  if (!isFeatureEnabled(repo, "issuePoller")) {
    log.info(`[${repo.name}] cron disabled via settings — skipping`);
    return;
  }

  // Critical-failure halt gate. When the agent signaled
  // `critical_failure` or the post-dispatch check caught a dispatch
  // that didn't move its card out of ToDo, a flag file is written at
  // `<repo>/.danxbot/CRITICAL_FAILURE`. The cron refuses to run while
  // the flag is present — a human must clear it (via `rm` or the
  // dashboard DELETE endpoint) after fixing the underlying env issue.
  // Slack listener and /api/launch are unaffected by design — the
  // halt is cron-only. See `.claude/rules/agent-dispatch.md`
  // "Critical failure flag".
  //
  // DX-322 — throttle-source flags self-clear. `readFlag` auto-
  // unlinks the file when `now >= resume_at` and returns `null` on
  // the same tick, so the gate proceeds normally past the deadline
  // without operator action. While the flag is still in-window, the
  // halt log shows remaining time so the dashboard / operator sees
  // the resume ETA without parsing the JSON.
  const flag = readFlag(repo.localPath);
  if (flag) {
    if (flag.source === "throttle" && flag.resume_at) {
      const remainingMs = Math.max(0, Date.parse(flag.resume_at) - Date.now());
      log.warn(
        `[${repo.name}] cron throttled — Anthropic rate-limit until ${flag.resume_at} (${formatRemaining(remainingMs)} remaining): ${flag.reason}`,
      );
    } else {
      log.warn(
        `[${repo.name}] cron halted — critical-failure flag present (source=${flag.source}, dispatch=${flag.dispatchId}): ${flag.reason}`,
      );
    }
    return;
  }

  state.syncing = true;
  try {
    await _sync(repo);
  } finally {
    state.syncing = false;
  }
}

async function _sync(repo: RepoContext): Promise<void> {
  // DX-149: top-level crash isolation.
  //
  // Any tracker call (other than the inner try/catch around
  // `tracker.fetchOpenCards` itself) historically threw straight
  // past `_sync` and out through `poll()`'s `finally`, killing the
  // whole worker process. Production hit this when a local YAML
  // carried a stale `external_id` (e.g. `mem-2` left over from an
  // earlier in-memory test window) and the repo later switched to
  // Trello — `tryAcquireLock` → `tracker.getComments` returned 400
  // and the entire worker died: Slack listener, dispatch API,
  // dashboard SSE, all gone.
  //
  // The wrap is intentionally one block, not per-call. Per-call
  // try/catches multiply boilerplate and don't cover future tracker
  // calls. The next tick re-runs the whole `_sync` body idempotently,
  // so partial completion inside this function is already a
  // non-issue. Keep `state.syncing` reset in `poll()`'s finally —
  // this catch must not touch it (would mask state bugs).
  try {
    // Re-run the inject pipeline every tick (not just at worker boot)
    // so changes inside `.danxbot/config/` propagate to dispatched
    // agents without a restart. `syncRepoFiles` is idempotent — see
    // its docstring + the per-workspace render loop inside.
    syncRepoFiles(repo);

    // ONE tracker per repo, reused across every tick (see
    // `getRepoTracker`). Cached state (test-only stub cards for
    // tests, Trello checklist + label id caches for production)
    // survives the tick so tests can assert on a single mock.
    //
    // DX-342 — `null` in YAML-only mode. `runInboundFetch` is the
    // only tracker-gated cron stage; everything else (process-table
    // reaper, invariant heal, orphan IP heal, audit reconcile) runs
    // unconditionally — those paths read YAML + DB only.
    const tracker = getRepoTracker(repo);

    // Phase 3 (DX-142) — process-table orphan scan. The DB-driven
    // reattach pass at boot + the YAML-driven invariant heal below
    // both look at KNOWN records and ask "is the recorded PID
    // alive?" Neither asks "is there a live dispatch process I have
    // no record of?" — which is exactly the failure shape the May-7
    // incident hit. `reapOrphans` enumerates every dispatched claude
    // process via `pgrep -af '<!-- danxbot-dispatch:'` and SIGTERMs
    // the ones whose DB row went terminal (or never existed) while
    // the OS process kept running. See `src/worker/process-scan.ts`
    // for the per-process decision matrix; failures swallowed so a
    // bad scan tick can't take down the cron.
    try {
      const reaped = await reapOrphans({
        repoName: repo.name,
        repoLocalPath: repo.localPath,
      });
      if (reaped.reaped.length > 0 || reaped.mismatched.length > 0) {
        log.info(
          `[${repo.name}] Orphan reaper (tick): scanned=${reaped.scanned} reaped=${reaped.reaped.length} mismatched=${reaped.mismatched.length} healthy=${reaped.healthy}`,
        );
      }
    } catch (err) {
      log.error(`[${repo.name}] Orphan reaper (tick) failed`, err);
    }

    // Inbound fetch (DX-302 trelloSync-gated): Needs Help comment
    // scan + `tracker.fetchOpenCards` + bulk hydration. Splits into
    // its own module so the outbound + audit halves can grow
    // independently. After hydration the chokidar watcher fires
    // `reconcileIssue(card, "hydrate")` per write — the multi-agent
    // dispatch path observes the new card on its next reconcile
    // poke.
    //
    // DX-342 — skipped in YAML-only mode. The inbound fetch's whole
    // purpose is to mirror tracker state into local YAML; with no
    // tracker, there is nothing to fetch.
    if (tracker !== null) {
      await runInboundFetch(repo, tracker);
    }

    // DX-286 — per-tick orphan invariant scan. Walks every open
    // YAML and clears any card violating
    // `(dispatch !== null) === (assigned_agent !== null)` when the
    // underlying dispatch (if any) is verifiably dead. Catches both
    // XOR directions in one pass; the liveness gate inside the scan
    // protects in-flight paired-writes. Cleared orphans surface back
    // to the scheduler's `runPicker` callback in `src/index.ts` via
    // the chokidar → reconcile → `onReconcileResult` event chain on
    // the same tick. Same scan runs once at boot (`src/index.ts`)
    // for pre-fix-bug residue.
    await runInvariantHeal(repo, "per-tick");

    // DX-329 — per-tick orphan In Progress heal. Complements
    // `runInvariantHeal` above: that pass clears stale `dispatch`
    // blocks but never flips `status`. A card whose prior dispatch
    // ended in any terminal `DispatchStatus`
    // (`completed`/`failed`/`cancelled`/`recovered`/`throttled` per
    // `src/dashboard/dispatches.ts`) ends up at `status: In Progress` +
    // `dispatch: null` — the picker filter requires `status === "ToDo"`
    // and skips the card forever. This pass flips it back so the picker
    // sees the work on its next tick. Race-guarded against in-flight
    // paired-writes via `liveDispatchIssueIds` + a 5-minute age
    // floor. Same scan runs at boot from `src/index.ts`.
    await runOrphanInProgressHeal(repo, "per-tick", {
      liveDispatchIssueIds,
      lastTerminalDispatchStatusByIssue,
      readAgents,
    });

    // Phase 5 (DX-220) — audit reconcile pass over every open YAML.
    // Calls `reconcileIssue(card, "audit")` and records drift via
    // `recordSystemError({source: "audit-drift"})` when the audit
    // body rewrote the file. The chokidar mirror + per-event
    // reconcile are the primary path for state convergence; this
    // audit pass is the safety net for any missed event.
    const audit = await runAuditPass(repo);
    if (audit.drifted.length > 0) {
      log.warn(
        `[${repo.name}] audit pass: ${audit.drifted.length} drift / ${audit.errors.length} errors / ${audit.scanned} scanned`,
      );
    }

    // DX-558 — root-clone sync retry. The post-dispatch hook runs
    // `syncRepoRoot` after every terminal dispatch. This per-tick
    // retry fires ONLY when the prior attempt is in the error state
    // so the green steady-state path pays a single map lookup. The
    // outer `_sync` try/catch already isolates the tick from any
    // unexpected throw.
    if (hasRepoRootSyncError(repo.name)) {
      await syncRepoRoot({ repoName: repo.name, repoLocalPath: repo.localPath });
    }

    // DX-368 — cron-tick safety net for missed event-driven picker
    // pokes. The picker is event-driven (post-DX-290) — fires on
    // `onReconcileResult` / `onAgentRosterChange` / `kickPickerOnceAtBoot` /
    // `onDispatchTerminated`. If any of those events is dropped (in-process
    // exception in a downstream handler, microtask ordering quirk, etc.),
    // the picker can sit idle while a free agent + a dispatchable card
    // both exist. Firing the picker unconditionally after the audit
    // pass guarantees a self-heal within 1 cron tick. The single-flight
    // mutex inside `firePickerWithMutex` serializes against concurrent
    // event-driven calls; the cost is one extra picker invocation per
    // minute per repo when no event fired (cheap — picker exits
    // immediately if no candidate).
    await firePickerWithMutex(repo.name);
  } catch (error) {
    // DX-149: any throw from inside `_sync` (tracker calls, lock
    // acquisition, hydrate-or-load, dispatch shell prep) lands here
    // so the worker process survives. The inner try/catch around
    // `tracker.fetchOpenCards` already returns early on its own
    // failure mode — that path never reaches here.
    //
    // No `recordError` / dashboard surface yet — DX-134 owns that
    // SSE channel + UI banner. Until then, `log.error` is the
    // contract: a single, attributable line per dropped tick.
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      `[${repo.name}] _sync crashed — tick aborted, next tick will retry: ${message}`,
      error,
    );
  }
}

/**
 * Validate that .danxbot/config/ in the connected repo and env vars are fully configured.
 * Throws if anything is missing or empty — the cron must not run without valid config.
 */
export function validateRepoConfig(repo: RepoContext): void {
  const errors: string[] = [];
  const danxbotConfigDir = resolve(repo.localPath, ".danxbot/config");

  // 1. .danxbot/config/ directory must exist in the connected repo
  if (!existsSync(danxbotConfigDir)) {
    throw new Error(
      `[${repo.name}] .danxbot/config/ not found in connected repo. Run ./install.sh to set up danxbot.`,
    );
  }

  // 2. Required files must exist and not be empty
  const requiredFiles = [
    { path: "config.yml", label: "Repo configuration" },
    { path: "overview.md", label: "Repo overview" },
    { path: "workflow.md", label: "Repo workflow" },
    { path: "trello.yml", label: "Trello board/list/label IDs" },
  ];

  for (const { path, label } of requiredFiles) {
    const fullPath = resolve(danxbotConfigDir, path);
    if (!existsSync(fullPath)) {
      errors.push(`Missing .danxbot/config/${path} (${label})`);
    } else {
      const content = readFileSync(fullPath, "utf-8").trim();
      if (!content) {
        errors.push(`Empty .danxbot/config/${path} (${label})`);
      }
    }
  }

  // 3. config.yml must have required fields with non-empty values
  const repoConfigYml = resolve(danxbotConfigDir, "config.yml");
  if (existsSync(repoConfigYml)) {
    const raw = readFileSync(repoConfigYml, "utf-8");
    const cfg = parseSimpleYaml(raw);

    const requiredFields = [
      { key: "name", label: "Repo name" },
      { key: "url", label: "Repo URL" },
      { key: "runtime", label: "Runtime (docker or local)" },
      { key: "language", label: "Language" },
    ];

    for (const { key, label } of requiredFields) {
      if (!cfg[key] || !cfg[key].trim()) {
        errors.push(
          `Missing '${key}' in .danxbot/config/config.yml (${label})`,
        );
      }
    }

    // If runtime is docker, compose config is required
    if (cfg.runtime === "docker") {
      const dockerFields = [
        { key: "docker.compose_file", label: "Docker compose file" },
        { key: "docker.service_name", label: "Docker service name" },
        { key: "docker.project_name", label: "Docker project name" },
      ];
      for (const { key, label } of dockerFields) {
        if (!cfg[key] || !cfg[key].trim()) {
          errors.push(
            `Missing '${key}' in .danxbot/config/config.yml (${label} — required when runtime is docker)`,
          );
        }
      }

      // Compose file must actually exist
      const composeFile = resolve(danxbotConfigDir, "compose.yml");
      if (!existsSync(composeFile)) {
        errors.push(
          `Missing .danxbot/config/compose.yml (required when runtime is docker)`,
        );
      }
    }
  }

  // 4. Required environment variables (secrets)
  const requiredEnvVars = [
    { name: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
  ];

  for (const { name, label } of requiredEnvVars) {
    const value = process.env[name];
    if (!value || !value.trim()) {
      errors.push(`Missing env var ${name} (${label})`);
    }
  }

  // 5. Per-repo secrets must be set (loaded via RepoContext)
  if (!repo.trello.apiKey)
    errors.push(`Missing DANX_TRELLO_API_KEY in ${repo.name}/.danxbot/.env`);
  if (!repo.trello.apiToken)
    errors.push(`Missing DANX_TRELLO_API_TOKEN in ${repo.name}/.danxbot/.env`);
  if (!repo.githubToken)
    errors.push(`Missing DANX_GITHUB_TOKEN in ${repo.name}/.danxbot/.env`);

  // 6. Claude auth files must exist
  const claudeAuthDir = resolve(projectRoot, "claude-auth");
  const claudeJson = resolve(claudeAuthDir, ".claude.json");
  if (!existsSync(claudeJson)) {
    errors.push(
      `Missing claude-auth/.claude.json (Claude Code credentials — run ./install.sh Step 6)`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `[${repo.name}] Repo config validation failed:\n  - ${errors.join("\n  - ")}\n\nRun ./install.sh to complete setup.`,
    );
  }

  log.debug(`[${repo.name}] Repo config validated successfully`);
}

export function shutdown(): void {
  log.info("Shutting down cron...");

  for (const [, state] of repoState) {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  process.exit(0);
}

/**
 * Start the cron sweep for every configured repo. Sets the interval
 * timer that fires `poll(repo)` every `config.pollerIntervalMs` (1
 * minute in production).
 *
 * Boot ordering: `scheduler.bootRehydrate` MUST have run before this
 * — it re-arms per-card triage timers + per-dispatch TTL timers
 * from on-disk state so the cron's first tick observes a consistent
 * baseline. See `src/index.ts` for the call order.
 */
export async function start(): Promise<void> {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (repoContexts.length === 0) {
    log.error("No repos configured — nothing to sync");
    return;
  }

  // Every repo gets a cron interval scheduled regardless of the env
  // default — the per-tick `isFeatureEnabled(repo, "issuePoller")`
  // check in `poll()` honors runtime overrides from
  // `.danxbot/settings.json`, so boot-time skipping would defeat the
  // toggle. Boot-time validation only runs when the env default says
  // Trello is supposed to be on; a repo that opts in at runtime takes
  // responsibility for ensuring its config is complete (the first
  // enabled tick surfaces config gaps naturally).
  for (const repo of repoContexts) {
    if (repo.trelloEnabled) {
      validateRepoConfig(repo);
    } else {
      log.info(
        `[${repo.name}] Trello env-default disabled — skipping boot validation. Runtime override in settings.json can still enable the cron.`,
      );
    }

    const state = getState(repo.name);
    const intervalSeconds = config.pollerIntervalMs / 1000;
    log.info(`[${repo.name}] Cron started — sync every ${intervalSeconds}s`);

    poll(repo);
    state.intervalId = setInterval(() => poll(repo), config.pollerIntervalMs);
  }
}

/** Reset module state for testing. Do not use in production. */
export function _resetForTesting(): void {
  for (const state of repoState.values()) {
    state.syncing = false;
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }
  repoState.clear();
  trackerByRepo.clear();
  noTrackerRepos.clear();
}

// Auto-start when run as the direct entrypoint.
const isDirectEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/cron/sync-and-audit.ts");

if (isDirectEntrypoint) {
  start();
}
