/**
 * DX-563 (Phase 3 of DX-560 — Self-Repair): completion-side hook fired
 * from `handleStop` AFTER every terminal dispatch carrying an
 * `issueId`. Wraps the SQL that finalizes the `system_error_repairs`
 * row + the conditional `system_errors` status flip.
 *
 * The hook is a no-op for any dispatch whose `issueId` does NOT match a
 * repair row (Slack chats, ideator runs, plain feature work). The cost
 * is one indexed lookup per terminal dispatch.
 *
 * Idempotency:
 *
 *  - If the repair row's `ended_at` is already non-null, return
 *    `{kind: "already-finalized"}` and skip every other write. Phase 6
 *    layers cap enforcement on top and may re-poke `handleStop`; the
 *    same call must not double-write the report or re-flip a
 *    `system_errors` row a human already audited.
 *  - The error-status flip is skipped entirely when the verdict is
 *    `failed` — the error stays `open` so the next tick's pick query
 *    can dispatch attempt N+1 against it (until the 3-attempt cap that
 *    Phase 6 wires).
 *
 * Verdict parsing:
 *
 *  - Keyword match against the summary, case-insensitive. `unfixable`
 *    is matched BEFORE `fixed` because `unfixable` contains the
 *    substring `fixable` — order matters for the trap to fire
 *    correctly.
 *  - Default when no keyword matches: `failed`. The agent skill
 *    (Phase 4) will be the durable surface that constrains the
 *    summary to a verdict prefix; until that lands, `failed` is the
 *    conservative default that schedules a retry rather than flipping
 *    a still-broken category to fixed.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Pool } from "pg";
import type {
  SystemErrorStatus,
  SystemErrorRepairRow,
  SystemErrorRepairVerdict,
} from "./types.js";

/**
 * `nextErrorStatus` is `null` when the verdict leaves the error row
 * unchanged (the `failed` branch — Phase 6 owns any further status
 * transition). Non-null on `fixed` / `unfixable`.
 */
export type FinalizeResult =
  | { kind: "no-match" }
  | { kind: "already-finalized"; attemptId: number }
  | {
      kind: "finalized";
      attemptId: number;
      errorId: number;
      verdict: SystemErrorRepairVerdict;
      nextErrorStatus: SystemErrorStatus | null;
    };

export interface FinalizeSelfRepairInput {
  db: Pool;
  issueId: string;
  /** Agent's `summary` from `danxbot_complete`; may be null/empty. */
  summary: string | null | undefined;
  /** Repo's local checkout root — used to locate the candidate YAML. */
  repoLocalPath: string;
}

export async function finalizeSelfRepair(
  input: FinalizeSelfRepairInput,
): Promise<FinalizeResult> {
  const { db, issueId, summary, repoLocalPath } = input;

  const lookup = await db.query<SystemErrorRepairRow>(
    `
    SELECT id, error_id, attempt_n, card_id, dispatch_id,
           started_at, ended_at, verdict, report_md
    FROM system_error_repairs
    WHERE card_id = $1
    LIMIT 1
    `,
    [issueId],
  );
  if (lookup.rows.length === 0) return { kind: "no-match" };
  const row = lookup.rows[0];

  if (row.ended_at !== null) {
    return { kind: "already-finalized", attemptId: row.id };
  }

  const verdict = parseVerdictFromSummary(summary ?? null);
  const reportMd = readRepairReport(repoLocalPath, issueId) ?? (summary ?? "");

  await db.query(
    `
    UPDATE system_error_repairs
    SET verdict = $1, report_md = $2, ended_at = NOW()
    WHERE id = $3
    `,
    [verdict, reportMd, row.id],
  );

  const nextErrorStatus = computeErrorStatusFromVerdict(verdict);
  if (nextErrorStatus !== null) {
    await db.query(
      `UPDATE system_errors SET status = $1 WHERE id = $2`,
      [nextErrorStatus, row.error_id],
    );
  }

  return {
    kind: "finalized",
    attemptId: row.id,
    errorId: row.error_id,
    verdict,
    nextErrorStatus,
  };
}

