/**
 * Frontend mirror — re-exports the 6-tier priority helpers from the
 * backend module so SPA components and tests can share one source of
 * truth with the dispatcher. The `@backend` alias resolves to
 * `../src/*` in both the Vite build and the tsconfig path map, so the
 * import below picks up `src/issue-tracker/priority-tier.ts` verbatim.
 *
 * Why a mirror at all instead of importing `@backend/...` directly
 * from every consumer: the backend module is the lockstep partner of
 * `PRIORITY_MIN` / `PRIORITY_MAX` in `src/issue-tracker/yaml.ts` and
 * carries an import-time guard that throws if those bounds drift.
 * Keeping a single import path here means a future bounds bump fans
 * out to every consumer via one file, not a grep-and-replace across
 * the SPA tree.
 */
export {
  priorityTier,
  PRIORITY_TIERS,
} from "@backend/issue-tracker/priority-tier.js";

export type {
  PriorityTier,
  PriorityTierKey,
} from "@backend/issue-tracker/priority-tier.js";
