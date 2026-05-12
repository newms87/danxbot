/**
 * Per-tick self-heal pass for `<repo>/.danxbot/issues/{open,closed}/`.
 * Two complementary sweeps that together keep the on-disk state of every
 * card aligned with the file location convention (terminal → `closed/`,
 * non-terminal → `open/`):
 *
 *  1. **`open/` → `closed/`** (the "typical" heal, ISS-133): walks
 *     `<repo>/.danxbot/issues/open/`. Any YAML whose `status` is `Done`
 *     or `Cancelled` is moved to `closed/` via
 *     `moveToClosedIfTerminal`. The status field itself is unchanged —
 *     the move is a janitorial filesystem fix, NOT a state delta. No
 *     `history[]` entry is emitted (DX-147 AC #3: history reflects real
 *     status changes, not filesystem noise).
 *
 *  2. **`closed/` → `open/`** (the "inverse" heal, DX-147): walks
 *     `<repo>/.danxbot/issues/closed/`. Any YAML whose `status` is NOT
 *     `Done` / `Cancelled` is a real state delta — the operator (or a
 *     prior write that bypassed the lifecycle helpers) drifted a closed
 *     card back to a non-terminal status. The healer moves the file
 *     back to `open/` AND stamps a `worker:heal` `status_change` entry
 *     on the card's `history[]` so the audit log records the reverse
 *     transition. The `from` is taken via the filename-location
 *     heuristic — closed/ implies a prior terminal state; the most
 *     recent terminal in `history[]` (if any) wins, otherwise we
 *     default to `Done` (the more common terminal).
 *
 * Idempotent. Tracker-independent. Tolerates malformed YAMLs (returned
 * in `errors[]`; the pass continues).
 *
 * Pairs with:
 *
 *  - DX-145 — schema + `appendHistory` helper (`src/issue-tracker/yaml.ts`).
 *  - DX-146 — dispatch-driven save/create history.
 *  - DX-147 — this file's `worker:heal` actor + the `closed/`→`open/`
 *    inverse pass.
 *  - ISS-98 epic-status auto-derive — runs after this heal pass moves
 *    the last child to `closed/`; on the next tick the parent epic
 *    flips to Done automatically (and is itself healed on the tick
 *    after).
 *
 * Pure-local, no tracker imports — keeps the module testable with a
 * real tmpdir without paying the env-validation tax of `src/config.ts`.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  appendHistory,
  buildIssueIdRegex,
  IssueParseError,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import {
  clearDispatchAndWrite,
  ensureIssuesDirs,
  issuePath,
  moveToClosedIfTerminal,
} from "./yaml-lifecycle.js";
import {
  checkYamlDispatchLiveness,
  type LivenessDeps,
} from "./dispatch-liveness-yaml.js";
import { isPidAlive } from "../agent/host-pid.js";
import { hostname as osHostname } from "node:os";
import type { RepoContext } from "../types.js";
import { createLogger } from "../logger.js";

/**
 * One heal action recorded by `healLocalYamls`. The `direction` tag
 * disambiguates the typical `open/` → `closed/` move (terminal status
 * flushed to closed bucket) from the DX-147 inverse `closed/` → `open/`
 * move (status drifted back to non-terminal). Callers that log per-action
 * (e.g. the poller `_poll` block) can render direction-aware strings
 * without re-parsing the issue.
 */
export interface HealedIssue {
  id: string;
  status: IssueStatus;
  direction: "open-to-closed" | "closed-to-open";
}

export interface HealError {
  /** Absolute path of the YAML that failed to parse. */
  path: string;
  /** Error message from `parseIssue` (or any other read-time failure). */
  message: string;
}

export interface HealResult {
  /** YAMLs successfully moved on this pass — both directions. */
  healed: HealedIssue[];
  /** Files we couldn't read or parse. The pass continues past each. */
  errors: HealError[];
}

