import type { ComplexityLevel, ComplexityProfile } from "../types.js";

export const COMPLEXITY_PROFILES: Record<ComplexityLevel, ComplexityProfile> = {
  very_low: {
    model: "claude-haiku-4-5",
    maxTurns: 8,
    maxBudgetUsd: 0.5,
    maxThinkingTokens: 2048,
    systemPrompt: "fast",
  },
  low: {
    model: "claude-haiku-4-5",
    maxTurns: 12,
    maxBudgetUsd: 1.0,
    maxThinkingTokens: 4096,
    systemPrompt: "fast",
  },
  medium: {
    model: "claude-sonnet-4-6",
    maxTurns: 16,
    maxBudgetUsd: 2.0,
    maxThinkingTokens: 8192,
    systemPrompt: "full",
  },
  high: {
    model: "claude-sonnet-4-6",
    maxTurns: 24,
    maxBudgetUsd: 5.0,
    maxThinkingTokens: 8192,
    systemPrompt: "full",
  },
  very_high: {
    model: "claude-opus-4-6",
    maxTurns: 30,
    maxBudgetUsd: 10.0,
    maxThinkingTokens: 32768,
    systemPrompt: "full",
  },
};
