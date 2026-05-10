/**
 * Triage-precursor conflict-check (DX-200 / multi-worker dispatch epic
 * DX-158 Phase 5).
 *
 * The poller's pick step calls `runConflictCheck` BEFORE stamping
 * `assigned_agent` on a candidate card whenever:
 *
 *   1. At least one OTHER agent already has an in-progress dispatch on
 *      this repo, AND
 *   2. `agentDefaults.conflictCheckEnabled !== false` in
 *      `<repo>/.danxbot/settings.json` (defaults to `true`).
 *
 * The check spawns a short-lived Claude session in the
 * `issue-worker` workspace with `--conflict-check` mode injected into
 * the task prompt. The agent reads the staged candidate + every
 * in-progress YAML, infers file scope from each card's description /
 * Files section / AC, and returns a JSON verdict via
 * `danxbot_complete.summary`:
 *
 *   - `{ok: true, reason: "..."}` — no overlap; safe to dispatch the
 *     candidate.
 *   - `{ok: false, reason: "...", blocked_by: ["DX-N", ...]}` — likely
 *     file overlap; the picker stamps the candidate's `blocked` field
 *     and skips this tick. The blocked record's `by[]` references the
 *     overlapping in-progress card(s); the operator can review and
 *     manually unblock if the overlap is a false positive.
 *
 * Conservative behaviour: ANY failure mode (timeout, malformed JSON,
 * non-zero exit, missing summary) is treated as `ok: false`. Better to
 * defer a card by one tick than risk two agents stomping on the same
 * file. The runtime cap is 90s; longer than that is treated as
 * timeout.
 *
 * Why a separate dispatch instead of a sync helper:
 *   - File-overlap inference needs LLM judgment ("does 'dispatch
 *     pipeline' overlap with 'launcher.ts'?") that no static analyzer
 *     gives us.
 *   - Reusing the issue-worker workspace means no new MCP surface — the
 *     agent has the same tools the triage skill already uses.
 *   - The 90s cap + Haiku-class model size makes this cheap (~$0.005
 *     per check, vs. $1+ for a full dispatch). Operators can disable
 *     entirely via `agentDefaults.conflictCheckEnabled: false` for
 *     cost-sensitive deployments.
 */

import { resolve } from "node:path";
import { createLogger } from "../logger.js";
import { serializeIssue } from "../issue-tracker/yaml.js";
import type { DispatchInput, DispatchResult } from "./core.js";
import type { AgentJob } from "../agent/agent-types.js";
import type { Issue } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

const log = createLogger("conflict-check");

/**
 * Per-check budget. The dispatch's inactivity timer fires after this,
 * `dispatch()` SIGTERMs the agent, and `onComplete` resolves with a
 * non-completed status — the helper then maps that to a conservative
 * `ok: false`.
 */
export const CONFLICT_CHECK_TIMEOUT_MS = 90_000;

/** Verdict returned to the picker. */
export interface ConflictResult {
  ok: boolean;
  reason: string;
  /**
   * Issue ids of the in-progress cards that overlap with the
   * candidate. Populated only when `ok === false`. The picker stamps
   * these into the candidate's `blocked.by[]` (or its analogue) so the
   * dashboard surfaces the conflict reason.
   */
  blocked_by?: string[];
}

export interface RunConflictCheckDeps {
  /**
   * The dispatch entry point. Required — there is no default. Tests
   * pass a `vi.fn()`; production passes `dispatch` from `./core.js`.
   * Injecting the dispatch import keeps this module's load-time clean
   * of `dispatch/core.js` (which transitively requires `DANXBOT_DB_*`).
   */
  dispatch: (input: DispatchInput) => Promise<DispatchResult>;
  /**
   * Pre-generated dispatch id. Required because the staging path
   * (`/tmp/conflict-check/${DANXBOT_DISPATCH_ID}/`) is keyed off it,
   * and the caller needs the same value to clean up afterwards. The
   * dispatch core also uses this verbatim for the dispatches row.
   */
  dispatchId: string;
}

export interface RunConflictCheckInput {
  repo: RepoContext;
  candidate: Issue;
  inProgress: readonly Issue[];
}

