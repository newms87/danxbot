import { config } from "../config.js";

const lastAgentRun = new Map<string, number>();

export function isRateLimited(userId: string): boolean {
  const lastRun = lastAgentRun.get(userId);
  if (lastRun === undefined) return false;
  const cooldownMs = config.rateLimitSeconds * 1000;
  return Date.now() - lastRun < cooldownMs;
}

export function recordAgentRun(userId: string): void {
  lastAgentRun.set(userId, Date.now());
}

export function resetRateLimiter(): void {
  lastAgentRun.clear();
}
