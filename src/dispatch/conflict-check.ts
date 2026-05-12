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
 * `danxbot_complete.summary`.
 *
 * Decision rule is intentionally PERMISSIVE — concurrent work on the
 * same repo is the normal case, and finalize-time rebase + conflict
 * resolution is the expected path for any same-file overlap. The agent
 * blocks only when (a) the two cards touch the same functions and the
 * edits are large/structural enough that a human merge would take real
 * effort, OR (b) one card has an explicit precedence dependency on the
 * other landing first. See the prompt body in `runConflictCheck` for
 * the full rule.
 *
 *   - `{ok: true, reason: "..."}` — proceed; if overlap exists,
 *     finalize-time rebase will resolve it.
 *   - `{ok: false, reason: "...", blocked_by: ["DX-N", ...]}` — heavy
 *     overlap or explicit precedence. The picker logs the rejection
 *     and skips this tick; the gate is TRANSIENT (re-evaluated next
 *     tick against the live in-progress set) — no persistent `blocked`
 *     stamp on the candidate YAML. See the `waiting_on` lifecycle
 *     comment in `multi-agent-pick.ts` for why we do not stamp
 *     persistent waits from this verdict.
 *
 * Failure modes (timeout, malformed JSON, non-zero exit, missing
 * summary) are treated as `ok: false` for safety, but the relaxed
 * prompt above means real verdicts default to `ok: true`. The runtime
 * cap is 90s; longer than that is treated as timeout.
 *
 * Why a separate dispatch instead of a sync helper:
 *   - File-overlap inference needs LLM judgment ("does 'dispatch
 *     pipeline' overlap with 'launcher.ts'?") that no static analyzer
 *     gives us.
 *   - Reusing the issue-worker workspace means no new MCP surface — the
 *     agent has the same tools the triage skill already uses.
 *   - The 5min cap (`CONFLICT_CHECK_TIMEOUT_MS`) on a Sonnet-pinned
 *     dispatch (`CONFLICT_CHECK_MODEL`) costs ~$0.05–0.20 per check —
 *     still <1/5th of a full dispatch and worth the extra reasoning
 *     quality for the wait-for gate. Operators can disable entirely
 *     via `agentDefaults.conflictCheckEnabled: false` for
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
export const CONFLICT_CHECK_TIMEOUT_MS = 300_000;

/**
 * Model pinned on every conflict-check spawn. Sonnet (rather than the
 * host's default) — verdict quality is the load-bearing axis here:
 * we need reliable judgment on "is this a real conflict or a same-file
 * coincidence" + the rigorous wait-for gate. Sonnet's reasoning is
 * worth the extra cost; conflict-checks are infrequent relative to
 * full dispatches and the alternative (a wrong block) costs an entire
 * tick of agent throughput.
 */
export const CONFLICT_CHECK_MODEL = "claude-sonnet-4-6";

/**
 * Verdict returned to the picker. Tagged union — exactly one of three
 * shapes:
 *
 *  - `kind: "ok"` — no overlap or a merge-resolvable overlap. Picker
 *    proceeds with the dispatch.
 *  - `kind: "conflict"` — heavy structural overlap. Picker stamps
 *    `candidate.conflict_on[]` with each `{id, reason}` in `partners`.
 *    Persistent — durable record on the YAML. Auto-clears (effective-
 *    wise) when the partner reaches terminal. No further Sonnet call
 *    needed next tick: the poller's eligibility filter handles it
 *    cheaply via `isEffectivelyConflicted`.
 *  - `kind: "wait_for"` — explicit precedence. The candidate's work
 *    structurally depends on the partner's runtime output (a
 *    contract, interface, migration, config key, schema field).
 *    Picker stamps `candidate.waiting_on = {reason, timestamp, by}`
 *    with the partner ids. Durable; effective-clears when every
 *    partner is terminal (`effectiveWaitingOn`).
 *
 * The agent MUST also include a `consumed_artifact` (wait_for only)
 * and a `cycle_audit.walked` list (wait_for only) so the picker can
 * defensive-re-check before stamping.
 *
 * Conservative-on-failure: any parse failure / coercion failure /
 * non-completed dispatch maps to `kind: "conflict"` with an empty
 * partner list — picker logs + skips this tick without writing
 * anything to disk (zero-partner stamp is a no-op).
 */
export type ConflictVerdict =
  | { kind: "ok"; reason: string }
  | {
      kind: "conflict";
      reason: string;
      partners: ConflictPartner[];
    }
  | {
      kind: "wait_for";
      reason: string;
      wait_for: string[];
      /** Specific artifact (interface name, migration, config key, API
       *  route, schema field, constant) the candidate consumes from the
       *  partners. Non-empty — vague "they're related" → must be
       *  `conflict` instead. */
      consumed_artifact: string;
      /** Ids the agent walked through `waiting_on.by[]` chains of each
       *  partner to confirm no transitive cycle back to the candidate.
       *  Picker re-walks this list as a defensive check before stamping. */
      cycle_audit: { walked: string[] };
    };

export interface ConflictPartner {
  id: string;
  reason: string;
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

/**
 * Build the conflict-check prompt body. Separated from `runConflictCheck`
 * so tests can snapshot it. Tagged-union verdict shape — see
 * `ConflictVerdict` for the full contract.
 */
export function buildConflictCheckPrompt(
  candidateId: string,
  candidateTitle: string,
  inProgressIds: string,
): string {
  return (
    `${TASK_PROMPT_PREFIX}\n\n` +
    `Candidate: ${candidateId} (${candidateTitle})\n` +
    `In-progress: [${inProgressIds}]\n\n` +
    `Read every staged YAML at /tmp/conflict-check/<dispatch-id>/. The\n` +
    `candidate is at \`candidate.yml\`; each in-progress sibling is at\n` +
    `\`in-progress-<i>.yml\`. Each in-progress sibling's \`waiting_on\`\n` +
    `field carries the chain you must walk for the cycle audit (below).\n\n` +
    `# Decision tree — DEFAULT IS \`kind: "ok"\`\n\n` +
    `Concurrent work is the normal case. Two cards editing the same\n` +
    `file is NOT a conflict — git auto-merges non-overlapping hunks and\n` +
    `the second-to-push agent rebases + resolves at finalize time.\n` +
    `That is the EXPECTED finalize path. Lean strongly toward \`ok\`.\n\n` +
    `Three possible verdicts; pick exactly one:\n\n` +
    `## (1) \`kind: "ok"\` — proceed\n\n` +
    `Use when ANY of:\n` +
    `  - Cards touch disjoint files / directories / repos.\n` +
    `  - Cards touch the same file but different functions / classes /\n` +
    `    sections (git auto-merges).\n` +
    `  - Cards touch the same function but the edits are small enough\n` +
    `    (textual conflict, <15 min human merge effort) that the second\n` +
    `    agent will resolve at finalize time without trouble.\n` +
    `  - Test file changes alongside production code on another card.\n\n` +
    `## (2) \`kind: "conflict"\` — heavy structural overlap, persistent\n\n` +
    `Use ONLY when ALL of:\n` +
    `  1. The two cards touch the SAME functions / classes / sections,\n` +
    `     AND\n` +
    `  2. The edits are LARGE OR STRUCTURAL — renames, signature\n` +
    `     changes, wholesale rewrites of shared logic, schema field\n` +
    `     renames, reordering of multi-step pipelines — such that a\n` +
    `     human merge would take meaningful effort (>15 min careful\n` +
    `     resolution, not a 1-minute textual pick-both), AND\n` +
    `  3. There is no clean way to split the work.\n\n` +
    `When you pick this verdict, the picker STAMPS\n` +
    `\`candidate.conflict_on[]\` PERSISTENTLY with each partner. This is\n` +
    `a durable record on the YAML — the next tick reads it from the DB\n` +
    `and skips dispatch CHEAPLY (no Sonnet call). The record stays as an\n` +
    `audit trail; the eligibility filter auto-clears it when the partner\n` +
    `reaches a terminal status. Stamping persistently means the cost of\n` +
    `a wrong conflict verdict is high — an operator must clear it from\n` +
    `the dashboard. Be confident.\n\n` +
    `## (3) \`kind: "wait_for"\` — explicit precedence, persistent\n\n` +
    `Use ONLY when ALL of the following pass a RIGOROUS gate. Default\n` +
    `to \`conflict\` (or \`ok\`) if any check fails:\n\n` +
    `  (a) **Cycle audit.** For each in-progress sibling X you'd put in\n` +
    `      \`wait_for\`, walk X's \`waiting_on.by[]\` chain transitively\n` +
    `      (each id maps back to a staged YAML — read them). If the\n` +
    `      candidate's id ever appears in X's transitive chain → CYCLE\n` +
    `      → demote to \`conflict\` immediately. Record the ids you\n` +
    `      walked in \`cycle_audit.walked\` so the picker can defensive-\n` +
    `      re-check.\n` +
    `  (b) **Specific consumed artifact.** Name the EXACT thing the\n` +
    `      candidate consumes from the partner: a type/interface name,\n` +
    `      a migration column, a config key, a schema field, an API\n` +
    `      route, a constant, a CLI flag. Put it in \`consumed_artifact\`\n` +
    `      — non-empty, named precisely. Vague "they're related" /\n` +
    `      "same module" / "both touch X" → NOT a wait_for → demote.\n` +
    `  (c) **Behavioral dependency, not textual.** The candidate must\n` +
    `      need the RUNTIME OUTPUT of the partner (the migration must\n` +
    `      have run, the new API must respond, the new config key must\n` +
    `      exist as a runtime value). If the candidate could merge-\n` +
    `      resolve and still work (textual conflict only), that is\n` +
    `      \`conflict\` (merge handles it), NOT \`wait_for\`.\n` +
    `  (d) **Default-deny on uncertainty.** Any "maybe" answer on (a),\n` +
    `      (b), or (c) → \`conflict\` (transient + cheap to recover) or\n` +
    `      \`ok\` (lean permissive) — NEVER \`wait_for\`.\n\n` +
    `When you pick this verdict, the picker STAMPS\n` +
    `\`candidate.waiting_on = {reason, timestamp, by: wait_for[]}\`\n` +
    `PERSISTENTLY. The waiting_on field is DURABLE — only the agent on\n` +
    `the candidate's next pickup can clear it (operators can too via the\n` +
    `dashboard). The poller skips dispatch until every \`wait_for[]\`\n` +
    `partner reaches Done / Cancelled. The picker re-walks your\n` +
    `\`cycle_audit.walked\` list defensively before stamping — if a cycle\n` +
    `is found there, the verdict is demoted to \`conflict\`.\n\n` +
    `# Verdict shape — single JSON object via \`danxbot_complete.summary\`\n\n` +
    `Pick ONE:\n\n` +
    `\`\`\`json\n` +
    `{"kind": "ok", "reason": "<one sentence>"}\n` +
    `\`\`\`\n\n` +
    `\`\`\`json\n` +
    `{"kind": "conflict",\n` +
    ` "reason": "<one sentence summarizing the heavy overlap>",\n` +
    ` "partners": [{"id": "DX-N", "reason": "<what overlaps with this partner>"}, ...]}\n` +
    `\`\`\`\n\n` +
    `\`\`\`json\n` +
    `{"kind": "wait_for",\n` +
    ` "reason": "<one sentence on the precedence>",\n` +
    ` "wait_for": ["DX-N", ...],\n` +
    ` "consumed_artifact": "<exact name of the type/interface/migration/config/route/field/constant>",\n` +
    ` "cycle_audit": {"walked": ["DX-X", "DX-Y", ...]}}\n` +
    `\`\`\``
  );
}

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
 * Coerce an arbitrary parsed JSON into a `ConflictVerdict`. Null /
 * unrecognized shapes return null so the caller defaults to a
 * conservative `{kind: "conflict"}` with zero partners (which the
 * picker treats as "skip this tick, write nothing").
 *
 * Accepts the three documented shapes:
 *   { kind: "ok", reason }
 *   { kind: "conflict", reason, partners: [{id, reason}, ...] }
 *   { kind: "wait_for", reason, wait_for: ["DX-N"], consumed_artifact,
 *     cycle_audit: { walked: [...] } }
 *
 * Strict validation — missing required fields demotes the verdict
 * (e.g. wait_for without consumed_artifact → conflict; conflict
 * without partners → null → caller default).
 */
export function coerceVerdict(parsed: unknown): ConflictVerdict | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  const reason = typeof r.reason === "string" ? r.reason : "";
  if (r.kind === "ok") {
    return { kind: "ok", reason };
  }
  if (r.kind === "conflict") {
    const partners = coercePartners(r.partners);
    if (partners.length === 0) return null;
    return { kind: "conflict", reason, partners };
  }
  if (r.kind === "wait_for") {
    const waitFor = coerceIdList(r.wait_for);
    if (waitFor.length === 0) return null;
    const consumedArtifact =
      typeof r.consumed_artifact === "string" &&
      r.consumed_artifact.trim().length > 0
        ? r.consumed_artifact
        : "";
    if (consumedArtifact === "") {
      // Demote — wait_for without a named artifact is too vague to
      // persistently park a card. Caller maps null → conservative
      // conflict-with-zero-partners (transient skip).
      return null;
    }
    const walked = Array.isArray(r.cycle_audit)
      ? coerceIdList(r.cycle_audit)
      : isPlainObject(r.cycle_audit)
        ? coerceIdList((r.cycle_audit as Record<string, unknown>).walked)
        : [];
    return {
      kind: "wait_for",
      reason,
      wait_for: waitFor,
      consumed_artifact: consumedArtifact,
      cycle_audit: { walked },
    };
  }
  return null;
}

function coercePartners(value: unknown): ConflictPartner[] {
  if (!Array.isArray(value)) return [];
  const out: ConflictPartner[] = [];
  const seen = new Set<string>();
  for (const e of value) {
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length === 0) continue;
    if (typeof o.reason !== "string" || o.reason.length === 0) continue;
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({ id: o.id, reason: o.reason });
  }
  return out;
}

function coerceIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Spawn a conflict-check dispatch and return its verdict. Conservative
 * on every failure mode.
 */
export async function runConflictCheck(
  input: RunConflictCheckInput,
  deps: RunConflictCheckDeps,
): Promise<ConflictVerdict> {
  const { repo, candidate, inProgress } = input;
  if (inProgress.length === 0) {
    return { kind: "ok", reason: "No in-progress siblings — nothing to conflict-check." };
  }
  const stagedFiles = buildStagedFiles(candidate, inProgress);
  const inProgressIds = inProgress.map((c) => c.id).join(", ");
  const task = buildConflictCheckPrompt(candidate.id, candidate.title, inProgressIds);

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
    model: CONFLICT_CHECK_MODEL,
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
      `[${repo.name}] runConflictCheck dispatch threw — treating as transient conflict (no persistent stamp)`,
      spawnError,
    );
    return conservativeTransient(
      `Conflict-check dispatch failed to spawn: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
    );
  }
  if (timedOut || j === null) {
    return conservativeTransient(
      `Conflict-check exceeded ${completionGraceMs}ms grace window; treating as transient conflict (no persistent stamp)`,
    );
  }
  if (j.status !== "completed") {
    return conservativeTransient(
      `Conflict-check did not complete cleanly (status=${j.status}, summary=${j.summary ?? "<empty>"}); treating as transient conflict (no persistent stamp)`,
    );
  }
  const parsed = extractJsonVerdict(j.summary ?? null);
  const verdict = parsed === null ? null : coerceVerdict(parsed);
  if (verdict === null) {
    return conservativeTransient(
      `Conflict-check returned malformed JSON (summary=${(j.summary ?? "").slice(0, 120)}…); treating as transient conflict (no persistent stamp)`,
    );
  }
  return verdict;
}

/**
 * Build the conservative-on-failure verdict — `kind: "conflict"` with
 * ZERO partners. The picker recognizes the empty partners list as
 * "skip this tick, write nothing" (no persistent stamp on the
 * candidate's `conflict_on[]`). Mirrors the pre-v7 transient skip
 * semantics so a flaky spawn / timeout / malformed verdict doesn't
 * mutate the YAML on disk — durable stamping requires a confident
 * non-empty partner list from the agent itself.
 */
function conservativeTransient(reason: string): ConflictVerdict {
  return { kind: "conflict", reason, partners: [] };
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
