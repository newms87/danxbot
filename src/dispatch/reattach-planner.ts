/**
 * Reattach planner — pure-fn seam restored for DX-320.
 *
 * `bootRehydrate` Step 1 (dead-dispatch clearing) used to live in the
 * deleted `src/poller/dispatch-reattach.ts` planner from pre-DX-220. The
 * planner exposed a clean two-partition shape (`{alive, cleared}`)
 * testable in isolation against an `Issue[]` fixture and a
 * `LivenessDeps` injection. DX-220 inlined the body into
 * `bootRehydrate`, which then required filesystem fixtures + module
 * mocks (`loadLocal`, `clearDispatchAndWrite`, `os.hostname`,
 * `isPidAlive`) to exercise the partition logic — a testability
 * regression flagged in the code-reviewer Q2 answer on DX-220.
 *
 * This module restores the seam. `bootRehydrate` keeps the I/O
 * (loadLocal walk, clearDispatchAndWrite write, logging) and delegates
 * the decision to `buildReattachPlan` over the loaded `Issue[]`.
 * `dispatch-liveness-yaml.ts` still owns the per-verdict rules — this
 * planner is only the partition.
 *
 * Pure: no I/O, no module-level state, no module mocks required in
 * tests. All clock + hostname + PID-liveness state arrives through
 * `LivenessDeps`.
 */
import { checkYamlDispatchLiveness } from "../poller/dispatch-liveness-yaml.js";
import type { Issue } from "../issue-tracker/interface.js";
import type { LivenessDeps } from "../poller/dispatch-liveness-yaml.js";

export interface ReattachPlan {
  /** Issues whose dispatch is still alive — caller leaves the YAML untouched. */
  alive: Issue[];
  /**
   * Issues whose dispatch is dead-pid / dead-ttl / cross-host — caller
   * clears `dispatch: null` via `clearDispatchAndWrite` so the scheduler
   * can re-offer the slot.
   */
  cleared: Issue[];
}

/**
 * Partition `issues` into `{alive, cleared}` based on each issue's
 * `dispatch{}` liveness verdict. Issues with `dispatch === null` are
 * excluded from both partitions — they have no reattach decision to
 * make.
 *
 * Caller order is preserved within each bucket so log lines and write
 * ordering remain deterministic from the input walk's perspective.
 */
export function buildReattachPlan(
  issues: Issue[],
  deps: LivenessDeps,
): ReattachPlan {
  const alive: Issue[] = [];
  const cleared: Issue[] = [];
  for (const issue of issues) {
    if (issue.dispatch === null) continue;
    const verdict = checkYamlDispatchLiveness(issue.dispatch, deps);
    if (verdict.kind === "alive") {
      alive.push(issue);
    } else {
      cleared.push(issue);
    }
  }
  return { alive, cleared };
}
