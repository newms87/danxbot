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
  statSync,
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
import { deriveStatus } from "../issue/derive-status.js";
import {
  clearDispatchAndWrite,
  ensureIssuesDirs,
  issuePath,
  moveToClosedIfTerminal,
  writeIssue,
} from "./yaml-lifecycle.js";
import {
  checkYamlDispatchLiveness,
  type LivenessDeps,
} from "./dispatch-liveness-yaml.js";
import type { RepoContext } from "../types.js";
import { createLogger } from "../logger.js";
import { reportSystemError } from "../system-repair/report.js";

/**
 * One heal action recorded by `healLocalYamls`. The `direction` tag
 * disambiguates the typical `open/` → `closed/` move (terminal status
 * flushed to closed bucket) from the DX-147 inverse `closed/` → `open/`
 * move (status drifted back to non-terminal). Callers that log per-action
 * (e.g. the poller `runSync` block) can render direction-aware strings
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

      // DX-584 (Phase 4) — derived semantic state. A card whose
      // `completed_at` is set reads as Done, ditto cancelled_at →
      // Cancelled, both fall through to raw `status` for pre-Phase-4
      // cards. Either spelling triggers the heal.
      const derived = deriveStatus(issue);
      if (derived !== "Done" && derived !== "Cancelled") continue;
      const terminalStatus: "Done" | "Cancelled" = derived;

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

      // DX-584 (Phase 4) — derived semantic state. A closed YAML
      // whose derived state is still terminal is in the right bucket.
      // No-op (idempotency).
      const derivedClosed = deriveStatus(issue);
      if (derivedClosed === "Done" || derivedClosed === "Cancelled") continue;

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
 * One outcome row from `healOrphanInvariantViolations`.
 *
 *  - `dispatch-without-agent` — orphan pre-stamp where the dispatch
 *    slot was filled but the PID is not alive. Co-ownership invariant
 *    retired; this is the legacy-pre-stamp shape the scan still touches.
 *
 * DX-658 / Phase 2 of "Blocked becomes a dispatch gate, not a status"
 * retired the `blocked-with-assignment` branch — `"Blocked"` is no
 * longer an `IssueStatus`. The gate-vs-assignment invariant
 * (`blocked != null` ⇒ `assigned_agent: null`) is enforced by
 * reconcile's sub-step 3e instead, which keys on the field directly.
 */
