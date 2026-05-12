/**
 * DX-294 — `danxbot_prep_verdict` MCP wire format + side-effect map.
 *
 * The pre-dispatch prep agent (Phase 4 of DX-291) signals its decision via
 * `danxbot_prep_verdict({verdict, reason, conflict_with?, broken_details?})`.
 * The MCP server POSTs the payload to the worker's
 * `POST /api/prep-verdict/<dispatchId>` endpoint; the worker's prep-verdict
 * handler applies the YAML / settings stamps and decides whether to keep
 * the dispatch running (combined-mode `ok`) or stop it (every other
 * verdict).
 *
 * This module is the single source of truth for:
 *   - The four verdict literals (`PrepVerdict`).
 *   - The argument validator (`parsePrepVerdictArgs`) — fail-loud on
 *     missing fields, fail-loud on the legacy `waiting_on` / `blocked_by`
 *     shape from before the 2026-05-12 rename so an agent stamped with
 *     stale skill text gets a usable error instead of a silent miss.
 *   - The verdict → terminal-status map (`mapVerdictToTerminal`) — same
 *     style as `mapCompleteToTerminalStatus` so the worker handler, the
 *     MCP fallback path, and the (future) boot-replay path agree on the
 *     consequences of each verdict.
 *   - The MCP-side fallback chain (`callDanxbotPrepVerdict`) — mirrors
 *     `callDanxbotComplete`: HTTP → filesystem queue at
 *     `<repo>/.danxbot/prep-verdicts/<dispatchId>.json`. The queue file
 *     is distinct from `dispatch-stops/` so completion and verdict
 *     queues never collide.
 *
 * Why the file is split out from `danxbot-server.ts`: keeps the server
 * file small (it already carries `danxbot_complete`'s lifecycle plus the
 * Slack / issue-create / restart tools) and lets the worker route +
 * unit tests import the validator + side-effect map without dragging in
 * the JSON-RPC dispatcher.
 */

import { join } from "node:path";
import { writeAtomicJsonQueueEntry } from "./danxbot-stop-fallback.js";

/**
 * Four-verdict surface produced by the prep agent. Renamed 2026-05-12:
 * `waiting_on` → `conflict_on` to match the v7 `Issue.conflict_on` field
 * (mutual exclusion, two-way enforcement, auto-resolves on partner
 * terminal). `waiting_on` is reserved for one-way precedence on the
 * Issue schema and was the wrong primitive here.
 */
export const PREP_VERDICTS = [
  "ok",
  "conflict_on",
  "blocked",
  "abort",
] as const;
export type PrepVerdict = (typeof PREP_VERDICTS)[number];

export function isPrepVerdict(value: unknown): value is PrepVerdict {
  return (
    typeof value === "string" &&
    (PREP_VERDICTS as readonly string[]).includes(value)
  );
}

/**
 * Parsed shape of the verdict payload — a discriminated union over
 * `verdict`. The per-branch fields are required-when-applicable so
 * the worker route + boot replay can do exhaustive switch handling
 * via TypeScript narrowing instead of runtime `?.` chains.
 *
 * `parsePrepVerdictArgs` is the single ingress that produces a value
 * of this shape; every other consumer (worker route,
 * `mapTerminalVerdictToDispatchStatus`, boot replay) trusts the union.
 */
export type PrepVerdictPayload =
  | { verdict: "ok"; reason: string }
  | {
      verdict: "conflict_on";
      reason: string;
      conflict_with: string[];
    }
  | { verdict: "blocked"; reason: string }
  | {
      verdict: "abort";
      reason: string;
      broken_details: { suggested_steps: string[] };
    };

/**
 * Set of keys `parsePrepVerdictArgs` accepts. Anything else on the
 * args object is a caller bug — likely a typo (`conflict_With` instead
 * of `conflict_with`) or a future rename that landed in the agent's
 * skill body without an MCP server update. Either silently dropping
 * the field on the floor would let the prep step appear to succeed
 * while landing zero YAML state — fail-loud per the `fail-loudly`
 * skill.
 */
