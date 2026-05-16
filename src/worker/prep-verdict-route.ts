/**
 * Worker HTTP handler for `POST /api/prep-verdict/:dispatchId` (DX-294).
 *
 * The pre-dispatch prep agent (Phase 4 of DX-291) calls the
 * `danxbot_prep_verdict` MCP tool at the end of its run. The MCP server
 * POSTs the parsed payload here; this handler is the SINGLE place that
 * turns a verdict into:
 *
 *   - YAML side-effects on the candidate card
 *     (`<repo>/.danxbot/issues/open/<candidateId>.yml`):
 *       - `conflict_on` → append `{id, reason}` entries to the
 *         candidate's `conflict_on[]`, one per `conflict_with` id,
 *         deduped by id (first reason wins on subsequent re-POSTs).
 *       - `blocked` → stamp `status: "Blocked"` + `blocked:
 *         {reason, timestamp: now}`. Any existing `waiting_on` is
 *         preserved (independent field).
 *   - settings.json side-effect:
 *       - `abort` → `setAgentBroken(localPath, agentName, {reason,
 *         suggested_steps, set_at: now}, "worker")` so the picker
 *         skips this agent until cleared (DX-292's broken-state field).
 *   - dispatch lifecycle (DX-296: gated by `job.dispatchKind`, NOT
 *     repo-wide `prepMode`):
 *       - `ok` + `dispatchKind === "work"` → keep running (agent
 *         proceeds into `/danx-next`).
 *       - `ok` + `dispatchKind === "prep"` → `job.stop("completed",
 *         "prep ok (prep-only dispatch)")`.
 *       - `ok` + `dispatchKind === undefined` → keep running
 *         (defensive — see `decideDispatchLifecycle`).
 *       - `conflict_on` / `blocked` → `job.stop("completed", ...)`.
 *       - `abort` → `job.stop("failed", ...)`.
 *   - `job.prepVerdict` stash so the wrapping multi-agent-pick
 *     onComplete handler (Phase 5 of DX-291) reads the verdict directly
 *     without re-parsing the YAML / settings the route just stamped.
 *
 * The handler is intentionally idempotent on YAML mutation: a re-POST
 * of the same `conflict_on` verdict re-appends only the missing entries
 * (dedup by id; first reason wins). A re-POST of the same `blocked`
 * verdict overwrites the timestamp but leaves status + reason stable.
 * `abort` is non-idempotent on `set_at` (timestamp bumps); the picker's
 * filter cares about non-null, not timestamp freshness.
 *
 * **DB lookup is REQUIRED** even when `activeJobs` carries the job:
 * the route needs the candidate `issue_id` and the agent's `agent_name`
 * (when applicable) to know which YAML / settings record to mutate.
 * Both are dispatch-row fields the live job object does not carry.
 *
 * **Auth**: same per-dispatch-id contract as `/api/stop/...` — the
 * dispatchId is the bearer.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync } from "node:fs";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { getActiveJob } from "../dispatch/core.js";
import { getDispatchById } from "../dashboard/dispatches-db.js";
import {
  parsePrepVerdictArgs,
  mapTerminalVerdictToDispatchStatus,
  type PrepVerdict,
  type PrepVerdictPayload,
} from "../mcp/danxbot-prep-verdict.js";
import { parseIssue, IssueParseError } from "../issue-tracker/yaml.js";
import { issuePath, writeIssue } from "../poller/yaml-lifecycle.js";
import { stampIssueBlocked } from "../issue/stamp-blocked.js";
import {
  defaultBrokenEvaluator,
  setAgentBroken,
  type AgentBrokenState,
} from "../settings-file.js";
import type { Issue } from "../issue-tracker/interface.js";
import type { AgentJob } from "../agent/launcher.js";
import type { Dispatch } from "../dashboard/dispatches.js";
import type { RepoContext } from "../types.js";

const log = createLogger("worker-prep-verdict-route");

/**
 * Injectable deps for unit testing. Production handler uses the
 * defaults — `getDispatchById`, `getActiveJob`, `setAgentBroken`, raw
 * filesystem reads. Tests override each piece so the route logic can
 * be exercised against in-memory fixtures.
 */
export interface PrepVerdictDeps {
  getDispatch?: typeof getDispatchById;
  getJob?: (id: string) => AgentJob | undefined;
  setBroken?: typeof setAgentBroken;
  /**
   * Wall-clock used to stamp `blocked.at` + `broken.set_at`.
   * Defaults to `Date.now()`. Tests inject a frozen clock so
   * assertions stay deterministic across the route's reads/writes.
   */
  now?: () => number;
}

