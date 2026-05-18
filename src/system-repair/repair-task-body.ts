/**
 * DX-651 (Phase 2 of DX-580) — pure inline-task body builder for the
 * Self-Repair worker-fault dispatcher.
 *
 * The dispatch is card-LESS — no YAML, no `issue_id`, no `parent_id`.
 * The unit of work is the `system_errors` row payload. This builder
 * encodes that row + the attempt number into a markdown prompt body
 * the `worker-repair` workspace's `CLAUDE.md` already documents the
 * verdict contract for (`fixed:` / `unfixable:` / `failed:` summary
 * prefixes on `danxbot_complete`).
 *
 * Extracted from the dispatcher so the prompt shape stays pin-testable
 * (the worker-repair `CLAUDE.md` references the header anchors this
 * template emits) without dragging the dispatcher's DB / dispatch
 * surface into the unit under test.
 */
import type { SystemErrorRow } from "./types.js";
import { REPAIR_CAP } from "./types.js";

export interface RepairTaskBodyInput {
  error: Pick<
    SystemErrorRow,
    | "id"
    | "signature_hash"
    | "category_key"
    | "component"
    | "err_class"
    | "normalized_msg"
    | "sample_payload"
    | "count"
    | "repo"
  >;
  attemptN: number;
}

/**
 * Render the inline task body. Includes signature hash, category key,
 * a JSON-pretty sample payload, and the verdict contract. The worker-
 * repair workspace's `CLAUDE.md` is the prose half — this builder is
 * the per-dispatch payload half.
 */
export function buildRepairTaskBody(input: RepairTaskBodyInput): string {
  const { error, attemptN } = input;
  const samplePayload = JSON.stringify(error.sample_payload, null, 2);
  // Pick a fence delimiter longer than the longest backtick run in the
  // payload — a stack trace or raw_msg containing ``` would otherwise
  // close the code fence early and corrupt the prompt. Markdown allows
  // arbitrary-length fences (open with N, close with N).
  const longestRun = samplePayload.match(/`+/g)?.reduce(
    (max, s) => Math.max(max, s.length),
    0,
  ) ?? 0;
  const fence = "`".repeat(Math.max(3, longestRun + 1));

  return [
    `You are the worker-repair agent (DX-651 — Phase 2 of DX-580).`,
    ``,
    `## Target`,
    ``,
    `- Repo: \`${error.repo}\``,
    `- Signature hash: \`${error.signature_hash}\``,
    `- Category key: \`${error.category_key}\``,
    `- Component: \`${error.component}\``,
    `- Error class: \`${error.err_class}\``,
    `- Normalized message: \`${error.normalized_msg}\``,
    `- Recurrence count: \`${error.count}\``,
    `- Attempt: \`${attemptN}\` of \`${REPAIR_CAP}\``,
    ``,
    `## Sample payload`,
    ``,
    `${fence}json`,
    samplePayload,
    fence,
    ``,
    `## Task`,
    ``,
    `Identify the worker-fault root cause in the danxbot source tree at \`$DANX_REPO_ROOT\`, ship a fix that makes the failing code path succeed AND adds (or extends) a unit test that pins the new behavior, commit the change, then call \`danxbot_complete\`.`,
    ``,
    `## Verdict contract`,
    ``,
    `\`danxbot_complete({status: "completed", summary: "<one of the three prefixes below>"})\`. The dispatcher inspects the summary prefix to categorize the outcome — wrong prefix = the dispatcher cannot finalize the repair row.`,
    ``,
    `- \`fixed: <one-sentence change summary> @ <commit-sha>\` — failing code path now works, unit test pins it, commit landed on \`origin/main\`.`,
    `- \`unfixable: <one-sentence reason>\` — root cause outside the danxbot source tree (3rd-party dep, claude CLI bug, OS-level breakage). Operator action required.`,
    `- \`failed: <one-sentence reason>\` — attempted a fix but tests / typecheck did not converge within budget. Operator should review the partial work in the JSONL.`,
    ``,
    `## Forbidden patterns`,
    ``,
    `- No YAML edits. No \`mcp__danx-issue__*\` calls. No \`danx_issue_create\`. This dispatch is card-less.`,
    `- No re-entry into \`dispatch()\` (no recursion via Slack tools, no new repairs).`,
    `- No silent fallbacks — fix the root cause, do not paper over with try/catch.`,
  ].join("\n");
}