const ALLOWED_PREP_VERDICT_KEYS = new Set([
  "verdict",
  "reason",
  "conflict_with",
  "broken_details",
]);

/**
 * Per-repo `<PREFIX>-N` shape — supplied by the caller so the parser
 * can validate `conflict_with` entries against the active repo's
 * issue prefix. Mirrors `ParseIssueOptions.expectedPrefix` from
 * `src/issue-tracker/yaml.ts`. Optional — when absent, the parser
 * checks only that entries are non-blank strings (back-compat for
 * callers that don't carry the repo context).
 */
export interface ParsePrepVerdictOptions {
  /** Required-when-non-empty: validates `conflict_with` entries match `^${prefix}-\d+$`. */
  issuePrefix?: string;
}

/**
 * Fail-loud argument validation. Throws an `Error` on any schema
 * violation; the JSON-RPC dispatcher in `danxbot-server.ts` maps the
 * throw to a `-32000` error so the agent sees the message verbatim and
 * can self-correct.
 *
 * Rejects two stale shapes from BEFORE the 2026-05-12 rename:
 *   - `verdict === "waiting_on"` → tell the caller to use
 *     `conflict_on` instead.
 *   - `blocked_by` arg → tell the caller to use `conflict_with` instead.
 *
 * Also rejects unknown keys outright (M4) — typos like
 * `conflict_With` would otherwise fall through silently and produce
 * an empty `conflict_on[]` write.
 *
 * Also validates `<PREFIX>-N` shape on each `conflict_with` entry
 * when `issuePrefix` is supplied (M3) — bogus ids would otherwise
 * round-trip through the YAML write and blow up on the NEXT parse
 * (next poller tick, chokidar mirror, etc.). Fail at the boundary the
 * agent can correct on the next turn, not silently land a corrupt YAML.
 */
export function parsePrepVerdictArgs(
  args: Record<string, unknown>,
  options: ParsePrepVerdictOptions = {},
): PrepVerdictPayload {
  // Legacy rename rejects — surface BEFORE the verdict enum check so an
  // agent that sends both the wrong verdict AND the wrong arg name gets
  // the rename hint, not a generic enum error.
  if (args.verdict === "waiting_on") {
    throw new Error(
      'danxbot_prep_verdict: verdict "waiting_on" was renamed to "conflict_on" on 2026-05-12 — use verdict: "conflict_on" with conflict_with: ["<PREFIX>-N", ...]',
    );
  }
  if (args.blocked_by !== undefined) {
    throw new Error(
      'danxbot_prep_verdict: arg "blocked_by" was renamed to "conflict_with" on 2026-05-12 — pass the partner ids as conflict_with: ["<PREFIX>-N", ...]',
    );
  }

  // Unknown-key reject. Fires AFTER the rename rejects above so the
  // agent gets the targeted rename hint when applicable, but BEFORE
  // every other check so a typo doesn't masquerade as "missing field".
  for (const key of Object.keys(args)) {
    if (!ALLOWED_PREP_VERDICT_KEYS.has(key)) {
      throw new Error(
        `danxbot_prep_verdict: unknown arg "${key}" — allowed keys are ${[
          ...ALLOWED_PREP_VERDICT_KEYS,
        ].join(", ")}`,
      );
    }
  }

  if (!isPrepVerdict(args.verdict)) {
    throw new Error(
      `danxbot_prep_verdict: verdict must be one of ${PREP_VERDICTS.join(
        ", ",
      )} (got ${JSON.stringify(args.verdict)})`,
    );
  }
  const verdict = args.verdict;

  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    throw new Error(
      "danxbot_prep_verdict: reason must be a non-empty string",
    );
  }
  const reason = args.reason;

  if (verdict === "conflict_on") {
    const raw = args.conflict_with;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(
        'danxbot_prep_verdict: conflict_with must be a non-empty array of issue ids when verdict === "conflict_on"',
      );
    }
    // Build the prefix-shape regex once outside the entry loop so a
    // 100-id list doesn't re-compile per entry. Skip when no prefix
    // supplied — back-compat for callers without repo context.
    const idShape = options.issuePrefix
      ? new RegExp(`^${options.issuePrefix}-\\d+$`)
      : null;
    for (const entry of raw) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(
          "danxbot_prep_verdict: every entry in conflict_with must be a non-empty issue id string",
        );
      }
      if (idShape && !idShape.test(entry)) {
        throw new Error(
          `danxbot_prep_verdict: conflict_with entry "${entry}" does not match the repo's <PREFIX>-N shape (expected ${options.issuePrefix}-N)`,
        );
      }
    }
    return { verdict, reason, conflict_with: raw as string[] };
  }

  if (verdict === "abort") {
    const raw = args.broken_details;
    if (raw === undefined || raw === null || typeof raw !== "object") {
      throw new Error(
        'danxbot_prep_verdict: broken_details is required when verdict === "abort"',
      );
    }
    const steps = (raw as Record<string, unknown>).suggested_steps;
    if (!Array.isArray(steps)) {
      throw new Error(
        "danxbot_prep_verdict: broken_details.suggested_steps must be an array",
      );
    }
    for (const step of steps) {
      if (typeof step !== "string") {
        throw new Error(
          "danxbot_prep_verdict: every broken_details.suggested_steps entry must be a string",
        );
      }
    }
    return {
      verdict,
      reason,
      broken_details: { suggested_steps: steps as string[] },
    };
  }

  return { verdict, reason };
}

