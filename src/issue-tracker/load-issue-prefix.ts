/**
 * Per-repo issue prefix loader.
 *
 * Resolves the `issue_prefix` field from `<repo>/.danxbot/config/config.yml`.
 * Lifted out of `src/repo-context.ts` (Phase 2 of ISS-99) so leaf consumers
 * — most importantly the dashboard's `issues-reader.ts` — can import this
 * without transitively pulling `src/config.ts`'s required-env-var checks.
 * `src/repo-context.ts` itself imports `config.ts`, so any module that
 * imports from `repo-context.ts` inherits the env requirement; this leaf
 * deliberately depends only on `node:fs`, `node:path`, the local
 * `parseSimpleYaml`, the logger, and the constants in `./yaml.js`. Same
 * "isolate pure helpers from heavy modules" reasoning as the rule
 * `.claude/rules/danx-repo-workflow.md` § "Isolate Pure Helpers From
 * src/poller/index.ts" — `src/config.ts` is the env-heavy module to avoid.
 *
 * Behavior contract (unchanged from Phase 1):
 *   - Field present + matches `ISSUE_PREFIX_SHAPE` → returned verbatim.
 *   - Field present + violates the shape → throws (fail-loud config bug).
 *   - Field absent / config.yml missing / unreadable → returns
 *     `DEFAULT_ISSUE_PREFIX` (`"ISS"`) and warns once per config path.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSimpleYaml } from "../poller/parse-yaml.js";
import { createLogger } from "../logger.js";
import { DEFAULT_ISSUE_PREFIX, ISSUE_PREFIX_SHAPE } from "./yaml.js";

const log = createLogger("issue-prefix");

const warnedPrefixPaths = new Set<string>();

function warnMissingIssuePrefix(configPath: string): void {
  if (warnedPrefixPaths.has(configPath)) return;
  warnedPrefixPaths.add(configPath);
  log.warn(
    `[issue-prefix] ${configPath} has no issue_prefix — defaulting to "${DEFAULT_ISSUE_PREFIX}". Add issue_prefix: <2-4 uppercase letters> to silence (ISS-99).`,
  );
}

/**
 * Reset the module-level warn-once dedup state for missing/unreadable
 * `config.yml` paths. Tests use this to keep log assertions
 * deterministic across cases; production code never calls it.
 */
export function _resetWarnedPrefixPaths(): void {
  warnedPrefixPaths.clear();
}

/**
 * Resolve the per-repo `issue_prefix` from `<repo>/.danxbot/config/config.yml`.
 *
 * Reads through `parseSimpleYaml` — keeps the parse path consistent
 * with the rest of the worker's config loaders.
 */
export function loadIssuePrefix(repoLocalPath: string): string {
  const configPath = resolve(repoLocalPath, ".danxbot/config/config.yml");
  if (!existsSync(configPath)) {
    warnMissingIssuePrefix(configPath);
    return DEFAULT_ISSUE_PREFIX;
  }
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (err) {
    log.warn(
      `[issue-prefix] Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)} — defaulting to "${DEFAULT_ISSUE_PREFIX}".`,
    );
    return DEFAULT_ISSUE_PREFIX;
  }
  const cfg = parseSimpleYaml(content);
  const raw = (cfg.issue_prefix ?? "").trim();
  if (raw.length === 0) {
    warnMissingIssuePrefix(configPath);
    return DEFAULT_ISSUE_PREFIX;
  }
  if (!ISSUE_PREFIX_SHAPE.test(raw)) {
    throw new Error(
      `Invalid issue_prefix "${raw}" in ${configPath} — must match ${ISSUE_PREFIX_SHAPE} (2-4 uppercase ASCII letters)`,
    );
  }
  return raw;
}