/**
 * Shape returned by `applyVerdictSideEffect` — captures what changed
 * on disk / in settings so the route's response body surfaces it.
 */
interface PrepVerdictAck {
  status: "applied";
  verdict: PrepVerdict;
  conflictsAppended: number;
  /**
   * Whether the route stamped (or refreshed) the candidate's
   * `waiting_on` record for a `waiting_on` verdict. Distinct from
   * `conflictsAppended` because `waiting_on` is a single struct
   * (not an array of entries) — the route either writes the full
   * record or no-ops when an identical record already exists.
   */
  waitingOnStamped: boolean;
  candidateBlocked: boolean;
  agentMarkedBroken: boolean;
  dispatchTerminal?: "completed" | "failed";
}

/**
 * Exhaustive guard for the verdict union. Forces a compile-time error
 * if a future verdict literal lands in `PREP_VERDICTS` without a
 * matching branch here.
 */
function assertNever(value: never, label: string): never {
  throw new Error(`${label}: unhandled verdict ${JSON.stringify(value)}`);
}

/**
 * Apply the `conflict_on` verdict. Reads + parses the candidate YAML,
 * appends one entry per `conflict_with` id (dedup against existing
 * `conflict_on[].id` so re-POSTs are idempotent — first reason wins),
 * writes back.
 *
 * Returns the count of newly-appended entries so the route's response
 * body can surface what actually landed.
 */
async function applyConflictOnVerdict(
  repo: RepoContext,
  candidateId: string,
  payload: Extract<PrepVerdictPayload, { verdict: "conflict_on" }>,
): Promise<number> {
  const partners = payload.conflict_with;
  const filePath = issuePath(repo.localPath, candidateId, "open");
  if (!existsSync(filePath)) {
    throw new Error(
      `candidate YAML not found at ${filePath} — cannot stamp conflict_on`,
    );
  }
  const issue = parseIssue(readFileSync(filePath, "utf-8"), {
    expectedPrefix: repo.issuePrefix,
  });
  const existing = new Set(issue.conflict_on.map((c) => c.id));
  const additions: { id: string; reason: string }[] = [];
  for (const id of partners) {
    if (existing.has(id)) continue;
    existing.add(id);
    additions.push({ id, reason: payload.reason });
  }
  if (additions.length === 0) return 0;
  const next: Issue = {
    ...issue,
    conflict_on: [...issue.conflict_on, ...additions],
  };
  // DX-552 — writeIssue upserts the DB row in lockstep with the file
  // write. A bare writeFileSync (the pre-DX-552 shape) leaves the DB
  // row stale, and the picker's onComplete → loadLocal → clearDispatch
  // chain reads that stale row and writes it back, clobbering this
  // stamp. The result is a verdict that "succeeds" while the candidate
  // YAML reverts to its pre-verdict state — the next picker tick
  // re-dispatches the same card, looping forever.
  await writeIssue(repo.localPath, next);
  return additions.length;
}

/**
 * Apply the `waiting_on` verdict. Reads + parses the candidate YAML,
 * stamps `waiting_on: {by, reason, timestamp: nowIso}`. Sequential
 * phase ordering primitive — Phase N+1 waits on Phase N. Distinct
 * from `conflict_on` (symmetric file-overlap mutex).
 *
 * Merge semantics: union the new `depends_on` ids with any existing
 * `waiting_on.by` set, dedup, preserve order (existing first, then
 * new additions in input order). When the result equals the
 * existing record (same ids, dedup-stable, same reason) the write
 * no-ops and the route's ack returns `waitingOnStamped: false`.
 *
 * Reason policy: on overwrite the new reason wins (mirrors
 * `applyBlockedVerdict`'s timestamp bump; the prep agent has the
 * freshest context). Timestamp ALWAYS updates on a state change.
 *
 * Status is NOT touched: `waiting_on` is independent of status (the
 * picker's `listDispatchableYamls` filter treats waiting_on as a
 * dispatch gate orthogonal to ToDo / In Progress / Blocked).
 *
 * Returns `true` when the YAML actually changed, `false` on no-op.
 */
