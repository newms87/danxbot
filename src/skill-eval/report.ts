/**
 * Markdown report renderer for the skill-eval harness.
 *
 * Pure function: takes already-aggregated `QueryVerdict`s + side
 * accuracies + run metadata, returns a markdown string. No IO, no
 * formatting library — handwritten markdown so the operator can read
 * the source string and know exactly what reaches the file.
 *
 * Report shape:
 *   # Skill-eval report: <plugin>:<skill>
 *   **Overall: PASS|FAIL**
 *   <parameters bullet list>
 *   ## Accuracy
 *   <2-row GFM table: train/test correct/total/percent>
 *   ## Failures        (omitted when zero failures)
 *   <one block per wrong verdict>
 */

import type { QueryVerdict, SideAccuracy } from "./aggregate.js";
import {
  formatCostUsd,
  formatElapsed,
  formatPercent,
} from "./markdown-format.js";

export interface ReportInput {
  readonly pluginSkill: string;
  readonly evalSetPath: string;
  readonly seed: number;
  readonly runsPerQuery: number;
  readonly trainVerdicts: readonly QueryVerdict[];
  readonly testVerdicts: readonly QueryVerdict[];
  readonly train: SideAccuracy;
  readonly test: SideAccuracy;
  readonly overallPass: boolean;
  readonly totalCostUsd: number;
  readonly pricingModel: string;
  readonly elapsedMs: number;
}

function classifyFailure(v: QueryVerdict): string {
  if (v.query.shouldTrigger && !v.triggered) return "false-negative";
  if (!v.query.shouldTrigger && v.triggered) return "false-positive";
  // `renderFailureBlock` only invokes this on `!v.correct` verdicts, so
  // `triggered === shouldTrigger` is unreachable here. Fail loud if a
  // future caller forgets the precondition — silent fallthrough to
  // "unexpected-classification" would render a bogus heading.
  throw new Error(
    `classifyFailure: called on a correct verdict (query="${v.query.query.slice(0, 40)}")`,
  );
}

function renderFailureBlock(side: string, v: QueryVerdict): string {
  const lines: string[] = [];
  lines.push(
    `### (${side}) ${classifyFailure(v)} — \`${v.query.query}\``,
  );
  lines.push("");
  lines.push(
    `- **Vote:** ${v.triggerCount} / ${v.totalRuns} runs triggered the expected skill`,
  );
  lines.push(`- **Expected should_trigger:** \`${v.query.shouldTrigger}\``);
  lines.push("");
  v.runs.forEach((r, i) => {
    lines.push(`Run ${i + 1} (jobId=\`${r.jobId}\`): ${r.triggered ? "triggered" : "did NOT trigger"}`);
    lines.push("");
    lines.push("```");
    lines.push(`reason: ${r.reason}`);
    if (r.skillCalls.length > 0) {
      lines.push(`observed_skills: ${r.skillCalls.join(", ")}`);
    }
    if (r.firstAssistantText) {
      lines.push(`first_assistant_text: ${r.firstAssistantText}`);
    }
    if (r.jsonlPath) {
      lines.push(`jsonl: ${r.jsonlPath}`);
    }
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# Skill-eval report: ${input.pluginSkill}`);
  lines.push("");
  lines.push(`**Overall: ${input.overallPass ? "PASS" : "FAIL"}**`);
  lines.push("");
  lines.push("## Parameters");
  lines.push("");
  lines.push(`- Eval-set: \`${input.evalSetPath}\``);
  lines.push(`- Seed: \`${input.seed}\``);
  lines.push(`- Runs per query: \`${input.runsPerQuery}\``);
  lines.push(`- Pricing model: \`${input.pricingModel}\``);
  lines.push(`- Elapsed: \`${formatElapsed(input.elapsedMs)}\``);
  lines.push(`- Total cost: \`${formatCostUsd(input.totalCostUsd)}\``);
  lines.push("");
  lines.push("## Accuracy");
  lines.push("");
  lines.push("| Side  | Correct | Total | Accuracy |");
  lines.push("| ----- | ------- | ----- | -------- |");
  for (const side of [input.train, input.test]) {
    lines.push(
      `| ${side.label} | ${side.correct} | ${side.total} | ${formatPercent(side.accuracy)} |`,
    );
  }
  lines.push("");

  // Failures section — emit only when there are wrong verdicts to show.
  const trainFailures = input.trainVerdicts.filter((v) => !v.correct);
  const testFailures = input.testVerdicts.filter((v) => !v.correct);
  if (trainFailures.length > 0 || testFailures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const v of trainFailures) lines.push(renderFailureBlock("train", v));
    for (const v of testFailures) lines.push(renderFailureBlock("test", v));
  }

  return lines.join("\n");
}
