import { promises as fs } from "node:fs";
import path from "node:path";

import { buildIssueIdRegex } from "./yaml.js";
import { createLogger } from "../logger.js";

const log = createLogger("id-generator");

/**
 * Matches any `<PREFIX>-<N>` filename stem regardless of which prefix —
 * used to distinguish foreign-prefix YAMLs (warn-once-skip) from draft
 * slug filenames like `add-jsonl-tail.yml` (silent-skip). Sourced from
 * `ISSUE_PREFIX_SHAPE`'s 2-4 letter range so it stays in sync with the
 * config validator without taking a runtime dep on `repo-context.ts`.
 */
const ANY_PREFIXED_ID_REGEX = /^[A-Z]{2,4}-\d+$/;

/**
 * Internal issue id generator.
 *
 * Issue ids are `<PREFIX>-<positive integer>`, monotonically increasing
 * per connected repo. The prefix is per-repo (`DX` for danxbot, `SG` for
 * gpt-manager, `FD` for platform — see `RepoContext.issuePrefix`).
 * The id is the local primary key — it's stamped into the YAML at draft
 * time, used as the on-disk filename (`<id>.yml`), and embedded as a
 * prefix in tracker card titles (`#<id>: <title>`) so humans can
 * correlate Trello/etc. cards to local issues at a glance.
 *
 * Allocation strategy: scan `<repo>/.danxbot/issues/{open,closed}/` for
 * any filename matching `<prefix>-<N>.yml`, take `max(N) + 1`, return
 * `<prefix>-<that>`. Empty dirs / missing dirs → `<prefix>-1`.
 *
 * Files in those dirs whose stem matches a different prefix's shape
 * (e.g. `ISS-7.yml` left over before a Phase 3 migration in a repo
 * whose live prefix is `DX`) are skipped with a warn-once log — they're
 * not part of this repo's id space and don't reserve an id.
 *
 * Concurrency: callers serialize via the worker's per-issue mutex chain
 * (creates run on the worker thread, drafts can't be created in
 * parallel for the same repo); we therefore do not lock-file the scan.
 * If two repos grow concurrently they have separate id spaces, so no
 * collision.
 *
 * Uniqueness across open/closed: drafts can also exist as bare slug
 * filenames (`add-jsonl-tail.yml`) before they have an id assigned.
 * Those files are skipped by the regex filter — they don't reserve an
 * id.
 */
export async function nextIssueId(
  issuesRoot: string,
  prefix: string,
): Promise<string> {
  const max = await maxIssueNumber(issuesRoot, prefix);
  return `${prefix}-${max + 1}`;
}

/**
 * Return the highest existing issue number for the given prefix across
 * `open/` + `closed/`, or 0 if none. Files whose stem doesn't match the
 * prefix-specific regex are skipped (with one warn-per-stem log to flag
 * mixed-prefix dirs that survived a botched migration or test
 * fixtures).
 */
export async function maxIssueNumber(
  issuesRoot: string,
  prefix: string,
): Promise<number> {
  // Capturing variant of the per-repo id regex — runs once at the top
  // of the scan instead of recompiling per file (review feedback on
  // hot-loop perf for large repos).
  const idRegex = buildIssueIdRegex(prefix);
  const captureRegex = new RegExp(`^${prefix}-(\\d+)$`);
  const dirs = ["open", "closed"];
  let max = 0;
  for (const sub of dirs) {
    const dir = path.join(issuesRoot, sub);
    const entries = await readDirSafe(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      if (!idRegex.test(stem)) {
        warnMismatchedPrefix(dir, stem, prefix);
        continue;
      }
      const m = captureRegex.exec(stem);
      if (m === null) continue;
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n > max) max = n;
    }
  }
  return max;
}

const warnedStems = new Set<string>();

/**
 * Warn once per (dir, stem) when a YAML's filename doesn't match the
 * active repo's prefix. Most common cause: a Phase 3 migration ran
 * partially and left a stray `ISS-N.yml` in a repo whose live prefix
 * is now `DX`. Logging once keeps the worker quiet on repeat ticks
 * while still surfacing the drift.
 *
 * Stems matching another valid `<PREFIX>-<N>` shape get the warn;
 * anything that doesn't match `ANY_PREFIXED_ID_REGEX` is silently
 * skipped — those are draft slug filenames (`add-jsonl-tail.yml`)
 * the code path intentionally tolerates.
 */
function warnMismatchedPrefix(dir: string, stem: string, prefix: string): void {
  if (!ANY_PREFIXED_ID_REGEX.test(stem)) return;
  const key = `${dir}::${stem}`;
  if (warnedStems.has(key)) return;
  warnedStems.add(key);
  log.warn(
    `[id-generator] Skipping ${path.join(dir, `${stem}.yml`)} — stem does not match repo prefix "${prefix}". Run scripts/migrate-issue-prefix.ts (Phase 3 of ISS-99) to migrate.`,
  );
}

/**
 * Reset the module-level warn-once dedup state. Tests use this to keep
 * log assertions deterministic across cases; production code never
 * calls it.
 */
export function _resetWarnedStems(): void {
  warnedStems.clear();
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
}