async function applyWaitingOnVerdict(
  repo: RepoContext,
  candidateId: string,
  payload: Extract<PrepVerdictPayload, { verdict: "waiting_on" }>,
  nowIso: string,
): Promise<boolean> {
  const filePath = issuePath(repo.localPath, candidateId, "open");
  if (!existsSync(filePath)) {
    throw new Error(
      `candidate YAML not found at ${filePath} — cannot stamp waiting_on`,
    );
  }
  const issue = parseIssue(readFileSync(filePath, "utf-8"), {
    expectedPrefix: repo.issuePrefix,
  });
  const existingBy = issue.waiting_on?.by ?? [];
  const seen = new Set(existingBy);
  const mergedBy = [...existingBy];
  for (const id of payload.depends_on) {
    if (seen.has(id)) continue;
    seen.add(id);
    mergedBy.push(id);
  }
  const noChange =
    issue.waiting_on !== null &&
    issue.waiting_on.reason === payload.reason &&
    mergedBy.length === existingBy.length;
  if (noChange) return false;
  const next: Issue = {
    ...issue,
    waiting_on: {
      by: mergedBy,
      reason: payload.reason,
      timestamp: nowIso,
    },
  };
  // DX-552 — see applyConflictOnVerdict for why writeIssue (not
  // writeFileSync) is load-bearing here.
  await writeIssue(repo.localPath, next);
  return true;
}

/**
 * Apply the `blocked` verdict. Reads + parses the candidate YAML,
 * stamps `status: "Blocked"` + `blocked: {reason, at: nowIso}`,
 * writes back. Idempotent — re-POSTs bump the timestamp but leave the
 * card in Blocked. Any pre-existing `waiting_on` record is preserved
 * (independent durable dep-chain note; not coupled to status).
 */
async function applyBlockedVerdict(
  repo: RepoContext,
  candidateId: string,
  payload: Extract<PrepVerdictPayload, { verdict: "blocked" }>,
  nowIso: string,
): Promise<void> {
  await stampIssueBlocked({
    repoLocalPath: repo.localPath,
    candidateId,
    expectedPrefix: repo.issuePrefix,
    reason: payload.reason,
    at: nowIso,
  });
}

/**
 * Apply the `abort` verdict. Stamps `agents.<name>.broken =
 * {reason, suggested_steps, set_at}` so the picker skips this agent
 * until the operator clears the field. Precondition: `agentName` is
 * non-null (caller enforces).
 */
async function applyAbortVerdict(
  repoLocalPath: string,
  agentName: string,
  payload: Extract<PrepVerdictPayload, { verdict: "abort" }>,
  nowIso: string,
  setBroken: typeof setAgentBroken,
): Promise<AgentBrokenState> {
  const broken: AgentBrokenState = {
    reason: payload.reason,
    suggested_steps: payload.broken_details.suggested_steps,
    set_at: nowIso,
    // DX-364 — prep-verdict abort does NOT run an evaluator; banner
    // renders a static state. Phase 4 of DX-363 is the only writer
    // that stamps `"pending"` instead.
    ...defaultBrokenEvaluator(),
  };
  await setBroken(repoLocalPath, agentName, broken, "worker");
  return broken;
}

/**
 * Validate the per-verdict preconditions on the dispatch row. Returns
 * `null` when the preconditions hold; a `{status, error}` pair when
 * the route should reject with a 4xx. Separates "the row doesn't carry
 * the right context for this verdict" from "applying the side-effect
 * failed at IO time" (the latter surfaces as 5xx in the route's catch).
 */
function checkVerdictPreconditions(
  verdict: PrepVerdict,
  dispatch: Pick<Dispatch, "issueId" | "agentName">,
): { status: number; error: string } | null {
  if (
    verdict === "conflict_on" ||
    verdict === "waiting_on" ||
    verdict === "blocked"
  ) {
    if (!dispatch.issueId) {
      return {
        status: 400,
        error: `${verdict} verdict requires the dispatch row to carry issue_id (the candidate card) — got null`,
      };
    }
  }
  if (verdict === "abort" && !dispatch.agentName) {
    // 400 (not 500): a dispatch row without `agent_name` is a
    // precondition violation on the verdict — the agent shouldn't
    // have called `abort` from a non-agent-bound dispatch.
    return {
      status: 400,
      error:
        "abort verdict requires the dispatch row to carry agent_name — got null",
    };
  }
  return null;
}

