/**
 * Phase 3 (DX-142) — process-table orphan scan.
 *
 * Phase 1 (DX-140) made the DB host_pid + YAML dispatch.pid converge at
 * spawn. Phase 2 (DX-141 → DX-209) made the worker boot reattach the
 * full monitoring stack for every non-terminal DB row whose PID is
 * still alive. Both passes assume the DURABLE state (DB row OR YAML)
 * still references the live PID.
 *
 * The May-7 incident left orphans the durable state never knew about —
 * `script -q -f` reparented to PID 1, the DB row was already terminal
 * (post-cleanup), and the worker had no way to ask "is there a live
 * dispatch process I have no record of?" Two minutes later the poller
 * dispatched a SECOND agent against the same card, racing the orphan,
 * and four orphans cumulatively burned tokens unmonitored.
 *
 * This module enumerates every dispatched claude process on the host
 * via `pgrep -af '<!-- danxbot-dispatch:'`, then cross-references each
 * PID's tag-extracted dispatchId against the `dispatches` DB and the
 * in-memory `activeJobs` map. Per-process decision:
 *
 *   - Cwd doesn't belong to this repo → skip (multi-repo host
 *     isolation; sibling worker owns it).
 *   - DB row is non-terminal AND host_pid matches AND process is alive
 *     → healthy, leave alone. `activeJobs` membership is informational
 *     here; reattach (Phase 2) is the only path that wires it up.
 *   - DB row is non-terminal AND host_pid MISMATCHES → log + emit
 *     warn-level `system_errors`. Do NOT auto-kill — Phase 1's atomic
 *     stamp should prevent this; surfacing for audit is the right move.
 *   - DB row is terminal OR no DB row at all → orphan; SIGTERM, wait
 *     5s, SIGKILL on holdout. Emit `system_errors` per kill.
 *
 * Pair detection (host mode): each dispatch produces TWO tagged
 * processes — the `script -q -f` parent (PID stored on the row's
 * `host_pid`) and the `claude` child it wraps. Killing the parent
 * cascades SIGHUP through the pty to claude (terminal.ts comment-block
 * "Signal cascade"), so `pickKillablePidPerDispatch` keeps only the
 * `script` parent in the kill set. Docker mode has no `script`
 * wrapper; the only PID in the pair IS the claude process, kept as-is.
 *
 * Wired at boot in `src/index.ts` (after `reattachOrResolveDispatches`)
 * and per-tick in `src/poller/index.ts` (alongside `evictDeadDispatches`).
 *
 * See DX-142 (Phase 3) + DX-139 (DB-as-registry epic) for the full design.
 */

import { realpathSync } from "node:fs";
import { sep, normalize } from "node:path";
import { isPidAlive, killHostPid } from "../agent/host-pid.js";
import { getActiveJob } from "../dispatch/core.js";
import { getDispatchById } from "../dashboard/dispatches-db.js";
import { isTerminalStatus } from "../dashboard/dispatches.js";
import { recordSystemError } from "../dashboard/system-errors.js";
import { createLogger } from "../logger.js";
import { execPgrepDispatchTag, readProcCwd } from "./process-scan-os.js";

const log = createLogger("process-scan");

/**
 * Tag-extraction regex — matches the dispatchId between `danxbot-dispatch:`
 * and ` -->`. Anchored to the literal `<!-- danxbot-dispatch:` prefix so a
 * stray UUID elsewhere in argv (env paths, fixtures) cannot match. The
 * UUID itself is unanchored on length so a regenerated dispatch-id format
 * (e.g. an internal stall-recovery respawn UUID) still parses.
 */
const DISPATCH_TAG_RE = /<!--\s*danxbot-dispatch:([0-9a-fA-F-]{8,})\s*-->/;

/** Default SIGTERM grace before escalating to SIGKILL (per AC #2). */
const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

const ORPHAN_REAPER_SOURCE = "orphan-reaper" as const;

export interface DispatchProcess {
  pid: number;
  dispatchId: string;
  cmdline: string;
  cwd: string | null;
}

export interface ReapOrphansOptions {
  repoName: string;
  repoLocalPath: string;
  /** SIGTERM-to-SIGKILL grace window. Default {@link DEFAULT_GRACE_MS}. */
  graceMs?: number;
  /** Liveness poll cadence inside the grace window. Default {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
}

export interface ReapResult {
  /** Tagged processes scanned post-repo-isolation (one entry per PID). */
  scanned: number;
  /** One entry per dispatch we SIGTERM'd (after dedupe). */
  reaped: Array<{ pid: number; dispatchId: string; reason: string }>;
  /** Mismatched-host-pid dispatches surfaced for audit (no kill). */
  mismatched: Array<{ pid: number; dispatchId: string; expectedPid: number | null }>;
  /** Healthy dispatches confirmed against a non-terminal DB row. */
  healthy: number;
}

