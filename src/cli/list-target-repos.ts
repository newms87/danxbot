/**
 * Print the connected-repo names for the active deploy target, one per line.
 *
 * Used by the Makefile to iterate repos without re-implementing target YML
 * parsing in bash. Single source of truth: `src/target.ts#loadTarget`.
 *
 * Usage:
 *   npx tsx src/cli/list-target-repos.ts                    # default target
 *   DANXBOT_TARGET=gpt npx tsx src/cli/list-target-repos.ts # explicit target
 *
 * Exit codes:
 *   0 — printed N names (possibly zero, when the target has no repos)
 *   non-zero — target file missing or malformed (loadTarget throws)
 */

import { loadTarget } from "../target.js";

const target = loadTarget();
for (const repo of target.repos) {
  console.log(repo.name);
}
