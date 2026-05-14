/**
 * DX-513 — pure resolver for "what effort level should this dispatch run at?"
 *
 * Three-step fallback chain (first match wins):
 *
 *   1. Card override — `effort_level` on the candidate YAML (non-null).
 *      Only the poller path sees this; Slack / `/api/launch` / ideator /
 *      triage dispatches have no candidate card, so step 1 cannot fire
 *      for them.
 *   2. Agent default — `settings.agents.<name>.effortLevel` (per DX-509).
 *      Resolved by `getAgentEffortLevel`, which fails soft to step 3
 *      when the agent is absent or its record lacks the field.
 *   3. Built-in default — `DEFAULT_AGENT_EFFORT_LEVEL` (`"medium"`).
 *      Final fallback when neither the card nor any agent supplies a
 *      level.
 *
 * The output is the agent-facing label (`EffortLevelName`); the caller
 * (`dispatch()` in `core.ts`) hands it to `resolveEffortToFlags` to
 * obtain the `{model, effort}` pair the launcher forwards to claude.
 * Splitting "pick the name" from "pick the flags" lets this resolver
 * stay pure + table-tested without spinning up a worker.
 *
 * The function ALSO reads the on-disk settings file (via
 * `getAgentEffortLevel`) when an agent name is supplied — that's the
 * one IO operation in this module. Test fixtures isolate via a temp
 * `<localPath>/.danxbot/settings.json`; the read fails soft (returns
 * `DEFAULT_AGENT_EFFORT_LEVEL`) on a missing / corrupt file, so callers
 * can rely on the function never throwing.
 */

import {
  DEFAULT_AGENT_EFFORT_LEVEL,
  getAgentEffortLevel,
  type EffortLevelName,
} from "../settings-file.js";

export interface ResolveDispatchEffortInput {
  /**
   * The candidate card's `effort_level`, when this dispatch has one.
   * `null` / `undefined` skips step 1. Pre-resolved by the caller
   * (`dispatch()` reads the YAML once for the auto-flip path and can
   * pull `effort_level` off the same read).
   */
  cardEffortLevel: EffortLevelName | null | undefined;
  /**
   * The agent the dispatch is bound to (from `input.agent?.name`).
   * `null` / `undefined` skips step 2. Slack / external `/api/launch`
   * without a persona-resolved agent omit this and fall through to
   * step 3.
   */
  agentName: string | null | undefined;
  /**
   * Repo localPath — passed to `getAgentEffortLevel` so it can locate
   * `<localPath>/.danxbot/settings.json`. Required even when
   * `agentName` is null (the caller doesn't have to gate the field).
   */
  repoLocalPath: string;
}

export function resolveDispatchEffort(
  input: ResolveDispatchEffortInput,
): EffortLevelName {
  if (input.cardEffortLevel != null) return input.cardEffortLevel;
  if (input.agentName) {
    return getAgentEffortLevel(input.repoLocalPath, input.agentName);
  }
  return DEFAULT_AGENT_EFFORT_LEVEL;
}
