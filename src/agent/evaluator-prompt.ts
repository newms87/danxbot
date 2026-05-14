/**
 * DX-367 — pure prompt builder for the system-evaluator dispatch.
 *
 * Extracted from `evaluator-dispatcher.ts` so the prompt's structure
 * stays pin-testable (the dashboard banner's markdown shape depends
 * on the headers this template emits) without dragging the
 * dispatcher's settings / dispatch surface into the unit under test.
 */

import type { AgentStrikeEntry } from "../settings-file.js";

/**
 * Maximum `raw_error` preview length per strike in the prompt body.
 * The evaluator agent reads the full JSONL session log via Bash/Read
 * once it locates the file by dispatch_id; the prompt's preview is
 * for orientation only, so 200 chars suffices.
 */
const RAW_ERROR_PREVIEW_LEN = 200;

export interface EvaluatorPromptInput {
  agentName: string;
  repoName: string;
  strikes: AgentStrikeEntry[];
}

/**
 * Build the dispatched system-evaluator's prompt body. The prompt is
 * the only place that names the target agent + repo + the 3 strike
 * dispatch ids — the worker route locates the target agent via
 * reverse lookup on `evaluator_dispatch_id`, so no agent_name
 * argument lives on the MCP tool.
 *
 * Locked test: `evaluator-prompt.test.ts` (header anchors + strike
 * line shape + truncation).
 */
export function buildEvaluatorPrompt(input: EvaluatorPromptInput): string {
  const strikeLines = input.strikes
    .map((s, i) => {
      const idx = i + 1;
      const errPreview = s.raw_error.slice(0, RAW_ERROR_PREVIEW_LEN) || "(empty)";
      return (
        `  ${idx}. dispatch_id=${s.dispatch_id} ` +
        `issue=${s.issue_id} ` +
        `status=${s.terminal_status} ` +
        `at=${s.timestamp}\n` +
        `     raw_error: ${errPreview}`
      );
    })
    .join("\n");

  return [
    `You are the system-evaluator agent (DX-367 — Phase 4 of DX-363).`,
    ``,
    `## Target`,
    ``,
    `- Repo: \`${input.repoName}\``,
    `- Agent: \`${input.agentName}\``,
    `- Strikes (most recent 3):`,
    strikeLines || `  (no strike history — defensive empty case)`,
    ``,
    `## Task`,
    ``,
    `Find the JSONL session log for each strike (\`grep -lr "danxbot-dispatch:<id>" ~/.claude/projects/ | head -1\`), read each one with the \`Read\` tool, identify the failure mode(s) across the 3 strikes, then call \`danxbot_set_evaluator_summary({reason, suggested_steps})\` with a structured markdown summary. A missing JSONL is a noted gap, not a fatal error — best-effort analyze what's available.`,
    ``,
    `Required \`reason\` markdown shape:`,
    ``,
    "```",
    `## Root cause(s)`,
    `<1–3 bullets identifying distinct root causes across the 3 strikes>`,
    ``,
    `## Per-strike detail`,
    `- Strike 1 (<issue-id>, <terminal-status>, <timestamp>): <2–3 sentences>`,
    `- Strike 2 (...): <2–3 sentences>`,
    `- Strike 3 (...): <2–3 sentences>`,
    ``,
    `## Recommended human action`,
    `<1 paragraph: what the operator should investigate / fix / decide>`,
    "```",
    ``,
    `\`suggested_steps\` is an ordered string array of concrete operator actions (empty array is allowed).`,
    ``,
    `After the summary write succeeds, call \`danxbot_complete({status: "completed", summary: "evaluator wrote root-cause summary"})\` and exit.`,
  ].join("\n");
}