const TASK_PROMPT_PREFIX =
  "Triage with --conflict-check using the danx-triage-card skill.";

/** Build the staged file payload for a conflict-check spawn. */
function buildStagedFiles(
  candidate: Issue,
  inProgress: readonly Issue[],
): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  out.push({
    path: "/tmp/conflict-check/${DANXBOT_DISPATCH_ID}/candidate.yml",
    content: serializeIssue(candidate),
  });
  inProgress.forEach((c, i) => {
    out.push({
      path: `/tmp/conflict-check/\${DANXBOT_DISPATCH_ID}/in-progress-${i}.yml`,
      content: serializeIssue(c),
    });
  });
  return out;
}

/**
 * Extract the JSON verdict from the agent's `danxbot_complete.summary`.
 * The skill is instructed to write a single JSON object; we accept
 * either bare JSON or JSON wrapped in a fenced ```json ... ``` block
 * (operators sometimes copy-paste from chat threads where the wrap
 * helps readability). Returns `null` on any parse failure — the caller
 * maps null to a conservative `ok: false`.
 */
export function extractJsonVerdict(summary: string | null): unknown | null {
  if (typeof summary !== "string" || summary.length === 0) return null;
  // Try fenced block first: ```json\n{...}\n```
  const fenced = /```json\s*\n([\s\S]*?)\n```/.exec(summary);
  const candidate = fenced ? fenced[1] : summary;
  // Find the FIRST top-level `{...}` substring — `JSON.parse` on the
  // raw summary fails when the agent prepends explanatory prose. We
  // look for a balanced `{...}` window that JSON.parse accepts.
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  // Try progressively shorter slices from `start` until JSON.parse
  // accepts. Capped at 100 attempts to avoid pathological inputs.
  for (let end = candidate.length; end > start; end--) {
    const slice = candidate.slice(start, end);
    try {
      return JSON.parse(slice);
    } catch {
      // continue scanning
    }
    if (candidate.length - end > 100) break;
  }
  // Final attempt: try the raw substring (in case parse can recover
  // from trailing whitespace / newlines).
  try {
    return JSON.parse(candidate.slice(start));
  } catch {
    return null;
  }
}

/**
 * Coerce an arbitrary parsed JSON into a `ConflictResult`. Null /
 * unrecognized shapes return null so the caller defaults to a
 * conservative `ok: false`.
 */
export function coerceVerdict(parsed: unknown): ConflictResult | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.ok !== "boolean") return null;
  const reason = typeof r.reason === "string" ? r.reason : "";
  const out: ConflictResult = { ok: r.ok, reason };
  if (!r.ok && Array.isArray(r.blocked_by)) {
    const ids: string[] = [];
    for (const id of r.blocked_by) {
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
    if (ids.length > 0) out.blocked_by = ids;
  }
  return out;
}

/**
 * Spawn a conflict-check dispatch and return its verdict. Conservative
 * on every failure mode.
 */
