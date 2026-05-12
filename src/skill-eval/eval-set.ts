/**
 * Eval-set loader + validator for the skill-eval harness.
 *
 * Wire format (drop-in compatible with skill-creator's eval-set shape so the
 * JSON files port to Anthropic's runner once #36570 + #556 ship):
 *
 *   [
 *     {"query": "...", "should_trigger": true},
 *     {"query": "...", "should_trigger": false},
 *     ...
 *   ]
 *
 * In-memory shape rebinds `should_trigger` → `shouldTrigger` for camelCase
 * consistency with the rest of the codebase. The wire snake_case is fixed by
 * the format contract; the in-memory camelCase is fixed by TypeScript norms.
 *
 * Pure module: no filesystem, no network in the validator. `loadEvalSet`
 * does the single read; `validateEvalSet` is the assertion surface tests
 * can exercise without mocking IO.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalQuery {
  readonly query: string;
  readonly shouldTrigger: boolean;
}

export class EvalSetError extends Error {}

const MIN_TOTAL = 8;
// A meaningful eval-set needs at least 3 entries per side. With only
// 1-2 negatives the negative-side accuracy is binary (0% / 50% / 100%)
// and tells the operator nothing about precision. Three is the smallest
// footprint that yields a non-trivial 3-of-3 / 2-of-3 / 1-of-3 / 0-of-3
// distribution.
const MIN_PER_SIDE = 3;

interface RawEntry {
  query?: unknown;
  should_trigger?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Validate the parsed wire shape. Throws `EvalSetError` with a specific
 * reason on every rejection so the operator can fix the underlying file
 * without guessing which constraint tripped.
 *
 * Rejection rules (in order):
 *   - Top-level must be an array.
 *   - Each entry must be `{query: string, should_trigger: boolean}`.
 *   - `query` strings must be non-empty + unique across the set (duplicates
 *     would skew the train/test split — same prompt could land in both
 *     halves, producing artificially-high test accuracy).
 *   - Total must be ≥ MIN_TOTAL (8). Below that the train/test split has
 *     too few samples per side to mean anything.
 *   - Each side (positives + negatives) must have ≥ MIN_PER_SIDE entry —
 *     a one-sided set tests precision OR recall but not both.
 */
export function validateEvalSet(raw: unknown): EvalQuery[] {
  if (!Array.isArray(raw)) {
    throw new EvalSetError(
      `eval-set must be a JSON array, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  if (raw.length === 0) {
    throw new EvalSetError("eval-set must contain at least one query");
  }

  // Per-entry validation runs FIRST so a malformed entry surfaces a shape
  // error rather than a too-small-set error — the operator can fix the
  // malformed entry without first being told to add more queries.
  const seen = new Set<string>();
  const result: EvalQuery[] = [];
  raw.forEach((entry: RawEntry, idx) => {
    if (!isRecord(entry)) {
      throw new EvalSetError(
        `eval-set entry #${idx} must be an object, got ${typeof entry}`,
      );
    }
    const { query, should_trigger } = entry;
    if (typeof query !== "string") {
      throw new EvalSetError(
        `eval-set entry #${idx}.query must be a string (got ${typeof query})`,
      );
    }
    if (query.trim().length === 0) {
      throw new EvalSetError(
        `eval-set entry #${idx}.query is empty — prompt must be non-empty`,
      );
    }
    if (typeof should_trigger !== "boolean") {
      throw new EvalSetError(
        `eval-set entry #${idx}.should_trigger must be a boolean (got ${typeof should_trigger})`,
      );
    }
    if (seen.has(query)) {
      throw new EvalSetError(
        `eval-set entry #${idx}.query is a duplicate of an earlier entry — duplicates skew the train/test split`,
      );
    }
    seen.add(query);
    result.push({ query, shouldTrigger: should_trigger });
  });

  if (result.length < MIN_TOTAL) {
    throw new EvalSetError(
      `eval-set must contain at least ${MIN_TOTAL} queries (got ${result.length})`,
    );
  }

  const positives = result.filter((q) => q.shouldTrigger).length;
  const negatives = result.length - positives;
  if (positives < MIN_PER_SIDE) {
    throw new EvalSetError(
      `eval-set must contain at least ${MIN_PER_SIDE} positive (should_trigger=true) queries (got ${positives})`,
    );
  }
  if (negatives < MIN_PER_SIDE) {
    throw new EvalSetError(
      `eval-set must contain at least ${MIN_PER_SIDE} negative (should_trigger=false) queries (got ${negatives})`,
    );
  }
  return result;
}

/**
 * Resolve the on-disk eval-set path from a `<plugin>:<skill>` name. The
 * convention: `<repoRoot>/tests/skill-evals/<plugin>-<skill>/eval-set.json`.
 * Hyphens in either segment are preserved (e.g. `base:tool-discipline` →
 * `base-tool-discipline`); only the colon collapses to a hyphen.
 */
export function resolveEvalSetPath(
  repoRoot: string,
  pluginSkill: string,
): string {
  const idx = pluginSkill.indexOf(":");
  if (idx === -1) {
    throw new EvalSetError(
      `expected <plugin>:<skill> form (got "${pluginSkill}")`,
    );
  }
  const plugin = pluginSkill.slice(0, idx);
  const skill = pluginSkill.slice(idx + 1);
  if (plugin.length === 0 || skill.length === 0) {
    throw new EvalSetError(
      `<plugin>:<skill> requires non-empty plugin and skill (got "${pluginSkill}")`,
    );
  }
  return join(repoRoot, "tests", "skill-evals", `${plugin}-${skill}`, "eval-set.json");
}

/**
 * Read + parse + validate. Surfaces the file path in any thrown
 * `EvalSetError` so the operator can grep their filesystem rather than
 * guessing which eval-set the runner was reaching for.
 */
export function loadEvalSet(path: string): EvalQuery[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new EvalSetError(
      `failed to read eval-set ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new EvalSetError(
      `failed to parse eval-set ${path}: ${(err as Error).message}`,
    );
  }
  try {
    return validateEvalSet(parsed);
  } catch (err) {
    if (err instanceof EvalSetError) {
      throw new EvalSetError(`${path}: ${err.message}`);
    }
    throw err;
  }
}