/**
 * The terminal-status the dispatches row collapses to for a verdict
 * that ends the prep dispatch. `ok` is intentionally NOT in this map —
 * the worker handler decides between `keep running` (combined mode)
 * and `completed` (separate mode) at apply-time using the per-repo
 * `prepMode` setting (DX-292), which the MCP server doesn't have
 * access to.
 *
 *   - `conflict_on` → `completed` (prep finished cleanly, partner
 *     conflict surfaced).
 *   - `blocked` → `completed` (prep finished cleanly, candidate must
 *     wait for a human).
 *   - `abort` → `failed` (the prep environment itself is broken — the
 *     worker handler ALSO stamps `agents.<name>.broken` so the picker
 *     skips this agent until cleared).
 */
export function mapTerminalVerdictToDispatchStatus(
  verdict: Exclude<PrepVerdict, "ok">,
): "completed" | "failed" {
  return verdict === "abort" ? "failed" : "completed";
}

/**
 * Filesystem-queue directory for prep verdicts. Distinct from
 * `dispatch-stops/` so completion + verdict queues coexist without
 * filename collision. Boot replay (future follow-up) walks this dir
 * the way `replay-stop-queue.ts` walks `dispatch-stops/`.
 */
export const PREP_VERDICT_QUEUE_DIR = join(".danxbot", "prep-verdicts");

export interface PrepVerdictFsQueueShape {
  dispatchId: string;
  payload: PrepVerdictPayload;
}

/**
 * Atomic-rename write of a prep-verdict queue entry. Delegates to the
 * shared `writeAtomicJsonQueueEntry` primitive so the atomic-rename
 * pattern lives in one place (DRY against the completion queue at
 * `dispatch-stops/`).
 */
export function writePrepVerdictFsQueueEntry(
  shape: PrepVerdictFsQueueShape,
  repoRoot: string,
): boolean {
  return writeAtomicJsonQueueEntry(
    join(repoRoot, PREP_VERDICT_QUEUE_DIR),
    `${shape.dispatchId}.json`,
    {
      dispatchId: shape.dispatchId,
      payload: shape.payload,
    },
  );
}

/**
 * Per-dispatch context the MCP server uses to reach the prep-verdict
 * worker route + the fallback queue. Carried inside `DanxbotToolUrls`
 * and read by `callDanxbotPrepVerdict`.
 */