/**
 * Keyword extractor for the `summary` field of `danxbot_complete`.
 *
 * Strict matcher — only the FIRST line is scanned, and matches use
 * word boundaries so casual prose mentioning a verdict keyword does
 * NOT trigger a false flip. The Phase-4 agent skill is expected to
 * write verdicts at the head of `summary` (e.g. `fixed: see retro`,
 * `unfixable: stack outside our control`, `failed: need more info`).
 * `VERDICT: <v>` prefix form is also accepted.
 *
 * Order matters — `unfixable` is checked BEFORE `fixed` so the
 * substring trap (`unfixable` contains `fixable`) does not
 * mis-classify an explicit `unfixable` verdict as `fixed`. Default
 * when no verdict keyword leads the first line: `failed` — the
 * conservative choice that schedules a retry instead of flipping a
 * still-broken category to `fixed`.
 */
export function parseVerdictFromSummary(
  summary: string | null | undefined,
): SystemErrorRepairVerdict {
  if (!summary) return "failed";
  const firstLine = summary.split(/\r?\n/, 1)[0].toLowerCase();
  // Strip optional `verdict:` prefix so `VERDICT: fixed` and `fixed`
  // are both accepted.
  const head = firstLine.replace(/^\s*verdict\s*:\s*/i, "");
  if (/\bunfixable\b/.test(head)) return "unfixable";
  if (/\bfixed\b/.test(head)) return "fixed";
  if (/\bfailed\b/.test(head)) return "failed";
  return "failed";
}

/**
 * Maps a Phase-3 verdict to the post-finalize `system_errors.status`
 * the hook stamps. The `failed` branch returns `null` — the error row
 * stays `repairing` (per AC5 of DX-563). Phase 6 wires the post-cap
 * flip from `repairing` (with 3 closed attempts) to `unfixable`.
 */
export function computeErrorStatusFromVerdict(
  verdict: SystemErrorRepairVerdict,
): SystemErrorStatus | null {
  switch (verdict) {
    case "fixed":
      return "fixed";
    case "unfixable":
      return "unfixable";
    case "failed":
      return null;
  }
}

const REPAIR_REPORT_HEADER_RE = /^##\s+Repair Report/m;

/**
 * Scan the candidate YAML's `comments[]` for the last entry whose
 * `text` opens with `## Repair Report`. Returns the entry's `text`
 * verbatim, or `null` when no such comment is present (caller falls
 * back to the agent's `summary`).
 *
 * Hand-rolled parser instead of `parseIssue` so this hook doesn't
 * pull the whole YAML validator stack into the worker's hot path. The
 * grep is loose but deterministic: top-level YAML keys `comments:`
 * begin a flow-mapping array whose entries each have a `text:` field;
 * we walk the entries in order and return the last `text` value that
 * starts with the header.
 */
function readRepairReport(
  repoLocalPath: string,
  issueId: string,
): string | null {
  const candidate = resolve(
    repoLocalPath,
    ".danxbot",
    "issues",
    "open",
    `${issueId}.yml`,
  );
  const closed = resolve(
    repoLocalPath,
    ".danxbot",
    "issues",
    "closed",
    `${issueId}.yml`,
  );
  const path = existsSync(candidate)
    ? candidate
    : existsSync(closed)
      ? closed
      : null;
  if (path === null) return null;

  try {
    const yamlText = readFileSync(path, "utf-8");
    // Loose parse via the `yaml` lib — round-trips block-scalars, quoted
    // strings, and flow mappings without a brittle hand-rolled regex.
    const parsed = parseYaml(yamlText) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const comments = (parsed as { comments?: unknown }).comments;
    if (!Array.isArray(comments)) return null;
    let last: string | null = null;
    for (const c of comments) {
      if (
        typeof c === "object" &&
        c !== null &&
        typeof (c as { text?: unknown }).text === "string"
      ) {
        const text = (c as { text: string }).text;
        if (REPAIR_REPORT_HEADER_RE.test(text)) last = text;
      }
    }
    return last;
  } catch {
    return null;
  }
}
