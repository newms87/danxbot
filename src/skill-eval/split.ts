/**
 * Deterministic 60/40 train/test split for an eval-set.
 *
 * Pure module: takes a query list + integer seed, returns `{train, test}`.
 * Same input + same seed → identical split, every time. The seeded shuffle
 * uses Mulberry32 — a tiny, fast, widely-used uint32 PRNG that's adequate
 * for shuffle-determinism (we are NOT seeding cryptography).
 *
 * Round rule: train side = `Math.round(length * 0.6)`, test side gets the
 * remainder. The 60/40 ratio is fixed by skill-creator convention; the
 * round direction is fixed here so the split is reproducible across
 * Node versions (`Math.floor` vs `Math.round` would produce different
 * shapes for 16/18-element sets).
 */

import type { EvalQuery } from "./eval-set.js";

export interface SplitResult {
  readonly train: readonly EvalQuery[];
  readonly test: readonly EvalQuery[];
}

const TRAIN_RATIO = 0.6;

/**
 * Mulberry32 — 32-bit seedable PRNG. Returns a function that yields
 * doubles in [0, 1). Source: George Marsaglia / Tommy Ettinger, adapted
 * for TypeScript. Acceptable for shuffle-determinism; do NOT use for
 * crypto. Each call advances the internal state.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  // Fisher–Yates / Durstenfeld. RNG is consumed once per swap so the
  // shuffle is a deterministic function of seed + array length.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

export function splitEvalSet(
  queries: readonly EvalQuery[],
  seed: number,
): SplitResult {
  if (queries.length === 0) {
    throw new Error("splitEvalSet: input is empty — nothing to split");
  }
  if (!Number.isFinite(seed)) {
    throw new Error(`splitEvalSet: seed must be a finite number (got ${seed})`);
  }
  const seedInt = Math.floor(seed);
  // Clone first so the caller's array is never mutated.
  const cloned = queries.slice();
  shuffleInPlace(cloned, mulberry32(seedInt));
  const trainLen = Math.round(cloned.length * TRAIN_RATIO);
  // Guarantee at least one element on each side when the input is ≥ 2.
  // Math.round(2 * 0.6) === 1 so the degenerate case is already 1/1, but
  // a length-2 with a different ratio shape would otherwise collapse.
  const train = cloned.slice(0, trainLen);
  const test = cloned.slice(trainLen);
  return { train, test };
}