/**
 * Scan `<repo>/.danxbot/issues/{open,closed}/` for YAMLs whose file
 * location disagrees with the YAML's `status`. Move each to its correct
 * bucket. Returns the actions taken so the caller can log them at info
 * level (and Phase 4 can emit dashboard `system_errors` events from the
 * same data).
 *
 * Caller responsibility:
 *   - Logging: `result.healed` at info, `result.errors` at warn.
 *   - Dashboard surface (Phase 4): `recordSystemError` from
 *     `result.errors` with `{source: "healer", severity: "warn"}`.
 *
 * Idempotency: re-running on a clean dir returns
 * `{healed: [], errors: []}`. Filenames not matching the active prefix's
 * `<PREFIX>-N` regex are skipped (matches the `epic-status` walker —
 * keeps the helper from touching stray drafts whose filenames are
 * slug-shaped).
 */
export function healLocalYamls(
  repoLocalPath: string,
  prefix: string,
): HealResult {
  const result: HealResult = { healed: [], errors: [] };

  const idRegex = buildIssueIdRegex(prefix);

  // ----- sweep 1: open/ → closed/ (terminal status flushed to closed) -----
  const openDir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (existsSync(openDir)) {
    for (const entry of readdirSync(openDir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      if (!idRegex.test(stem)) continue;
      const path = resolve(openDir, entry);

      let issue;
      try {
        issue = parseIssue(readFileSync(path, "utf-8"), {
          expectedPrefix: prefix,
        });
      } catch (err) {
        result.errors.push({ path, message: parseErrorMessage(err) });
        continue;
      }

      if (issue.status !== "Done" && issue.status !== "Cancelled") continue;
      const terminalStatus: "Done" | "Cancelled" = issue.status;

      // A terminal card has no live work — clear `dispatch` if it
      // lingered from a session that crashed before persisting. Mirrors
      // the `isDispatchSessionTerminal` clear inside `persistAfterSync`,
      // but scoped narrower: heal only fires for actual terminal status
      // (Done / Cancelled), not for Blocked / requires_human != null /
      // blocked != null (those stay in `open/` per spec).
      //
      // No `history[]` entry is emitted on this branch — the YAML's
      // status is already terminal and the file move is a janitorial
      // filesystem fix, not a state change. DX-147 AC #3 explicitly
      // calls for "no filesystem-noise entries".
      const persisted = issue.dispatch !== null ? { ...issue, dispatch: null } : issue;

      if (moveToClosedIfTerminal(repoLocalPath, persisted)) {
        result.healed.push({
          id: persisted.id,
          status: terminalStatus,
          direction: "open-to-closed",
        });
      }
    }
  }

  // ----- sweep 2: closed/ → open/ (drifted-back inverse heal, DX-147) -----
  const closedDir = resolve(repoLocalPath, ".danxbot", "issues", "closed");
  if (existsSync(closedDir)) {
    for (const entry of readdirSync(closedDir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      if (!idRegex.test(stem)) continue;
      const path = resolve(closedDir, entry);

      let issue: Issue;
      try {
        issue = parseIssue(readFileSync(path, "utf-8"), {
          expectedPrefix: prefix,
        });
      } catch (err) {
        result.errors.push({ path, message: parseErrorMessage(err) });
        continue;
      }

      // Closed/ YAML whose status is still terminal — file is in the
      // right bucket. No-op (idempotency).
      if (issue.status === "Done" || issue.status === "Cancelled") continue;

      // Real state delta: the card was once terminal (it lived in
      // closed/) but now carries a non-terminal status. Move it back to
      // open/ AND stamp a `worker:heal` `status_change` entry. The
      // `from` field is REQUIRED on `status_change`; we pick the most
      // recent terminal status from `history[]` if available, otherwise
      // default to "Done" (the filename-location heuristic — closed/
      // implies a prior terminal save, and Done is the more common one).
      const priorTerminal = inferPriorTerminalStatus(issue.history);
      const updated: Issue = {
        ...issue,
        history: appendHistory(issue.history, {
          timestamp: new Date().toISOString(),
          actor: "worker:heal",
          event: "status_change",
          from: priorTerminal,
          to: issue.status,
          note: "Healer moved closed → open to match status",
        }),
      };

      ensureIssuesDirs(repoLocalPath);
      const openPath = issuePath(repoLocalPath, updated.id, "open");
      writeFileSync(openPath, serializeIssue(updated));
      // Remove the closed copy AFTER the open write succeeds so a write
      // failure leaves the YAML recoverable from closed/ (consistent with
      // `moveToClosedIfTerminal`'s ordering).
      unlinkSync(path);
      result.healed.push({
        id: updated.id,
        status: updated.status,
        direction: "closed-to-open",
      });
    }
  }

  return result;
}

function parseErrorMessage(err: unknown): string {
  if (err instanceof IssueParseError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * One orphan claim cleared by `clearAssignedAgentOnDeletion` (the
 * dashboard's delete-agent cascade — DX-283). The shape predates the
 * DX-286 invariant heal; keeping the original name avoids churning the
 * `clearAssignedAgentOnDeletion` consumers.
 */
export interface OrphanAssignedAgentHeal {
  id: string;
  staleAgent: string;
}

export interface HealOrphanAssignedAgentsResult {
  /** Open YAMLs the scan looked at (parse-rejected files count too). */
  scanned: number;
  /** Cards whose orphan `assigned_agent` claim was cleared. */
  healed: OrphanAssignedAgentHeal[];
  /** Parse / write failures. The pass continues past each. */
  errors: HealError[];
}

/**
 * One outcome row from `healOrphanInvariantViolations`. The two `kind`
 * variants are the two XOR sides of the
 * `(dispatch !== null) === (assigned_agent !== null)` invariant.
 */
export interface InvariantHeal {
  id: string;
  /**
   * - `agent-without-dispatch` — `assigned_agent != null + dispatch == null`
   *   (DX-286 absorbed the standalone `healOrphanAssignedAgents` boot
   *   pass into this both-direction scan — same predicate + same
   *   `clearDispatchAndWrite` call, now reachable per-tick too).
   * - `dispatch-without-agent` — `dispatch != null + assigned_agent == null`
   *   (the DX-286 orphan pre-stamp direction). The dispatch's verdict is
   *   recorded so the operator-facing log line can name the failure mode.
   */
  kind: "agent-without-dispatch" | "dispatch-without-agent";
  /** Stale assigned_agent value when present, else null. */
  staleAgent: string | null;
  /** Stale dispatch.id when present, else null. */
  staleDispatchId: string | null;
  /**
   * Verdict from `checkYamlDispatchLiveness` when `dispatch != null`. When
   * the dispatch is null (kind === "agent-without-dispatch"), this is
   * undefined — there is no dispatch record to audit.
   */
  verdict?: "dead-pid" | "dead-ttl" | "cross-host";
}

export interface HealOrphanInvariantResult {
  /** Open YAMLs the scan looked at (parse-rejected files count too). */
  scanned: number;
  /** Cards whose invariant violation was cleared. */
  healed: InvariantHeal[];
  /** Parse / write failures. The pass continues past each. */
  errors: HealError[];
}

/**
 * Per-tick (and one-shot at boot) heal: walk
 * `<repo>/.danxbot/issues/open/` and clear any card violating the
 * `(dispatch !== null) === (assigned_agent !== null)` co-ownership
 * invariant when the underlying dispatch (if any) is verifiably dead.
 *
 * The invariant has two failure directions, both handled here:
 *
 *  1. `assigned_agent != null + dispatch == null` — orphan claim,
 *     DX-286 absorbed the standalone boot-only pass that previously
 *     handled this direction so per-tick + boot share one entry point.
 *  2. `dispatch != null + assigned_agent == null` — orphan pre-stamp
 *     (DX-286). The picker stamped the dispatch{} block with `pid: 0`,
 *     `assigned_agent` got cleared by some other path before the spawn
 *     enriched the PID, and the DB never carried a matching dispatch row.
 *     Cards in this state drop out of `listDispatchableYamls` (filter
 *     rejects `dispatch != null`) and are unrecoverable without
 *     intervention. Pre-DX-286, the only path to recovery was a worker
 *     restart triggering boot reattach's dead-pid clearing pass —
 *     production was accumulating 6+ such orphans per boot.
 *
 * Liveness gate: when `dispatch != null` AND the dispatch's PID is alive
 * on this host AND TTL has not expired, the card is left alone. The
 * in-flight dispatch will reconcile via its own onComplete chain. This
 * protects against killing a real dispatch caught mid-spawn (between
 * `stampDispatchAndWrite` and `pairedWriteHostPid`). Direction 1 has no
 * dispatch record so it always clears.
 *
 * Runs:
 *  - Once at worker startup, after `startIssuesMirror` (so the mirror's
 *    read-your-writes ack inside `writeIssue` resolves) and BEFORE the
 *    poller's first tick, to clean pre-fix-bug residue.
 *  - At the top of every `_poll` tick (DX-286), to catch new orphans
 *    before the picker sees them so the picker's `listDispatchableYamls`
 *    filter doesn't permanently lock them out.
 *
 * Idempotent: a follow-up run on already-healed YAMLs returns
 * `healed: []` (clearDispatchAndWrite short-circuits when both fields
 * are already null).
 *
 * Tracker-independent. Tolerates malformed YAMLs (returned in `errors[]`;
 * the pass continues).
 */
export async function healOrphanInvariantViolations(
  repoLocalPath: string,
  prefix: string,
  livenessDeps: LivenessDeps,
): Promise<HealOrphanInvariantResult> {
  const result: HealOrphanInvariantResult = {
    scanned: 0,
    healed: [],
    errors: [],
  };
  const idRegex = buildIssueIdRegex(prefix);
  const openDir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (!existsSync(openDir)) return result;

  for (const entry of readdirSync(openDir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    if (!idRegex.test(stem)) continue;
    const path = resolve(openDir, entry);
    result.scanned++;

    let issue: Issue;
    try {
      issue = parseIssue(readFileSync(path, "utf-8"), {
        expectedPrefix: prefix,
      });
    } catch (err) {
      result.errors.push({ path, message: parseErrorMessage(err) });
      continue;
    }

    const dispatchSet = issue.dispatch !== null;
    const agentSet = issue.assigned_agent !== null;
    // Invariant holds when both are null OR both are non-null. XOR =
    // violation worth investigating; equality = nothing to do.
    if (dispatchSet === agentSet) continue;

    if (dispatchSet) {
      // Direction 2: dispatch != null + assigned_agent == null. Skip
      // when the dispatch is genuinely live — the in-flight spawn is
      // mid-paired-write and will enrich/reconcile on its own.
      const verdict = checkYamlDispatchLiveness(issue.dispatch!, livenessDeps);
      if (verdict.kind === "alive") continue;
      try {
        const staleDispatchId = issue.dispatch!.id;
        await clearDispatchAndWrite(repoLocalPath, issue);
        result.healed.push({
          id: issue.id,
          kind: "dispatch-without-agent",
          staleAgent: null,
          staleDispatchId,
          verdict: verdict.kind,
        });
      } catch (err) {
        result.errors.push({ path, message: parseErrorMessage(err) });
      }
      continue;
    }

    // Direction 1: assigned_agent != null + dispatch == null. No
    // dispatch record to audit — clear immediately.
    const staleAgent = issue.assigned_agent!;
    try {
      await clearDispatchAndWrite(repoLocalPath, issue);
      result.healed.push({
        id: issue.id,
        kind: "agent-without-dispatch",
        staleAgent,
        staleDispatchId: null,
      });
    } catch (err) {
      result.errors.push({ path, message: parseErrorMessage(err) });
    }
  }
  return result;
}

const invariantHealLog = createLogger("invariant-heal");

/**
 * Convenience wrapper that runs `healOrphanInvariantViolations` against
 * the named repo with default liveness deps and emits the log lines both
 * the boot and per-tick callers need. Extracted so the producer + the
 * format live in one file (DX-286 review feedback) — boot in
 * `src/index.ts` and per-tick in `src/cron/sync-and-audit.ts` both call this
 * with a `label` describing the trigger so log readers can tell them
 * apart.
 *
 * Errors from the scan are caught + logged at error level; they never
 * propagate. The boot caller treats heal failure as non-fatal (the
 * worker still starts); the per-tick caller treats heal failure as
 * non-fatal (the tick still proceeds).
 */
export async function runInvariantHeal(
  repo: RepoContext,
  label: "boot" | "per-tick",
): Promise<void> {
  try {
    const result = await healOrphanInvariantViolations(
      repo.localPath,
      repo.issuePrefix,
      { currentHost: osHostname(), now: Date.now(), isPidAlive },
    );
    if (result.healed.length === 0 && result.errors.length === 0) return;
    if (result.healed.length > 0) {
      invariantHealLog.info(
        `[${repo.name}] Invariant heal (${label}): scanned=${result.scanned} cleared=${result.healed.length}`,
      );
      for (const h of result.healed) {
        const verdict = h.verdict ? ` verdict=${h.verdict}` : "";
        invariantHealLog.warn(
          `[${repo.name}] heal: cleared invariant violation on ${h.id} (kind=${h.kind}${verdict}, dispatch=${h.staleDispatchId ?? "null"}, agent=${h.staleAgent ?? "null"})`,
        );
      }
    }
    for (const e of result.errors) {
      invariantHealLog.warn(
        `[${repo.name}] heal: invariant scan error at ${e.path}: ${e.message}`,
      );
    }
  } catch (err) {
    invariantHealLog.error(
      `[${repo.name}] Invariant heal (${label}) failed`,
      err,
    );
  }
}

/**
 * Immediate-cascade counterpart to the `healOrphanInvariantViolations`
 * scan, called by the dashboard's delete-agent handler (DX-283). Walks
 * `<repo>/.danxbot/issues/open/` once and clears the `assigned_agent`
 * stamp on every YAML that names the just-deleted agent. Without this
 * cascade, the operator's delete leaves stale claims that block the
 * multi-agent picker until the next per-tick invariant scan picks up.
 *
 * Differs from the invariant heal in its predicate: this clears
 * strict-equality matches against `agentName`, regardless of `dispatch`
 * state. `dispatch != null` paired with
 * `assigned_agent === <deleted>` is the in-flight case — the worktree
 * teardown step (run before this in the delete handler) already
 * blocks deletion when a non-terminal dispatch exists for the agent,
 * so by the time we reach this point any `dispatch != null` we see
 * is itself orphan state. Clear both fields together (via
 * `clearDispatchAndWrite`) to preserve the
 * `assigned_agent ⇔ live dispatch` invariant.
 *
 * Idempotent: re-running on a clean dir returns `healed: []`.
 */
export async function clearAssignedAgentOnDeletion(
  repoLocalPath: string,
  prefix: string,
  agentName: string,
): Promise<HealOrphanAssignedAgentsResult> {
  const result: HealOrphanAssignedAgentsResult = {
    scanned: 0,
    healed: [],
    errors: [],
  };
  const idRegex = buildIssueIdRegex(prefix);
  const openDir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (!existsSync(openDir)) return result;

  for (const entry of readdirSync(openDir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    if (!idRegex.test(stem)) continue;
    const path = resolve(openDir, entry);
    result.scanned++;

    let issue: Issue;
    try {
      issue = parseIssue(readFileSync(path, "utf-8"), {
        expectedPrefix: prefix,
      });
    } catch (err) {
      result.errors.push({ path, message: parseErrorMessage(err) });
      continue;
    }

    if (issue.assigned_agent !== agentName) continue;

    try {
      await clearDispatchAndWrite(repoLocalPath, issue);
      result.healed.push({ id: issue.id, staleAgent: agentName });
    } catch (err) {
      result.errors.push({ path, message: parseErrorMessage(err) });
    }
  }
  return result;
}

/**
 * Filename-location heuristic for the `from` field of the `closed/` →
 * `open/` inverse-heal `status_change` entry. The card lived in `closed/`
 * before this drift, which means it was once Done or Cancelled.
 *
 *  1. **Primary** — most recent `status_change` entry in `history[]`
 *     whose `to` is terminal. This is the accurate path for any card
 *     written after DX-146 / DX-147 instrumented the worker save and
 *     hydrate paths; every realistic post-Phase-2 card has at least
 *     one such entry by the time it reaches `closed/`.
 *  2. **Legacy fallback** — `"Done"`. Fires only for pre-Phase-2 YAMLs
 *     (or hand-written test fixtures with empty history). Picked
 *     because Done is the more common terminal across the codebase;
 *     the alternative would be to fail the heal entirely, which is
 *     worse — losing audit fidelity is preferable to leaving a card
 *     stuck in `closed/`.
 *
 * Either way the function returns a definite `IssueStatus`, satisfying
 * `appendHistory`'s `status_change requires from` invariant.
 */
function inferPriorTerminalStatus(history: Issue["history"]): IssueStatus {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.event !== "status_change") continue;
    if (entry.to === "Done" || entry.to === "Cancelled") return entry.to;
  }
  return "Done";
}