/**
 * Run `pgrep -af '<!-- danxbot-dispatch:'`, parse each line into a
 * `DispatchProcess`, and decorate with `/proc/<pid>/cwd`. Lines with no
 * extractable dispatch tag (a dev's interactive `claude` session, a
 * `grep` whose argv contains the literal tag string, etc.) are skipped.
 *
 * Empty input (no live dispatches) returns `[]` — see `execPgrepDispatchTag`
 * for why pgrep's exit-1 is normalised to empty stdout.
 */
export async function enumerateDispatchProcesses(): Promise<DispatchProcess[]> {
  const stdout = await execPgrepDispatchTag();
  if (stdout.length === 0) return [];

  const out: DispatchProcess[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // pgrep -af shape: `<pid> <full cmdline>`. The first whitespace
    // splits PID from cmdline; nothing else inside cmdline matters
    // for parsing. Use `match(/^(\d+)\s+(.*)$/)` for the split — the
    // cmdline can contain leading whitespace from quoting.
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const cmdline = match[2];
    const tagMatch = cmdline.match(DISPATCH_TAG_RE);
    if (!tagMatch) continue;
    out.push({
      pid,
      dispatchId: tagMatch[1],
      cmdline,
      cwd: readProcCwd(pid),
    });
  }
  return out;
}

/**
 * Resolve `repoLocalPath` to its realpath so `filterByRepoCwd`'s prefix
 * compare matches against the same kernel-resolved string that
 * `/proc/<pid>/cwd` returns. Caller paths are commonly symlinks —
 * `<danxbot>/repos/<name>` is a symlink to the connected repo's host
 * dir (see CLAUDE.md "Connected Repos"). Without this step, EVERY live
 * dispatch's cwd is the realpath form, EVERY caller-supplied
 * `repoLocalPath` is the symlinked form, the prefix compare misses,
 * and the reaper silently filters out every legitimate process — the
 * feature is structurally inert. Reviewer-flagged critical bug.
 *
 * Falls back to the input on `ENOENT` etc. so callers can pre-compute
 * inputs even when the path hasn't been created yet (matches
 * `encodeClaudeProjectsCwd`'s pattern for the same scenario).
 */
export function resolveRepoRoot(repoLocalPath: string): string {
  try {
    return realpathSync(repoLocalPath);
  } catch {
    return repoLocalPath;
  }
}

/**
 * Filter to processes whose cwd is `repoLocalPath` itself or any
 * descendant. Cwd-less processes (`/proc/<pid>/cwd` unreadable) are
 * EXCLUDED — repo isolation must be conservative, and a process we
 * cannot attribute to this repo could be another worker's dispatch
 * mid-fork. Caller is responsible for passing the realpath of the
 * repo root (see {@link resolveRepoRoot}); this function does NOT
 * call `realpathSync` per-tick because reap passes can fire dozens of
 * times an hour and the input is stable.
 *
 * The trailing-separator guard prevents a sibling repo whose path
 * shares a prefix (`/home/newms/web/danxbot-clone`) from being
 * accidentally claimed by `/home/newms/web/danxbot`.
 */
export function filterByRepoCwd<T extends { cwd: string | null }>(
  processes: readonly T[],
  repoLocalPath: string,
): T[] {
  const root = normalize(repoLocalPath).replace(/[/\\]+$/, "");
  const prefix = root + sep;
  return processes.filter((p) => {
    if (!p.cwd) return false;
    const cwd = normalize(p.cwd);
    return cwd === root || cwd.startsWith(prefix);
  });
}

/**
 * `cmdline` shape that uniquely identifies the host-mode `script -q -f`
 * parent wrapping a dispatched claude. Single source of truth — both
 * the dedupe ranking AND any future "is this a host-mode parent?"
 * check share this predicate so a regex tweak lands in one place.
 */
function isScriptParent(cmdline: string): boolean {
  return /^script\s+-q\s+-f\b/.test(cmdline);
}

/**
 * Reduce a flat process list to one PID per dispatchId — the PID we
 * SIGTERM. Host mode produces TWO tagged processes per dispatch (the
 * `script -q -f` parent + the `claude` child). The parent's cmdline
 * starts with `script -q -f` — preferred ABSOLUTELY, because SIGTERM
 * to it cascades SIGHUP through the pty to claude (`terminal.ts`
 * "Signal cascade"). Docker mode produces a single PID per dispatch
 * (no `script` wrapper); kept as-is.
 *
 * When a dispatchId has no `script` parent in the group (docker mode
 * OR the parent already exited and only the orphaned claude is left),
 * fall through to the lowest PID — historical convention for "kill
 * the parent" since claude is forked from script and inherits a
 * higher PID.
 *
 * Per-dispatch grouping is two-pass to avoid order-dependent ranking
 * inside the loop: a prior single-pass implementation could lose the
 * script-parent to a non-parent claude child if pgrep emitted them in
 * an unexpected order (stall-recovery respawn leaves three tagged
 * PIDs; pgrep ordering is empirically ascending but not contractually
 * monotonic). Group first, then rank inside each group — explicit and
 * regression-proof.
 */