/**
 * Apply the verdict's YAML / settings side-effect. Returns the ack
 * record describing what changed; throws on parse / IO failure.
 * Caller is responsible for verifying preconditions (issue_id /
 * agent_name) before invoking — `checkVerdictPreconditions` covers
 * that gate.
 */
async function applyVerdictSideEffect(
  payload: PrepVerdictPayload,
  repo: RepoContext,
  dispatch: Pick<Dispatch, "issueId" | "agentName">,
  nowIso: string,
  setBroken: typeof setAgentBroken,
): Promise<PrepVerdictAck> {
  const ack: PrepVerdictAck = {
    status: "applied",
    verdict: payload.verdict,
    conflictsAppended: 0,
    waitingOnStamped: false,
    candidateBlocked: false,
    agentMarkedBroken: false,
  };

  switch (payload.verdict) {
    case "ok":
      // No YAML / settings mutation — the dispatch lifecycle decision
      // is the only effect, handled by the caller after this function
      // returns.
      return ack;
    case "conflict_on":
      // Precondition gate ensures issueId is non-null.
      ack.conflictsAppended = await applyConflictOnVerdict(
        repo,
        dispatch.issueId!,
        payload,
      );
      return ack;
    case "waiting_on":
      ack.waitingOnStamped = await applyWaitingOnVerdict(
        repo,
        dispatch.issueId!,
        payload,
        nowIso,
      );
      return ack;
    case "blocked":
      await applyBlockedVerdict(repo, dispatch.issueId!, payload, nowIso);
      ack.candidateBlocked = true;
      return ack;
    case "abort":
      await applyAbortVerdict(
        repo.localPath,
        dispatch.agentName!,
        payload,
        nowIso,
        setBroken,
      );
      ack.agentMarkedBroken = true;
      return ack;
    default:
      return assertNever(
        payload,
        "applyVerdictSideEffect",
      );
  }
}

/**
 * Plan the dispatch lifecycle effect for a verdict WITHOUT executing
 * the `job.stop` side-effect yet. Returns the terminal status the ack
 * body surfaces plus a `runStop` closure the caller invokes AFTER the
 * HTTP response has been written.
 *
 * The two-phase shape is load-bearing for the prep agent's MCP wire
 * (DX-504 close-on-call class): `job.stop` reaps the prep dispatch's
 * cgroup via `systemctl --user stop`, which kills the in-flight MCP
 * server child making this verdict POST. Awaiting stop BEFORE writing
 * the response means the MCP server dies before receiving the ack —
 * Claude sees the MCP stdio close instead of the verdict result, and
 * the prep skill treats the call as failed. Compute the plan, write
 * the response, THEN await stop so the ack is on the wire before the
 * kill lands.
 *
 * `runStop === undefined` = keep dispatch running (only `ok` on
 * `dispatchKind: "work"` dispatches).
 *
 * DX-296 — branching is per-dispatch via `job.dispatchKind`, NOT the
 * repo-wide `prepMode` setting. The picker stamps `dispatchKind` on
 * every multi-agent-pick spawn:
 *   - `combined` mode → always `"work"` → dispatch keeps running on
 *     `ok`, agent proceeds to `/danx-next` in the same session.
 *   - `separate` mode + fresh card → `"prep"` → dispatch stops on
 *     `ok`, poller picks the card again next tick for the work pass.
 *   - `separate` mode + self-claim → `"work"` → dispatch keeps
 *     running on `ok`; this is the work-pass dispatch, the agent
 *     proceeds to `/danx-next`.
 *
 * `dispatchKind === undefined` (every non-multi-agent-pick caller —
 * Slack, ideator, external `/api/launch`, plus tests that bypass the
 * picker) falls back to the conservative "keep running" branch on
 * `ok` so a misconfigured prep dispatch can't accidentally finalize a
 * non-prep dispatch. Non-multi-agent-pick callers don't have the
 * prep-verdict tool advertised in the first place; the fallback is
 * defense in depth.
 */
