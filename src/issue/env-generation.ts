/**
 * Phase 2 of DX-638 — Per-repo monotonic generation counter for
 * environment-level inputs that feed every card's `desired` state
 * during reconcile.
 *
 * Reconcile (Phase 2 of DX-575 / `reconcile.ts`) is the
 * Kubernetes-style controller: `desired = deriveAll(observed, env)`.
 * `observed` is the on-disk YAML, captured by the per-card content
 * hash. `env` is everything ELSE that can move `desired`:
 *
 *   - `<repo>/.danxbot/lists.yaml` (list taxonomy → `list_name`)
 *   - `<repo>/.danxbot/config/` (repo-wide config — derive surface TBD)
 *   - Children-graph mutations elsewhere (`children[]` / `parent_id`
 *     on OTHER cards changes the parent's parent-derive input set)
 *   - `<repo>/.danxbot/settings.json` `agents{}` map (agent roster
 *     change → conflict-on / waiting-on partner resolution)
 *
 * `bumpEnvGen(repo, reason)` is called from each of those writers.
 * The counter is then read by reconcile's skip-cache: a card whose
 * YAML hash AND envGen are both unchanged since its last reconcile
 * is short-circuited to SKIP without ever touching the derive path.
 *
 * Lifetime: per-process, in-memory. Worker boot starts at 0; the
 * boot-scan reconcile then populates each card's skip-cache entry
 * with `(hash, 0)`, so post-boot bumps invalidate every card on the
 * next reconcile (= correct cold-cache behaviour). Tests reset via
 * `_resetEnvGen`.
 *
 * Why per-repo, not global: each connected repo has its own
 * lists.yaml + config + settings + children-graph. Bumping in repo A
 * must not invalidate repo B's skip-cache.
 *
 * No persistence — worker restart is equivalent to a cold cache by
 * design (boot-scan rebuilds the cache anyway).
 */

import { createLogger } from "../logger.js";

const log = createLogger("env-generation");

const envGenByRepo = new Map<string, number>();

/**
 * Current environment generation for a repo. Cold (never bumped) → 0.
 * Read by reconcile's skip-cache comparator.
 */
export function getEnvGen(repoName: string): number {
  return envGenByRepo.get(repoName) ?? 0;
}

/**
 * Increment the per-repo counter. `reason` is a debug-log breadcrumb
 * for tracing which bump invalidated which card during incident
 * postmortems — never user-facing.
 *
 * Idempotent at the contract level (every call advances), so callers
 * MUST bump exactly once per logical mutation (NOT per row written).
 * A batched lists-write that mutates 5 lists is ONE bump; a settings
 * write that touches both `overrides` and `agents` only bumps for
 * the `agents` change (the others don't move `desired`).
 */
export function bumpEnvGen(repoName: string, reason: string): number {
  const next = (envGenByRepo.get(repoName) ?? 0) + 1;
  envGenByRepo.set(repoName, next);
  log.debug(`[${repoName}] envGen → ${next} (${reason})`);
  return next;
}

/** Visible for tests — drain the counter between cases. */
export function _resetEnvGen(): void {
  envGenByRepo.clear();
}

/**
 * Detect whether the children-graph mutated between two YAML payloads
 * (raw JSON-shaped maps as the DB mirror stores them). Returns `true`
 * when EITHER `parent_id` flipped OR `children[]` changed (length OR
 * any element). Identity-stable on byte-stable rewrites.
 *
 * Used by the issues-mirror upsert paths to decide whether to call
 * `bumpEnvGen` after a successful upsert — the cheaper alternative
 * to bumping on every YAML write (which would defeat the skip-cache).
 *
 * `prev === null` (brand-new card) counts as a graph mutation: a new
 * card with non-null `parent_id` immediately changes the parent's
 * derive input set; a new top-level card with empty children still
 * shifts the picker's eligibility set so subsequent reconciles in
 * the repo should re-derive once.
 */
export function graphFieldsChanged(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): boolean {
  if (prev === null) return true;
  const prevParent = prev.parent_id ?? null;
  const nextParent = next.parent_id ?? null;
  if (prevParent !== nextParent) return true;
  const prevChildren = Array.isArray(prev.children) ? prev.children : [];
  const nextChildren = Array.isArray(next.children) ? next.children : [];
  if (prevChildren.length !== nextChildren.length) return true;
  for (let i = 0; i < prevChildren.length; i++) {
    if (prevChildren[i] !== nextChildren[i]) return true;
  }
  return false;
}
