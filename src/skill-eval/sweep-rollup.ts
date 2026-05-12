/**
 * Sweep roll-up renderer for the `--all` sweep CLI.
 *
 * Pure markdown renderer + helpers. No filesystem, no network — the
 * CLI orchestrator (`run-all-sweep.ts`) wires the writer.
 *
 * `sanitizeErrorForGfm` is exported because category-prefixed entries
 * (`schema:` / `dispatch:`) build their message in `run-all-sweep.ts`
 * and must round-trip through the same sanitizer before landing in
 * the table cell. The codepoint-aware truncation defends against
 * surrogate-pair orphans (a single 🦀 spans two UTF-16 code units; a
 * naive `slice` would split one and render U+FFFD).
 */

import type { QueryVerdict, SideAccuracy } from "./aggregate.js";
import {
  formatCostUsd,
  formatElapsed,
  formatPercent,
} from "./markdown-format.js";

export type SweepStatus = "GREEN" | "FAIL" | "ERROR";

export interface SweepEntryResult {
  readonly pluginSkill: string;
  readonly evalSetDir: string;
  readonly evalSetPath: string;
  readonly overallPass: boolean;
  readonly train: SideAccuracy;
  readonly test: SideAccuracy;
  readonly runsPerQuery: number;
  readonly costUsd: number;
  readonly elapsedMs: number;
  readonly status: SweepStatus;
  readonly errorMessage?: string;
  readonly reportPath?: string;
  readonly trainVerdicts?: readonly QueryVerdict[];
  readonly testVerdicts?: readonly QueryVerdict[];
}

export const ERROR_MESSAGE_MAX_CODEPOINTS = 80;

/**
 * Sanitize a free-form error message for inclusion in a single GFM
 * table cell.
 *
 * Stripped characters and why:
 *   - `|`            — breaks the table column layout.
 *   - `\r` / `\n`    — breaks the table row layout.
 *   - `` ` ``         — would close an inline-code span and distort
 *                       neighbouring cells.
 *   - `[` / `]`      — would parse as a link reference, swallowing
 *                       surrounding text.
 *   - `*`            — would parse as bold/italic, distorting the cell.
 *
 * Truncation is codepoint-aware (`Array.from(raw).slice(0, N).join("")`)
 * so a surrogate pair at the boundary is treated as one codepoint and
 * never split into an orphan high/low surrogate.
 */
export function sanitizeErrorForGfm(raw: string): string {
  const codepoints = Array.from(raw);
  const truncated =
    codepoints.length > ERROR_MESSAGE_MAX_CODEPOINTS
      ? codepoints.slice(0, ERROR_MESSAGE_MAX_CODEPOINTS).join("")
      : raw;
  return truncated.replace(/[|\r\n`\[\]*]+/g, " ");
}

function formatSweepRow(e: SweepEntryResult): string {
  const trainCell =
    e.train.total === 0
      ? "—"
      : `${formatPercent(e.train.accuracy)} (${e.train.correct}/${e.train.total})`;
  const testCell =
    e.test.total === 0
      ? "—"
      : `${formatPercent(e.test.accuracy)} (${e.test.correct}/${e.test.total})`;
  const runsCell = e.runsPerQuery === 0 ? "—" : `${e.runsPerQuery}`;
  const costCell = formatCostUsd(e.costUsd);
  const elapsedCell = formatElapsed(e.elapsedMs);
  const statusCell =
    e.status === "ERROR" && e.errorMessage
      ? `ERROR (${sanitizeErrorForGfm(e.errorMessage)})`
      : e.status;
  const reportLink = e.reportPath ? ` ([REPORT.md](${e.reportPath}))` : "";
  return `| \`${e.pluginSkill}\`${reportLink} | ${trainCell} | ${testCell} | ${runsCell} | ${costCell} | ${elapsedCell} | ${statusCell} |`;
}

export interface RenderSweepRollupInput {
  readonly entries: readonly SweepEntryResult[];
  readonly totalCostUsd: number;
  readonly totalElapsedMs: number;
  readonly overallPass: boolean;
  readonly runAt: Date;
}

/**
 * Pure markdown renderer for the sweep roll-up. Writes a GFM table
 * with one row per entry and a summary block.
 *
 * `ERROR` rows surface the error message in the same Status column so
 * the operator can see why an eval-set was skipped without diffing
 * REPORT.md files.
 */
export function renderSweepRollup(input: RenderSweepRollupInput): string {
  const lines: string[] = [];
  lines.push("# Skill-eval --all sweep");
  lines.push("");
  lines.push(`**Overall: ${input.overallPass ? "PASS" : "FAIL"}**`);
  lines.push("");
  lines.push(`- Last run: \`${input.runAt.toISOString()}\``);
  lines.push(`- Eval-sets: \`${input.entries.length}\``);
  lines.push(`- Total cost: \`${formatCostUsd(input.totalCostUsd)}\``);
  lines.push(`- Total elapsed: \`${formatElapsed(input.totalElapsedMs)}\``);
  lines.push("");
  lines.push("## Per-skill summary");
  lines.push("");
  lines.push("| Skill | Train | Test | Runs | Cost | Elapsed | Status |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const e of input.entries) {
    lines.push(formatSweepRow(e));
  }
  if (input.entries.length === 0) {
    lines.push("");
    lines.push("_No eval-sets discovered. Check `--eval-sets-dir`._");
  }
  return lines.join("\n");
}
