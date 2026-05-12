/**
 * Per-agent + per-card quarantine cooldown map.
 *
 * Replaces the global per-poller-tick backoff window deleted by
 * DX-242. The retired mechanism was a single integer that halted the
 * entire poller for an exponentially growing window after every
 * failed dispatch — one bad card silenced every card.
 *
 * The replacement is two parallel cooldown maps:
 *
 *   - **Per-agent.** After a failed dispatch the failing agent is
 *     quarantined for {@link DEFAULT_AGENT_QUARANTINE_MS}. The
 *     multi-agent picker (`pickFreeAgent`) skips the agent for that
 *     window. The agent is still free to pick OTHER cards once the
 *     cooldown lapses (the operator's broken-state flag — DX-298 —
 *     is the open-ended block; this is the short transient).
 *   - **Per-card.** The failing card is quarantined for
 *     {@link DEFAULT_CARD_QUARANTINE_MS}. The picker skips the card
 *     for any agent during that window so a hot retry loop cannot
 *     spin against an env-level blocker. The longer per-card
 *     window gives the failure-tally path (`failure-tally.ts`) time
 *     to escalate to Blocked on the third strike rather than the
 *     scheduler hammering the same card across every free agent.
 *
 * Both keys clear on a successful dispatch of the same agent / card so
 * a single transient failure does not park anything. The map is
 * in-memory; a worker restart re-evaluates from scratch (transient
 * cooldowns lose state — acceptable since the DB-backed failure tally
 * still escalates on the next failure if the underlying problem
 * persists, and the boot order does not depend on cooldowns).
 *
 * Every transition out of a clean state calls
 * {@link recordSystemError} so the dashboard banner surfaces the
 * quarantine — the operator can clear it via the Agents tab if they
 * decide the cooldown is over-conservative.
 *
 * AC #2 of DX-221.
 */

import { recordSystemError } from "../dashboard/system-errors.js";

/**
 * Default per-agent cooldown: 60s. Picked to span one poller minute
 * sweep — the failing agent skips its next eligible turn but is
 * back in the picker before the sweep after that. Tuned conservatively
 * so a single transient failure (a brief MCP server reload) does not
 * keep the agent idle for long.
 */
export const DEFAULT_AGENT_QUARANTINE_MS = 60_000;

/**
 * Default per-card cooldown: 5 min. Longer than the agent cooldown so
 * the picker does not bounce the same card across every free agent
 * in a tight loop while the {@link
 * import("./failure-tally.js").escalateOnRepeatedFailures}
 * counter walks up to threshold. The dashboard banner surfaces the
 * cooldown via `recordSystemError`; the operator can manually
 * clear via the dashboard if they decide the cooldown is too
 * conservative.
 */
export const DEFAULT_CARD_QUARANTINE_MS = 5 * 60_000;

interface QuarantineEntry {
  until: number;
  reason: string;
}

const agentQuarantine = new Map<string, QuarantineEntry>();
const cardQuarantine = new Map<string, QuarantineEntry>();

function agentKey(repoName: string, agentName: string): string {
  return `${repoName}::${agentName}`;
}

function cardKey(repoName: string, cardId: string): string {
  return `${repoName}::${cardId}`;
}

/**
 * Stamp an agent into the per-agent cooldown map. `ms` defaults to
 * {@link DEFAULT_AGENT_QUARANTINE_MS}. Idempotent — re-quarantining an
 * already-quarantined agent extends the window only when the new
 * expiry is later than the existing one (a faster failure should not
 * shorten the cooldown). Surfaces via `recordSystemError`.
 */
export function quarantineAgent(args: {
  repoName: string;
  agentName: string;
  reason: string;
  durationMs?: number;
  now?: number;
}): void {
  const now = args.now ?? Date.now();
  const dur = args.durationMs ?? DEFAULT_AGENT_QUARANTINE_MS;
  const key = agentKey(args.repoName, args.agentName);
  const until = now + dur;
  const prior = agentQuarantine.get(key);
  if (prior && prior.until >= until) {
    return;
  }
  agentQuarantine.set(key, { until, reason: args.reason });
  recordSystemError({
    source: "quarantine",
    severity: "warn",
    repo: args.repoName,
    message: `Agent ${args.agentName} quarantined for ${Math.round(dur / 1000)}s`,
    details: { reason: args.reason, until: new Date(until).toISOString() },
  });
}

/**
 * Stamp a card into the per-card cooldown map. See {@link
 * quarantineAgent} for the idempotency + system-error contract.
 */
export function quarantineCard(args: {
  repoName: string;
  cardId: string;
  reason: string;
  durationMs?: number;
  now?: number;
}): void {
  const now = args.now ?? Date.now();
  const dur = args.durationMs ?? DEFAULT_CARD_QUARANTINE_MS;
  const key = cardKey(args.repoName, args.cardId);
  const until = now + dur;
  const prior = cardQuarantine.get(key);
  if (prior && prior.until >= until) {
    return;
  }
  cardQuarantine.set(key, { until, reason: args.reason });
  recordSystemError({
    source: "quarantine",
    severity: "warn",
    repo: args.repoName,
    message: `Card ${args.cardId} quarantined for ${Math.round(dur / 1000)}s`,
    details: { reason: args.reason, until: new Date(until).toISOString() },
  });
}

export function isAgentQuarantined(args: {
  repoName: string;
  agentName: string;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  const entry = agentQuarantine.get(agentKey(args.repoName, args.agentName));
  if (!entry) return false;
  if (entry.until <= now) {
    agentQuarantine.delete(agentKey(args.repoName, args.agentName));
    return false;
  }
  return true;
}

export function isCardQuarantined(args: {
  repoName: string;
  cardId: string;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  const entry = cardQuarantine.get(cardKey(args.repoName, args.cardId));
  if (!entry) return false;
  if (entry.until <= now) {
    cardQuarantine.delete(cardKey(args.repoName, args.cardId));
    return false;
  }
  return true;
}

/**
 * Clear both per-agent and per-card cooldowns for this pairing. Called
 * by the dispatch-stop callback when the dispatch lands `completed` —
 * a success on either side proves the system is healthy enough to
 * resume normal picker behaviour.
 */
export function clearQuarantineForSuccess(args: {
  repoName: string;
  agentName: string;
  cardId: string;
}): void {
  agentQuarantine.delete(agentKey(args.repoName, args.agentName));
  cardQuarantine.delete(cardKey(args.repoName, args.cardId));
}

/**
 * Test-only — clear every entry in both maps. Production callers
 * never invoke this (in-memory state is reset by worker restart).
 */
export function _resetQuarantine(): void {
  agentQuarantine.clear();
  cardQuarantine.clear();
}