export interface InvariantHeal {
  id: string;
  kind: "dispatch-without-agent";
  /** Always null with the retired direction-1 branch. Field kept for API stability. */
  staleAgent: null;
  /** Stale dispatch.id. */
  staleDispatchId: string;
  /** Verdict from `checkYamlDispatchLiveness`. */
  verdict: "dead-pid" | "dead-ttl" | "cross-host";
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
 * Pure-function heal: walk `<repo>/.danxbot/issues/open/` and clear
 * the `dispatch` slot on any card whose dispatch is verifiably dead
 * but still occupies the slot.
 *
 * The co-ownership invariant `(dispatch != null) ⇔ (assigned_agent != null)`
 * is RETIRED. `assigned_agent` is durable audit ("who last owned this
 * card") and is preserved across dispatch end + terminal save. The
 * only orphan shape this pass still touches is the pre-stamp direction:
 * `dispatch != null + dispatch is dead`, regardless of `assigned_agent`.
 * This catches:
 *   - The legacy unscoped pre-stamp path in `_processOneCard` that
 *     stamped a dispatch shell without actually spawning.
 *   - PID-died orphans from any path that didn't reach its own
 *     onComplete clear (worker crash mid-dispatch).
 *
 * Liveness gate: when the dispatch's PID is alive on this host AND TTL
 * has not expired, the card is left alone. The in-flight dispatch will
 * reconcile via its own onComplete chain.
 *
 * DX-641 Phase 3 folded the per-card invocation into `reconcileIssue`
 * sub-step 3d, and DX-663 retired the bulk per-tick + boot wrappers
 * in favor of the audit-pass per-card walk. DX-642 Phase 4 then folded
 * the audit-pass entry point INTO the issues-mirror's `periodicReconcile`
 * (`src/db/issues-mirror.ts`) — the per-minute sweep walks every open
 * YAML, mirrors it to the DB, and fires
 * `onReconcile(id, "audit")` → `reconcileIssue(card, "audit")`. This
 * function remains as the pure tested-in-isolation primitive — same
 * logic, kept here so the audit-pass fold doesn't lose dedicated
 * coverage.
 *
 * Idempotent: `clearDispatchAndWrite` short-circuits when dispatch is
 * already null. Tracker-independent. Tolerates malformed YAMLs.
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

    // DX-658 / Phase 2 — the `blocked-with-assignment` branch
    // (`status === "Blocked" + assigned_agent != null`) is retired.
    // Reconcile sub-step 3e enforces the field-keyed invariant
    // (`blocked != null` ⇒ `assigned_agent: null`) on every sweep
    // reconcile (DX-642 Phase 4 — fired from the issues-mirror's
    // `periodicReconcile`), so this per-tick scan only needs to cover
    // the dead-dispatch orphan case below.
    if (issue.dispatch === null) continue;

    const verdict = checkYamlDispatchLiveness(issue.dispatch, livenessDeps);
    if (verdict.kind === "alive") continue;

    try {
      const staleDispatchId = issue.dispatch.id;
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
  }
  return result;
}

const orphanIpHealLog = createLogger("orphan-ip-heal");

/**
 * Convenience wrapper that runs `healOrphanInProgress` against the
 * named repo with live dispatches-table queries + the operator's agent
 * roster from `<repo>/.danxbot/settings.json`. Boot + per-tick callers
 * both invoke this with a `label` so log lines disambiguate.
 *
 * Pre-DX-329 the orphan-IP shape was healed only by hand — five cards
 * (DX-275, DX-279, DX-310, DX-311, DX-313) were stranded at the time
 * the card was filed. The two-query DB read + roster read is cheap
 * (both hit indexed columns, <1ms even on a long-lived dispatches
 * table) and runs on every tick.
 *
 * Errors from the scan are caught + logged; they never propagate. The
 * per-tick + boot wrappers in `src/cron/sync-and-audit.ts` +
 * `src/index.ts` rely on this isolation contract.
 */
export async function runOrphanInProgressHeal(
  repo: RepoContext,
  label: "boot" | "per-tick",
  deps: {
    liveDispatchIssueIds: (repoName: string) => Promise<Set<string>>;
    lastTerminalDispatchStatusByIssue: (
      repoName: string,
    ) => Promise<Map<string, string>>;
    readAgents: (localPath: string) => Array<{ name: string }>;
  },
): Promise<void> {
  try {
    const [liveIssueIds, priorMap, agents] = await Promise.all([
      deps.liveDispatchIssueIds(repo.name),
      deps.lastTerminalDispatchStatusByIssue(repo.name),
      Promise.resolve(deps.readAgents(repo.localPath)),
    ]);
    const knownAgents = new Set(agents.map((a) => a.name));
    const result = await healOrphanInProgress(repo.localPath, repo.issuePrefix, {
      liveIssueIds,
      knownAgents,
      priorTerminalStatusFor: (id) => priorMap.get(id) ?? null,
      now: Date.now(),
      ageThresholdMs: ORPHAN_IP_AGE_THRESHOLD_MS,
    });
    if (result.healed.length === 0 && result.errors.length === 0) return;
    if (result.healed.length > 0) {
      orphanIpHealLog.info(
        `[${repo.name}] Orphan IP heal (${label}): scanned=${result.scanned} flipped=${result.healed.length}`,
      );
      for (const h of result.healed) {
        const prior = h.priorTerminalStatus ?? "never-dispatched";
        // `agentPreserved === false` ⇒ the card carried a non-null
        // `assigned_agent` that the roster doesn't recognize (see
        // `healOrphanInProgress`); `staleAgent` is the cleared name.
        // The preserved branch leaves `staleAgent: null`.
        const agentNote = h.agentPreserved
          ? "preserved"
          : `cleared (was ${h.staleAgent})`;
        orphanIpHealLog.warn(
          `[${repo.name}] heal: flipped orphan IP → ToDo on ${h.id} (prior=${prior}, assigned_agent=${agentNote})`,
        );
      }
    }
    for (const e of result.errors) {
      orphanIpHealLog.warn(
        `[${repo.name}] heal: orphan IP scan error at ${e.path}: ${e.message}`,
      );
      void reportSystemError({
        repo: repo.name,
        component: "orphan-ip-heal",
        err: new Error(e.message),
        samplePayload: { path: e.path },
      });
    }
  } catch (err) {
    orphanIpHealLog.error(
      `[${repo.name}] Orphan IP heal (${label}) failed`,
      err,
    );
    void reportSystemError({
      repo: repo.name,
      component: "orphan-ip-heal",
      err,
    });
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
 * Differs from `clearDispatchAndWrite` (which preserves
 * `assigned_agent` as durable audit): this path is invoked when the
 * agent has been deleted from the roster, so the stamp is no longer
 * meaningful audit — it's an orphan reference to a vanished persona.
 * Both `assigned_agent` and `dispatch` are nulled here. The worktree
 * teardown step (run before this in the delete handler) already
 * blocks deletion when a non-terminal dispatch exists for the agent.
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
      const cleared: Issue = { ...issue, assigned_agent: null, dispatch: null };
      await writeIssue(repoLocalPath, cleared);
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

/**
 * DX-329 — defaults for `healOrphanInProgress`. Five minutes is the
 * race-guard floor: a card flipped to `In Progress` within the last 5
 * minutes is still in the paired-write window for the legitimate
 * dispatch path (stamp → spawn → mirror upsert → dispatches row insert).
 * Heal must not fire there or it races a healthy dispatch. Anything
 * older AND lacking a live dispatch row is an orphan by every signal we
 * can see from the YAML + dispatches table.
 */
export const ORPHAN_IP_AGE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * One card flipped from `In Progress` back to `ToDo` by the orphan-IP
 * heal pass. `priorTerminalStatus` carries the most recent terminal
 * dispatch row's status (any value from `TERMINAL_STATUSES` in
 * `src/dashboard/dispatches.ts` — currently `completed` / `failed` /
 * `cancelled` / `recovered` / `throttled`) so the comment + log can
 * name what went wrong; `null` when no dispatch row ever existed (the
 * "stamped IP at
 * pickup but the spawn never landed a row" pathology).
 *
 * `agentPreserved` distinguishes the two AC #3 branches:
 *   - `true` — the named `assigned_agent` is still in the operator's
 *     roster (`<repo>/.danxbot/settings.json#agents`). The stamp survived
 *     the heal so the picker re-claims fast on the next tick.
 *   - `false` — the named agent has been deleted from the roster
 *     (vanished persona). The stamp is cleared and the card returns to
 *     the open pool. `staleAgent` carries the cleared name for the log.
 */
export interface HealedOrphanInProgress {
  id: string;
  /** Most recent terminal dispatch status for this card, or null. */
  priorTerminalStatus: string | null;
  /** `true` when `assigned_agent` survived the heal. */
  agentPreserved: boolean;
  /** Cleared agent name when `agentPreserved === false`, else null. */
  staleAgent: string | null;
}

export interface HealOrphanInProgressResult {
  /** Open YAMLs the scan looked at (parse-rejected files count too). */
  scanned: number;
  /** Cards flipped from IP back to ToDo. */
  healed: HealedOrphanInProgress[];
  /** Parse / write failures. The pass continues past each. */
  errors: HealError[];
}

/**
 * Dependency record for `healOrphanInProgress`. All inputs are injected
 * so the function stays pure for the unit test layer — the wrapper
 * (`runOrphanInProgressHeal` in `src/cron/sync-and-audit.ts`) supplies
 * the live values from the dispatches table + the settings file.
 */
export interface HealOrphanInProgressDeps {
  /**
   * Issue IDs that have at least one non-terminal dispatches row right
   * now. Same set `multi-agent-pick.ts` consults via
   * `liveDispatchIssueIds(repoName)` — race guard against an in-flight
   * dispatch caught between the YAML save and the dispatches row insert.
   */
  liveIssueIds: Set<string>;
  /**
   * Agent names that exist in `<repo>/.danxbot/settings.json#agents`.
   * Used to decide whether to preserve or clear `assigned_agent` on the
   * healed card (AC #3): preserve when the agent still exists, clear
   * when the named persona was deleted.
   */
  knownAgents: Set<string>;
  /**
   * Most recent terminal dispatch status for a given issue id, or `null`
   * when no dispatch row ever existed. Surfaces in the comment text so
   * the operator sees `recovered` vs `failed` vs `never-dispatched` at
   * a glance.
   */
  priorTerminalStatusFor: (issueId: string) => string | null;
  /** Epoch ms — test hook for `Date.now()`. */
  now: number;
  /** Minimum age in IP before heal applies. See `ORPHAN_IP_AGE_THRESHOLD_MS`. */
  ageThresholdMs: number;
}

/**
 * DX-329 — orphan In Progress heal pass. Walks
 * `<repo>/.danxbot/issues/open/` and flips `status: In Progress` → `ToDo`
 * for cards stranded with `dispatch: null` and no live dispatches row.
 *
 * The pre-existing `healOrphanInvariantViolations` already clears stale
 * `dispatch` blocks but never touches `status`. A card whose prior
 * dispatch ended in any terminal `DispatchStatus`
 * (`completed`/`failed`/`cancelled`/`recovered`/`throttled` per
 * `src/dashboard/dispatches.ts`) ends up at `status: In Progress` +
 * `dispatch: null` — the picker filter (`listDispatchableYamls` →
 * `i.status !== "ToDo"`) skips the card forever. Five cards were
 * stranded in production at the time DX-329 was filed (DX-275, DX-279,
 * DX-310, DX-311, DX-313); each had to be re-dispatched by hand. This
 * pass closes the loop.
 *
 * **Eligibility** — every predicate must hold:
 *
 *   - `status === "In Progress"`
 *   - `dispatch === null` (invariant heal owns the other branch)
 *   - `liveIssueIds.has(issue.id) === false` — no non-terminal
 *     dispatches row right now. Catches the legitimate paired-write
 *     race window where the YAML has been written but the dispatches
 *     row is still pending.
 *   - card age in IP > `deps.ageThresholdMs` — defense in depth
 *     against the same race. Age is taken from the most recent
 *     `status_change` history entry whose `to === "In Progress"`; when
 *     history is silent, falls back to file mtime so legacy YAMLs
 *     written before history was instrumented still get a sane signal.
 *
 * **Action** for each eligible card:
 *
 *   1. `status: "ToDo"`.
 *   2. `assigned_agent` preserved when the named agent is in
 *      `deps.knownAgents`; cleared otherwise.
 *   3. Append one `comments[]` entry titled `## Auto-heal — flipped IP
 *      → ToDo (orphan dispatch)` citing the prior terminal status (any
 *      value from `TERMINAL_STATUSES`) or `never-dispatched` when no
 *      dispatch row exists.
 *   4. Append one `worker:heal` `status_change` history entry
 *      (`from: "In Progress"`, `to: "ToDo"`) — the same actor + event
 *      shape the closed→open inverse heal uses (DX-147).
 *   5. Persist via `writeIssue`. The chokidar mirror picks up the
 *      write and the picker observes the new ToDo card on its next
 *      tick.
 *
 * Idempotent: re-running on a healed dir is a no-op (the second pass
 * sees the card at `status: "ToDo"` and skips). Tracker-independent.
 * Tolerates malformed YAMLs.
 */
export async function healOrphanInProgress(
  repoLocalPath: string,
  prefix: string,
  deps: HealOrphanInProgressDeps,
): Promise<HealOrphanInProgressResult> {
  const result: HealOrphanInProgressResult = {
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

    // DX-584 (Phase 4) — derived semantic state. A card whose
    // `completed_at` / `cancelled_at` / `blocked.at` is set is no
    // longer "In Progress" semantically even if the raw `status`
    // field still says so.
    if (deriveStatus(issue) !== "In Progress") continue;
    // Invariant heal owns the `dispatch != null` branch. Splitting the
    // responsibilities keeps each pass simple and prevents double
    // mutation on the same tick.
    if (issue.dispatch !== null) continue;
    if (deps.liveIssueIds.has(issue.id)) continue;

    const ageMs = computeInProgressAgeMs(issue, path, deps.now);
    if (ageMs < deps.ageThresholdMs) continue;

    const priorTerminalStatus = deps.priorTerminalStatusFor(issue.id);
    const staleAgent = issue.assigned_agent;
    const agentPreserved =
      staleAgent !== null && deps.knownAgents.has(staleAgent);

    try {
      const updated = applyOrphanInProgressHeal(issue, {
        priorTerminalStatus,
        agentPreserved,
        now: new Date(deps.now).toISOString(),
      });
      await writeIssue(repoLocalPath, updated);
      result.healed.push({
        id: issue.id,
        priorTerminalStatus,
        agentPreserved,
        staleAgent: agentPreserved ? null : staleAgent,
      });
    } catch (err) {
      result.errors.push({ path, message: parseErrorMessage(err) });
    }
  }
  return result;
}

/**
 * Mutation half of `healOrphanInProgress`. Splits out from the I/O
 * loop so the heal payload is unit-testable in isolation and so the
 * comment + history shape lives in one place — the in-the-wild log
 * formatter and the round-trip parser both read the same string.
 *
 * Reason string surfaces in the comment text. `recovered` / `failed` /
 * `cancelled` / `timeout` / `throttled` pass through verbatim
 * (matches the dispatches table's status column); `null` becomes
 * `never-dispatched` for the human-facing render.
 */
function applyOrphanInProgressHeal(
  issue: Issue,
  args: {
    priorTerminalStatus: string | null;
    agentPreserved: boolean;
    now: string;
  },
): Issue {
  const reasonForComment =
    args.priorTerminalStatus === null
      ? "never-dispatched"
      : args.priorTerminalStatus;
  const commentText = [
    "## Auto-heal — flipped IP → ToDo (orphan dispatch)",
    "",
    `Card was stuck at \`status: In Progress\` with \`dispatch: null\` and no live dispatches row. Prior dispatch terminal status: **${reasonForComment}**. The picker filter requires \`status === "ToDo"\`, so this card was invisible to the dispatch loop until the heal pass flipped it back.`,
  ].join("\n");
  const commentAppended = [
    ...issue.comments,
    { author: "danxbot", timestamp: args.now, text: commentText },
  ];
  const historyAppended = appendHistory(issue.history, {
    timestamp: args.now,
    actor: "worker:heal",
    event: "status_change",
    from: "In Progress",
    to: "ToDo",
    note: `Healer flipped orphan IP card back to ToDo (prior dispatch: ${reasonForComment})`,
  });
  return {
    ...issue,
    status: "ToDo",
    assigned_agent: args.agentPreserved ? issue.assigned_agent : null,
    comments: commentAppended,
    history: historyAppended,
  };
}

/**
 * Compute the card's age in `In Progress`. Primary signal — most recent
 * `status_change` history entry whose `to === "In Progress"`. Fallback
 * — file mtime (legacy YAMLs written before history was instrumented
 * may have empty history; the file's last-write time is the closest
 * we have to "when did this card last transition"). The fallback
 * protects recent untimed files from being healed on every tick.
 */
function computeInProgressAgeMs(
  issue: Issue,
  path: string,
  now: number,
): number {
  for (let i = issue.history.length - 1; i >= 0; i--) {
    const entry = issue.history[i];
    if (entry.event !== "status_change") continue;
    if (entry.to !== "In Progress") continue;
    const ms = Date.parse(entry.timestamp);
    if (Number.isFinite(ms)) return Math.max(0, now - ms);
  }
  try {
    const stat = statSync(path);
    return Math.max(0, now - stat.mtimeMs);
  } catch {
    // File vanished mid-scan (e.g. another writer moved it). Treat as
    // age=0 → skip; the next tick will reconsider.
    return 0;
  }
}
