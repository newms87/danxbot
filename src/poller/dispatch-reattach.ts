/**
 * Reattach planner (ISS-92, Phase 2 of the poller-triage rework).
 *
 * Pure: takes a list of `Issue`s with non-null `dispatch{}` blocks plus
 * the liveness deps, returns a plan that the orchestrator (poller's
 * `start()` and per-tick `_poll`) executes. No filesystem writes here.
 *
 * Lives outside `src/poller/index.ts` so tests can import it without
 * paying the env-validation tax that pulling the poller's config-chain
 * does (see `danx-repo-workflow.md` "Isolate Pure Helpers").
 *
 * Why a planner shape? The poller has two consumers:
 *
 *  1. Boot reattach — walks every open YAML once, populates the
 *     in-memory `activeDispatches` map with verdicts == alive, and
 *     clears the YAMLs whose verdicts say dead/cross-host/expired.
 *     Boot runs BEFORE the first `_poll` tick to prevent double-
 *     dispatch.
 *  2. Per-tick liveness — walks the `activeDispatches` keys (much
 *     smaller than the full open dir) and re-checks them. Any verdict
 *     != alive evicts from the map AND clears the YAML.
 *
 * Both consumers share the same liveness verdict function
 * (`checkYamlDispatchLiveness`) and the same plan shape — only the
 * input set differs. The planner returns the partition; the
 * orchestrator decides how to act on it.
 */

import type { Issue } from "../issue-tracker/interface.js";
import {
  checkYamlDispatchLiveness,
  type LivenessDeps,
  type LivenessVerdict,
} from "./dispatch-liveness-yaml.js";

export interface ReattachAction {
  issue: Issue;
  verdict: LivenessVerdict;
}

export interface ReattachPlan {
  /** Issues whose dispatch is still alive — register in `activeDispatches`. */
  alive: ReattachAction[];
  /**
   * Issues whose dispatch has been declared dead (PID gone, TTL expired,
   * or cross-host on a local-only deploy). Caller clears `dispatch: null`
   * on each YAML and drops the in-memory entry.
   */
  cleared: ReattachAction[];
}

/**
 * Build the reattach plan for a list of `Issue`s. Every input is
 * expected to carry a non-null `dispatch{}` block; entries with
 * `dispatch === null` are silently skipped (caller's responsibility to
 * pre-filter so the test set stays focused).
 *
 * Verdicts:
 *  - `alive` → `plan.alive`
 *  - `dead-pid` / `dead-ttl` / `cross-host` → `plan.cleared`
 *
 * A single YAML never appears in both partitions. The planner is
 * deterministic — same inputs produce the same plan, always.
 */
export function buildReattachPlan(
  issues: readonly Issue[],
  deps: LivenessDeps,
): ReattachPlan {
  const alive: ReattachAction[] = [];
  const cleared: ReattachAction[] = [];

  for (const issue of issues) {
    if (issue.dispatch === null) continue;
    const verdict = checkYamlDispatchLiveness(issue.dispatch, deps);
    if (verdict.kind === "alive") {
      alive.push({ issue, verdict });
    } else {
      cleared.push({ issue, verdict });
    }
  }

  return { alive, cleared };
}
