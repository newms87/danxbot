import type { ApiCallUsage } from "../types.js";

/** Pricing per million tokens (USD) indexed by model */
const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00, cacheWrite: 1.00, cacheRead: 0.08 },
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-sonnet-4-5-20250929": { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-opus-4-20250514": { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
};

/**
 * Calculates the API cost in USD for a single Anthropic API call.
 * Returns 0 for unknown models.
 */
export function calculateApiCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;

  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheCreationInputTokens * pricing.cacheWrite +
      cacheReadInputTokens * pricing.cacheRead) /
    1_000_000
  );
}

/**
 * Builds an ApiCallUsage object from an Anthropic response usage block.
 */
export function buildApiCallUsage(
  responseUsage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null },
  model: string,
  source: ApiCallUsage["source"],
): ApiCallUsage {
  const inputTokens = responseUsage.input_tokens ?? 0;
  const outputTokens = responseUsage.output_tokens ?? 0;
  const cacheCreationInputTokens = responseUsage.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = responseUsage.cache_read_input_tokens ?? 0;

  return {
    source,
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd: calculateApiCost(model, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens),
    timestamp: Date.now(),
  };
}
