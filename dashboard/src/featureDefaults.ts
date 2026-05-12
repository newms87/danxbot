import type { AgentSnapshot, Feature } from "./types";

/**
 * Env-default lookup for the three-valued `overrides.<feature>.enabled`
 * collapse. When the override is `null`, the UI falls back to this
 * value to render the effective state.
 *
 * Single source of truth for the per-feature default in the SPA —
 * `RepoCard.vue` (generic feature loop) and `TrelloConfigPanel.vue`
 * (dedicated trelloSync row) both read through here so adding a new
 * feature default lands in one place instead of forking across
 * components. Mirrors `src/settings-file.ts#envDefault` on the backend
 * (the backend value is authoritative; this function exists only so
 * the SPA can render the effective state inline without round-tripping
 * to the worker).
 */
export function envDefaultForFeature(
  agent: AgentSnapshot,
  feature: Feature,
): boolean {
  const display = agent.settings.display;
  switch (feature) {
    case "slack":
      return !!display.slack?.configured;
    case "issuePoller":
      return !!display.trello?.configured;
    case "trelloSync":
      // Mirrors `issuePoller`'s proxy: when Trello creds are present
      // the worker registers a Trello tracker and sync runs by default.
      return !!display.trello?.configured;
    case "dispatchApi":
      return true;
    case "ideator":
    case "autoTriage":
      return false;
  }
}