export function pickKillablePidPerDispatch(
  processes: readonly DispatchProcess[],
): DispatchProcess[] {
  const groups = new Map<string, DispatchProcess[]>();
  for (const proc of processes) {
    const arr = groups.get(proc.dispatchId);
    if (arr) {
      arr.push(proc);
    } else {
      groups.set(proc.dispatchId, [proc]);
    }
  }

  const out: DispatchProcess[] = [];
  for (const group of groups.values()) {
    const parents = group.filter((p) => isScriptParent(p.cmdline));
    if (parents.length > 0) {
      // Multiple script parents for one dispatchId shouldn't happen,
      // but if they do (e.g. a stall-recovery respawn left an old
      // parent dangling), the lowest PID is the older one — pick it.
      parents.sort((a, b) => a.pid - b.pid);
      out.push(parents[0]);
      continue;
    }
    // No script parent — docker mode OR the parent already exited.
    // Lowest PID is the historical "kill the parent" convention.
    const sorted = [...group].sort((a, b) => a.pid - b.pid);
    out.push(sorted[0]);
  }
  return out;
}

function emitKillError(
  proc: DispatchProcess,
  reason: string,
  repo: string,
): void {
  recordSystemError({
    source: ORPHAN_REAPER_SOURCE,
    severity: "error",
    repo,
    message: `Reaped orphan dispatch ${proc.dispatchId} (pid ${proc.pid}): ${reason}`,
    details: {
      dispatchId: proc.dispatchId,
      pid: proc.pid,
      reason,
      cmdline: proc.cmdline,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcessGracefully(
  proc: DispatchProcess,
  reason: string,
  repo: string,
  graceMs: number,
  pollIntervalMs: number,
): Promise<void> {
  log.warn(
    `[${repo}] reap: SIGTERM pid=${proc.pid} dispatchId=${proc.dispatchId} reason="${reason}"`,
  );
  log.warn(`[${repo}] reap: cmdline="${proc.cmdline}"`);

  // Emit BEFORE the kill so a SIGTERM that somehow blows up the worker
  // process itself (re-parented init quirks) still surfaces on the
  // dashboard banner.
  emitKillError(proc, reason, repo);

  killHostPid(proc.pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(proc.pid)) return;
    await sleep(pollIntervalMs);
  }

  if (isPidAlive(proc.pid)) {
    log.warn(
      `[${repo}] reap: SIGKILL pid=${proc.pid} (SIGTERM grace ${graceMs}ms exceeded)`,
    );
    // SIGKILL is a distinct outcome from "process exited on SIGTERM"
    // — the agent's process refused a graceful shutdown, possibly
    // stuck in a syscall or hung in claude itself. Emit a separate
    // banner entry so the operator can investigate the holdout
    // (worker-side log search by dispatchId + the original kill
    // reason gives them everything they need).
    recordSystemError({
      source: ORPHAN_REAPER_SOURCE,
      severity: "error",
      repo,
      message: `Orphan dispatch ${proc.dispatchId} (pid ${proc.pid}) refused SIGTERM — escalating to SIGKILL`,
      details: {
        dispatchId: proc.dispatchId,
        pid: proc.pid,
        reason,
        graceMs,
        cmdline: proc.cmdline,
      },
    });
    killHostPid(proc.pid, "SIGKILL");
  }
}

/**
 * Single orphan-reaper pass for `repoName`. Enumerates dispatched claude
 * processes via `pgrep`, isolates this repo's via cwd matching, dedupes
 * the script-parent / claude-child pair to one killable PID per
 * dispatch, then walks the dispatches DB row by row to decide
 * leave-alone / mismatch-warn / kill per the table at the top of this
 * file. Returns a {@link ReapResult} so the caller can log a summary
 * line.
 *
 * Per-process DB lookup failures are logged and SKIPPED — the worker's
 * primary mission is serving live dispatches; an unreachable DB during
 * a scan tick must not cascade into a wrongful kill.
 */
export async function reapOrphans(
  opts: ReapOrphansOptions,
): Promise<ReapResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const all = await enumerateDispatchProcesses();

  // Surface tagged processes whose `/proc/<pid>/cwd` is unreadable —
  // they're conservatively excluded from the reap set (we can't
  // attribute them to a repo), but silently dropping them means an
  // orphan whose cwd is unreadable on every tick (zombie state,
  // permission denied) dodges the reaper indefinitely. A log line
  // gives the operator the dispatchId + PID to investigate manually.
  for (const proc of all) {
    if (proc.cwd === null) {
      log.warn(
        `[${opts.repoName}] reap: tagged process pid=${proc.pid} dispatchId=${proc.dispatchId} has unreadable /proc/<pid>/cwd — skipping (cannot attribute to a repo)`,
      );
    }
  }

  // Realpath the repo root once per pass so the prefix compare in
  // `filterByRepoCwd` matches the kernel-resolved cwd that
  // `readProcCwd` returns. `repos/<name>` is commonly a symlink to
  // the connected repo's host dir (DX-142 reviewer flagged this as
  // the bug that nullified the entire feature pre-fix).
  const repoRoot = resolveRepoRoot(opts.repoLocalPath);
  const inRepo = filterByRepoCwd(all, repoRoot);
  const killable = pickKillablePidPerDispatch(inRepo);

  const result: ReapResult = {
    scanned: killable.length,
    reaped: [],
    mismatched: [],
    healthy: 0,
  };

  for (const proc of killable) {
    let row;
    try {
      row = await getDispatchById(proc.dispatchId);
    } catch (err) {
      log.error(
        `[${opts.repoName}] reap: DB read failed for ${proc.dispatchId} pid=${proc.pid}`,
        err,
      );
      // Surface as a dashboard banner — without this the operator
      // never sees that the reaper skipped a tagged process; a
      // genuine orphan keeps burning tokens until the DB recovers
      // AND the next reap tick runs. "Don't wrongful-kill" stays
      // the right call but it must be observable.
      recordSystemError({
        source: ORPHAN_REAPER_SOURCE,
        severity: "warn",
        repo: opts.repoName,
        message: `Orphan reaper skipped pid ${proc.pid} (dispatchId=${proc.dispatchId}) — DB read failed; orphan retained until DB recovers`,
        details: {
          dispatchId: proc.dispatchId,
          pid: proc.pid,
          cmdline: proc.cmdline,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      continue;
    }

    if (!row) {
      const reason = `no-row (dispatchId=${proc.dispatchId} not in dispatches table)`;
      await killProcessGracefully(
        proc,
        reason,
        opts.repoName,
        graceMs,
        pollIntervalMs,
      );
      result.reaped.push({
        pid: proc.pid,
        dispatchId: proc.dispatchId,
        reason: "no-row",
      });
      continue;
    }

    if (isTerminalStatus(row.status)) {
      const reason = `dispatch row is terminal (status=${row.status}) but process is alive`;
      await killProcessGracefully(
        proc,
        reason,
        opts.repoName,
        graceMs,
        pollIntervalMs,
      );
      result.reaped.push({
        pid: proc.pid,
        dispatchId: proc.dispatchId,
        reason: `terminal-${row.status}`,
      });
      continue;
    }

    // Non-terminal row + alive PID. host_pid match decides.
    if (row.hostPid !== proc.pid) {
      log.warn(
        `[${opts.repoName}] reap: dispatch ${proc.dispatchId} mismatched host_pid — row=${row.hostPid} live=${proc.pid}; not killing (Phase 1 stamp should prevent this; surfacing for audit)`,
      );
      recordSystemError({
        source: ORPHAN_REAPER_SOURCE,
        severity: "warn",
        repo: opts.repoName,
        message: `Process-table scan found dispatch ${proc.dispatchId} with mismatched host_pid (row=${row.hostPid}, live=${proc.pid}); leaving alone — investigate`,
        details: {
          dispatchId: proc.dispatchId,
          rowHostPid: row.hostPid,
          livePid: proc.pid,
          cmdline: proc.cmdline,
        },
      });
      result.mismatched.push({
        pid: proc.pid,
        dispatchId: proc.dispatchId,
        expectedPid: row.hostPid,
      });
      continue;
    }

    // Healthy: non-terminal row, host_pid matches, process alive.
    // activeJobs membership is informational here — the missed-boot-
    // reattach case is rare and out of scope for this scan; reattach
    // (Phase 2) owns activeJobs wiring. Log a warning if the slot is
    // empty so the operator can investigate, but do not kill.
    if (!getActiveJob(proc.dispatchId)) {
      log.warn(
        `[${opts.repoName}] reap: dispatch ${proc.dispatchId} alive + matching host_pid but missing from activeJobs (possible missed boot reattach)`,
      );
    }
    result.healthy++;
  }

  return result;
}
