/**
 * Worker-fault category whitelist (DX-650 — Phase 1 of DX-580).
 *
 * The Self-Repair dispatcher (Phase 2) reads `system_errors` rows and
 * only fires a repair dispatch when the row's `category` key matches
 * an entry here. Wrong-side categories would re-create the DX-560 loop
 * class by firing repair dispatches against agent-domain rows (audit
 * passes, orphan heals, reconcile validation errors).
 *
 * Allowed = the worker itself is broken (boot failure, dispatch spawn
 * crash, MCP load failure, silent claude-auth, cron job throw,
 * dashboard route handler throw, reconcile step throw NOT caused by
 * agent YAML data). Forbidden = agent-domain bookkeeping that the
 * worker recovers from in-band.
 */

export const WORKER_FAULT_CATEGORY_PREFIXES: ReadonlySet<string> = new Set([
  "worker-boot",
  "dispatch-spawn",
  "mcp-load",
  "claude-auth",
  "cron-job",
  "dashboard-route",
  "reconcile-internal",
]);

export function isWorkerFaultCategory(categoryKey: string): boolean {
  if (!categoryKey) return false;
  const colon = categoryKey.indexOf(":");
  if (colon === -1) return false;
  const prefix = categoryKey.slice(0, colon);
  return WORKER_FAULT_CATEGORY_PREFIXES.has(prefix);
}