export async function runConflictCheck(
  input: RunConflictCheckInput,
  deps: RunConflictCheckDeps,
): Promise<ConflictResult> {
  const { repo, candidate, inProgress } = input;
  if (inProgress.length === 0) {
    return { ok: true, reason: "No in-progress siblings — nothing to conflict-check." };
  }
  const stagedFiles = buildStagedFiles(candidate, inProgress);
  const inProgressIds = inProgress.map((c) => c.id).join(", ");
  const task =
    `${TASK_PROMPT_PREFIX}\n\n` +
    `Candidate: ${candidate.id} (${candidate.title})\n` +
    `In-progress: [${inProgressIds}]\n\n` +
    `Read every staged YAML at /tmp/conflict-check/<dispatch-id>/. ` +
    `Decide whether the candidate's likely file scope overlaps with ` +
    `any in-progress card. Reply with a single JSON object via ` +
    `danxbot_complete.summary:\n` +
    `  {ok: true, reason: "..."} — no overlap detected\n` +
    `  {ok: false, reason: "...", blocked_by: ["DX-N", ...]} — overlap; candidate should wait`;

  // `dispatch()` resolves immediately after the agent spawns, with the
  // job's `status === "running"`. Completion arrives later via the
  // `onComplete` callback. We need to await the post-completion job to
  // see the agent's terminal status + final summary; reading `status`
  // straight off the resolved `dispatch()` promise gives us "running"
  // every time and would cause the picker to conservatively block
  // EVERY candidate (see DX-200 review).
  //
  // Race a `Promise<AgentJob>` populated from `onComplete` against a
  // wall-clock budget. The dispatch's own inactivity timer is set to
  // `CONFLICT_CHECK_TIMEOUT_MS` so the agent gets SIGTERM'd at that
  // boundary; we cap our wait slightly higher (+5s grace) to capture
  // the post-SIGTERM `onComplete` payload. If even the grace window
  // misses (dispatch handle leaked, monitoring crashed), the conservative
  // `ok: false` branch fires.
  const completionGraceMs = CONFLICT_CHECK_TIMEOUT_MS + 5_000;
  let resolveJob!: (j: AgentJob) => void;
  const jobPromise = new Promise<AgentJob>((res) => {
    resolveJob = res;
  });
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((res) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      res(null);
    }, completionGraceMs);
  });

  // Spawn the dispatch fire-and-forget. We fold its eventual outcome
  // into `jobPromise` via `onComplete`; any spawn-level rejection
  // (workspace resolve fail, OS spawn error, MCP probe failure)
  // resolves `jobPromise` to a synthetic failure record so the
  // Promise.race below sees a non-completed job and the conservative
  // ok=false branch fires.
  const dispatchPromise = deps.dispatch({
    repo,
    task,
    workspace: "issue-worker",
    overlay: {},
    timeoutMs: CONFLICT_CHECK_TIMEOUT_MS,
    maxRuntimeMs: CONFLICT_CHECK_TIMEOUT_MS,
    apiDispatchMeta: {
      trigger: "api",
      metadata: {
        endpoint: "internal:conflict-check",
        callerIp: null,
        statusUrl: null,
        initialPrompt: task.slice(0, 500),
      },
    },
    dispatchId: deps.dispatchId,
    stagedFiles,
    onComplete: (j) => {
      resolveJob(j);
    },
  });
  let spawnError: unknown = null;
  dispatchPromise.catch((err) => {
    spawnError = err;
    // Synthesize a "failed-to-spawn" job so Promise.race resolves and
    // the helper exits the wait loop without hanging until the grace
    // window times out.
    resolveJob({
      id: "spawn-failed",
      status: "failed",
      summary: null,
      startedAt: new Date(),
    } as unknown as AgentJob);
  });

  const j = await Promise.race([jobPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (spawnError !== null) {
    log.warn(
      `[${repo.name}] runConflictCheck dispatch threw — treating as conflict (conservative)`,
      spawnError,
    );
    return {
      ok: false,
      reason: `Conflict-check dispatch failed to spawn: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
    };
  }
  if (timedOut || j === null) {
    return {
      ok: false,
      reason: `Conflict-check exceeded ${completionGraceMs}ms grace window; treating as conflict (conservative)`,
    };
  }
  if (j.status !== "completed") {
    return {
      ok: false,
      reason: `Conflict-check did not complete cleanly (status=${j.status}, summary=${j.summary ?? "<empty>"}); treating as conflict (conservative)`,
    };
  }
  const parsed = extractJsonVerdict(j.summary ?? null);
  const verdict = parsed === null ? null : coerceVerdict(parsed);
  if (verdict === null) {
    return {
      ok: false,
      reason: `Conflict-check returned malformed JSON (summary=${(j.summary ?? "").slice(0, 120)}…); treating as conflict (conservative)`,
    };
  }
  return verdict;
}

/**
 * Helper for tests + diagnostics — assemble the staging directory the
 * dispatch will write into. Lives here (not the caller) so tests can
 * assert on the resolved path without round-tripping through the
 * placeholder substitution layer.
 */
export function conflictCheckStagingDir(dispatchId: string): string {
  return resolve("/tmp/conflict-check", dispatchId);
}
