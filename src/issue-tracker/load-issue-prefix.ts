/**
 * Per-repo issue prefix loader.
 *
 * Resolves the `issue_prefix` field from `<repo>/.danxbot/config/config.yml`.
 * Lifted out of `src/repo-context.ts` (Phase 2 of DX-99) so leaf consumers
 * — most importantly the dashboard's `issues-reader.ts` — can import this
 * without transitively pulling `src/config.ts`'s required-env-var checks.
 * `src/repo-context.ts` itself imports `config.ts`, so any module that
 * imports from `repo-context.ts` inherits the env requirement; this leaf
 * deliberately depends only on `node:fs`, `node:path`, the local
 * `parseSimpleYaml`, and the constants in `./yaml.js`. Same
 * "isolate pure helpers from heavy modules" reasoning as the rule
 * `.claude/rules/danx-repo-workflow.md` § "Isolate Pure Helpers From
 * src/poller/index.ts" — `src/config.ts` is the env-heavy module to avoid.
 *
 * Behavior contract (Phase 4 of DX-99 — fail-loud, no fallback):
 *   - Field present + matches `ISSUE_PREFIX_SHAPE` → returned verbatim.
 *   - Field present + violates the shape → throws.
 *   - Field absent → throws ("missing required field issue_prefix").
 *   - config.yml missing → throws.
 *   - config.yml unreadable → throws.
 *
 * The one-release legacy "ISS" warn-once-default fallback was retired in
 * Phase 4 — every connected repo now declares `issue_prefix` explicitly
 * in its config.yml. A missing field is a config bug, not a soft default.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSimpleYaml } from "../poller/parse-yaml.js";
import { ISSUE_PREFIX_SHAPE } from "./yaml.js";

/**
 * Resolve the per-repo `issue_prefix` from `<repo>/.danxbot/config/config.yml`.
 *
 * Reads through `parseSimpleYaml` — keeps the parse path consistent
 * with the rest of the worker's config loaders. Throws fail-loud on any
 * absent / unreadable / malformed branch (Phase 4 of DX-99).
 */
export function loadIssuePrefix(repoLocalPath: string): string {
  const configPath = resolve(repoLocalPath, ".danxbot/config/config.yml");
  if (!existsSync(configPath)) {
    throw new Error(
      `${configPath} not found; cannot resolve issue_prefix. Create the file with a valid issue_prefix entry (2-4 uppercase letters) before launching the worker.`,
    );
  }
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const cfg = parseSimpleYaml(content);
  const raw = (cfg.issue_prefix ?? "").trim();
  if (raw.length === 0) {
    throw new Error(
      `${configPath} is missing required field issue_prefix; run scripts/migrate-issue-prefix.ts or set it manually.`,
    );
  }
  if (!ISSUE_PREFIX_SHAPE.test(raw)) {
    throw new Error(
      `Invalid issue_prefix "${raw}" in ${configPath} — must match ${ISSUE_PREFIX_SHAPE} (2-4 uppercase ASCII letters)`,
    );
  }
  return raw;
}
