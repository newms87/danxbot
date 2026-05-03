import { promises as fs } from "node:fs";
import path from "node:path";

import { ISSUE_ID_REGEX } from "./yaml.js";

/**
 * Internal issue id generator.
 *
 * Issue ids are `ISS-<positive integer>`, monotonically increasing per
 * connected repo. The id is the local primary key — it's stamped into the
 * YAML at draft time, used as the on-disk filename (`<id>.yml`), and
 * embedded as a prefix in tracker card titles (`#ISS-N: <title>`) so
 * humans can correlate Trello/etc. cards to local issues at a glance.
 *
 * Allocation strategy: scan `<repo>/.danxbot/issues/{open,closed}/` for any
 * filename matching `ISS-<N>.yml` (subset of `ISSUE_ID_REGEX`), take
 * `max(N) + 1`, return `ISS-<that>`. Empty dirs / missing dirs → `ISS-1`.
 *
 * Concurrency: callers serialize via the worker's per-issue mutex chain
 * (creates run on the worker thread, drafts can't be created in parallel
 * for the same repo); we therefore do not lock-file the scan. If two repos
 * grow concurrently they have separate id spaces, so no collision.
 *
 * Uniqueness across open/closed: drafts can also exist as bare slug
 * filenames (`add-jsonl-tail.yml`) before they have an id assigned. Those
 * files are skipped by the regex filter — they don't reserve an id.
 */
export async function nextIssueId(issuesRoot: string): Promise<string> {
  const max = await maxIssueNumber(issuesRoot);
  return `ISS-${max + 1}`;
}

/** Return the highest existing issue number across open + closed, or 0 if none. */
export async function maxIssueNumber(issuesRoot: string): Promise<number> {
  const dirs = ["open", "closed"];
  let max = 0;
  for (const sub of dirs) {
    const dir = path.join(issuesRoot, sub);
    const entries = await readDirSafe(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      if (!ISSUE_ID_REGEX.test(stem)) continue;
      const n = parseIssueNumber(stem);
      if (n !== null && n > max) max = n;
    }
  }
  return max;
}

function parseIssueNumber(id: string): number | null {
  const m = /^ISS-(\d+)$/.exec(id);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
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