function planDispatchLifecycle(
  payload: PrepVerdictPayload,
  job: AgentJob | undefined,
  dispatchId: string,
): {
  terminal?: "completed" | "failed";
  runStop?: () => Promise<void>;
} {
  if (payload.verdict === "ok") {
    if (job?.dispatchKind === "prep") {
      const summary = `prep ok (prep-only dispatch): ${payload.reason}`;
      return {
        terminal: "completed",
        runStop: async () => {
          await job.stop?.("completed", summary);
        },
      };
    }
    if (job !== undefined && job.dispatchKind === undefined) {
      log.warn(
        `[Dispatch ${dispatchId}] prep verdict=ok arrived against a dispatch with dispatchKind=undefined — keeping the dispatch running, but this dispatch should not have been able to call danxbot_prep_verdict. Investigate the caller's workspace MCP setup.`,
      );
    }
    return {};
  }
  const terminal = mapTerminalVerdictToDispatchStatus(payload.verdict);
  const summary =
    payload.verdict === "abort"
      ? `agent env aborted prep — see broken record: ${payload.reason}`
      : `prep ${payload.verdict}: ${payload.reason}`;
  return {
    terminal,
    runStop: async () => {
      await job?.stop?.(terminal, summary);
    },
  };
}

/**
 * POST /api/prep-verdict/:dispatchId — see file header for the full
 * verdict → side-effect contract. The handler is a thin orchestrator
 * over `parsePrepVerdictArgs` → `checkVerdictPreconditions` →
 * `applyVerdictSideEffect` → `decideDispatchLifecycle`.
 */
export async function handlePrepVerdict(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
  repo: RepoContext,
  deps: PrepVerdictDeps = {},
): Promise<void> {
  const getDispatch = deps.getDispatch ?? getDispatchById;
  const getJob = deps.getJob ?? getActiveJob;
  const setBroken = deps.setBroken ?? setAgentBroken;
  const now = deps.now ?? Date.now;

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (err) {
    json(res, 400, {
      error: err instanceof Error ? err.message : "Malformed body",
    });
    return;
  }

  let payload: PrepVerdictPayload;
  try {
    payload = parsePrepVerdictArgs(body, {
      issuePrefix: repo.issuePrefix,
    });
  } catch (err) {
    json(res, 400, {
      error: err instanceof Error ? err.message : "Malformed verdict payload",
    });
    return;
  }

  // DB lookup is required even when the in-memory job exists — we need
  // the candidate `issue_id` and the dispatch's `agent_name` to know
  // which YAML / settings record to mutate. Neither lives on
  // `AgentJob`.
  const dispatch = await getDispatch(dispatchId);
  if (!dispatch) {
    json(res, 404, { error: `Dispatch "${dispatchId}" not found` });
    return;
  }
  if (dispatch.repoName !== repo.name) {
    // Cross-worker guard — matches the Slack post handler's check.
    // The dispatches table is shared across workers; a foreign dispatch
    // would otherwise produce a confusing "candidate YAML not found"
    // when the issue genuinely lives in another repo's tree.
    json(res, 404, {
      error: `Dispatch "${dispatchId}" is not owned by this worker`,
    });
    return;
  }

  const precondition = checkVerdictPreconditions(payload.verdict, dispatch);
  if (precondition) {
    json(res, precondition.status, { error: precondition.error });
    return;
  }

  const nowIso = new Date(now()).toISOString();
  let ack: PrepVerdictAck;
  try {
    ack = await applyVerdictSideEffect(
      payload,
      repo,
      dispatch,
      nowIso,
      setBroken,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Prep verdict ${payload.verdict} failed for ${dispatchId}`, err);
    if (err instanceof IssueParseError) {
      json(res, 422, { error: `candidate YAML invalid: ${msg}` });
      return;
    }
    json(res, 500, { error: msg });
    return;
  }

  // Stash the verdict on the live job BEFORE stop() so the Phase 5
  // multi-agent-pick onComplete handler can read it directly. The
  // stop chain fires `onComplete(job)` AFTER status flips; stamping
  // here keeps that observer simple.
  const job = getJob(dispatchId);
  if (job) {
    job.prepVerdict = payload;
  }

  // Plan the lifecycle (pure), write the response, THEN execute the
  // stop. Order matters — see `planDispatchLifecycle` docstring for
  // the DX-504 close-on-call rationale. Awaiting stop before writing
  // would kill the prep dispatch's MCP-server child mid-fetch.
  const lifecycle = planDispatchLifecycle(payload, job, dispatchId);
  if (lifecycle.terminal) {
    ack.dispatchTerminal = lifecycle.terminal;
  }
  json(res, 200, ack);

  if (lifecycle.runStop) {
    try {
      await lifecycle.runStop();
    } catch (err) {
      log.error(
        `Prep verdict ${payload.verdict} stop failed for ${dispatchId}`,
        err,
      );
    }
  }
}
