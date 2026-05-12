/**
 * Description proposer — Haiku-driven SKILL.md description rewriter.
 *
 * Given the current description text and a list of TRAIN failures
 * (queries the harness ran that returned the wrong verdict), the
 * proposer asks Claude Haiku for a tighter description that closes
 * those gaps without sprawling.
 *
 * The Haiku call is wrapped in a `ProposerFn` so the iteration loop
 * can inject a mock in tests (the orchestrator never imports
 * Anthropic directly). Two pure helpers — `buildProposerPrompt` and
 * `parseProposerResponse` — are exposed for unit testing without an
 * API call.
 *
 * Cost: ~$0.01 per call (small prompt, small response, Haiku tier).
 * Held-out test set is NOT shown to the proposer — that's the
 * overfitting defense; the proposer sees train failures only.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  MAX_DESCRIPTION_LENGTH,
} from "./description-editor.js";

export class DescriptionProposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptionProposerError";
  }
}

export type FailureSide = "trigger" | "no-trigger";

export interface TrainFailure {
  readonly query: string;
  readonly expected: FailureSide;
  readonly observed: FailureSide;
}

export interface ProposerInput {
  readonly pluginSkill: string;
  readonly currentDescription: string;
  readonly trainFailures: readonly TrainFailure[];
  readonly attempt: number;
}

export interface ProposerOutput {
  readonly newDescription: string;
}

export type ProposerFn = (input: ProposerInput) => Promise<ProposerOutput>;

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 1500;

export function buildProposerPrompt(input: ProposerInput): string {
  if (input.trainFailures.length === 0) {
    throw new DescriptionProposerError(
      "no train failures to propose against — caller should NOT have invoked the proposer at 100% train accuracy",
    );
  }

  const falseNegatives = input.trainFailures.filter(
    (f) => f.expected === "trigger" && f.observed === "no-trigger",
  );
  const falsePositives = input.trainFailures.filter(
    (f) => f.expected === "no-trigger" && f.observed === "trigger",
  );

  const fnSection =
    falseNegatives.length > 0
      ? [
          "## MISSED (false negatives — SHOULD have triggered, did NOT):",
          ...falseNegatives.map((f, i) => `${i + 1}. ${JSON.stringify(f.query)}`),
        ].join("\n")
      : "(no false negatives in this iteration)";

  const fpSection =
    falsePositives.length > 0
      ? [
          "## EXTRA (false positives — should NOT have triggered, DID):",
          ...falsePositives.map((f, i) => `${i + 1}. ${JSON.stringify(f.query)}`),
        ].join("\n")
      : "(no false positives in this iteration)";

  return [
    `You are tuning the SKILL.md description for the Claude Code plugin skill ${input.pluginSkill}.`,
    `This is iteration / attempt ${input.attempt} of a description-tightening loop.`,
    "",
    "Your goal: produce a TIGHTER description that closes the gaps revealed by the TRAIN failures below.",
    "",
    "## Current description",
    "```",
    input.currentDescription,
    "```",
    "",
    fnSection,
    "",
    fpSection,
    "",
    "## Output requirements",
    "",
    `- Reply with the new description wrapped in <description>...</description> tags.`,
    `- The new description MUST be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`,
    "- Edit ONLY the description text. Do not propose changes to the skill body, name, or other frontmatter fields.",
    "- Keep the description in the same general voice/format as the current one (MANDATORY/discipline phrasing, trigger-pattern lists, etc.).",
    "- Surface the discriminating cues that would have flipped each MISSED query to a trigger AND each EXTRA query to a non-trigger.",
    "- Do not add reasoning prose outside the tags — only the tag pair and its content.",
    "",
    "Reply now with the new description.",
  ].join("\n");
}

const DESCRIPTION_RE = /<description>([\s\S]*?)<\/description>/;

export function parseProposerResponse(raw: string): string {
  const m = raw.match(DESCRIPTION_RE);
  if (!m) {
    throw new DescriptionProposerError(
      `proposer response did not contain a <description>...</description> tag pair. Raw response: ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  const inner = m[1].trim();
  if (inner.length === 0) {
    throw new DescriptionProposerError(
      "<description>...</description> tag captured an empty string",
    );
  }
  if (inner.length > MAX_DESCRIPTION_LENGTH) {
    throw new DescriptionProposerError(
      `proposed description length ${inner.length} exceeds cap ${MAX_DESCRIPTION_LENGTH} — the loop will fail-loud rather than commit runaway growth`,
    );
  }
  return inner;
}

export interface AnthropicProposerOptions {
  readonly client: Anthropic;
  readonly model?: string;
  readonly maxTokens?: number;
}

export function makeAnthropicProposer(
  opts: AnthropicProposerOptions,
): ProposerFn {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async (input: ProposerInput): Promise<ProposerOutput> => {
    const prompt = buildProposerPrompt(input);
    const response = await opts.client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content;
    if (!content || content.length === 0) {
      throw new DescriptionProposerError(
        "proposer call returned empty content array",
      );
    }
    // Concatenate every text block. Anthropic's response.content is a
    // discriminated union — `tool_use`, `thinking`, etc. blocks are
    // dropped intentionally; only `text` carries the proposal payload.
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }
    const text = textParts.join("\n");
    if (text.length === 0) {
      throw new DescriptionProposerError(
        "proposer call returned content blocks but none were text",
      );
    }
    return { newDescription: parseProposerResponse(text) };
  };
}