export interface PrepVerdictUrls {
  /** `http://localhost:<workerPort>/api/prep-verdict/<dispatchId>`. */
  url: string;
  /**
   * Fallback context — when the HTTP POST fails (worker down /
   * crashed), the MCP server writes a queue entry under
   * `<repoRoot>/.danxbot/prep-verdicts/<dispatchId>.json` for the
   * worker's boot replay (`src/worker/replay-prep-verdict-queue.ts`)
   * to consume.
   *
   * Reuses the same `repoRoot` + `dispatchId` the completion fallback
   * carries; piped in via the danxbot MCP server's env block at
   * dispatch time.
   *
   * No `db` field: verdict side-effects (conflict_on append, blocked
   * stamp, agents.broken stamp) cannot be reconstructed from a
   * dispatches-row UPDATE alone, so the fs queue is the only useful
   * boot-replay surface for this tool. The completion fallback
   * (`FallbackDbConfig`) carries a `db` field for a different reason
   * (it CAN flip the dispatches row terminal status without YAML
   * mutation) — that's not transferable here.
   */
  fallback?: {
    repoRoot?: string;
    dispatchId?: string;
  };
  /**
   * Per-repo issue prefix used to validate `conflict_with` entries
   * against the `^${prefix}-\d+$` shape. Threaded through from
   * `RepoContext.issuePrefix` via the danxbot MCP server's env block.
   * Optional — absent for non-worker test fixtures, in which case the
   * parser only checks "non-blank string" per entry.
   */
  issuePrefix?: string;
}

/**
 * MCP-side implementation of the `danxbot_prep_verdict` tool. Mirrors
 * `callDanxbotComplete` in `danxbot-server.ts`:
 *
 *   1. POST the parsed payload to the worker route. On 2xx → return
 *      the worker's ack so the agent sees the applied side-effect
 *      summary.
 *   2. On HTTP failure → write a filesystem queue entry under
 *      `<repoRoot>/.danxbot/prep-verdicts/<dispatchId>.json` and
 *      return an "operator boot replay" message.
 *   3. On both failures → throw with the full failure chain (the
 *      JSON-RPC dispatcher maps the throw to `-32000` so the agent
 *      sees it verbatim — fail-loud per the `fail-loudly` skill).
 */
export async function callDanxbotPrepVerdict(
  args: Record<string, unknown>,
  urls: PrepVerdictUrls,
): Promise<string> {
  const payload = parsePrepVerdictArgs(args, {
    ...(urls.issuePrefix ? { issuePrefix: urls.issuePrefix } : {}),
  });

  let primaryError: string | undefined;
  try {
    const response = await fetch(urls.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      const text = await response.text();
      // Return the worker's summary verbatim so the agent's tool call
      // result reflects exactly what the worker applied (e.g.
      // "Stamped DX-200 conflict_on with [DX-201]"). The route shape
      // is the contract; surfacing it raw avoids encoding it twice.
      return text || `prep verdict ${payload.verdict} accepted`;
    }
    primaryError = `Prep verdict API returned HTTP ${response.status}`;
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
  }

  const dispatchId = urls.fallback?.dispatchId;
  const repoRoot = urls.fallback?.repoRoot;
  if (!dispatchId || !repoRoot) {
    throw new Error(
      `Prep verdict API unreachable (${primaryError}) and no fallback context available — agent cannot signal verdict`,
    );
  }

  const queued = writePrepVerdictFsQueueEntry(
    { dispatchId, payload },
    repoRoot,
  );
  if (queued) {
    return (
      `Prep verdict ${payload.verdict} queued for boot replay (worker unreachable, ` +
      `wrote .danxbot/prep-verdicts/${dispatchId}.json): ${payload.reason}`
    );
  }

  throw new Error(
    `Prep verdict API unreachable (${primaryError}); filesystem queue also failed for dispatch ${dispatchId}`,
  );
}
