/**
 * Default IO helpers for branch-recovery dispatch (DX-161): scanning open
 * issue YAMLs for the most-recently-modified card and appending a "Needs
 * Help" comment to it. Split out of `recovery-mode.ts` so the YAML
 * append uses the codebase's existing `yaml` parser instead of a regex
 * splice (which the previous draft got wrong: code review C1 caught the
 * "comments:" branch ordering bug + missing `id:` field).
 *
 * Both helpers are pure-IO; production code wires them into
 * `dispatchInRecoveryMode` via dependency injection so tests can stub.
 */

import { promises as fsPromises } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RepoContext } from "../types.js";

/**
 * Scan `<repo>/.danxbot/issues/open/*.yml` and return the entry with the
 * highest mtime, or null when the directory doesn't exist or is empty.
 *
 * Phase 3 limitation (DX-161): mtime is a best-guess heuristic for
 * "which card was the recovery agent working on." Phase 5 (DX-200) lands
 * the `assigned_agent` field on the YAML schema; once that exists, prefer
 * filtering by `assigned_agent === agentName` over the mtime fallback.
 */
export async function findLastModifiedOpenCard(
  repo: RepoContext,
): Promise<{ id: string; path: string } | null> {
  const dir = join(repo.localPath, ".danxbot", "issues", "open");
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return null;
  }
  const yamls = entries.filter((e) => e.endsWith(".yml"));
  if (yamls.length === 0) return null;
  const stats = await Promise.all(
    yamls.map(async (name) => {
      const path = join(dir, name);
      try {
        const s = await fsPromises.stat(path);
        return { name, path, mtimeMs: s.mtimeMs };
      } catch {
        return { name, path, mtimeMs: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = stats[0];
  return { id: top.name.replace(/\.yml$/, ""), path: top.path };
}

/**
 * Append a comment to a card YAML's `comments[]` array using the actual
 * YAML parser. Preserves every other field; the chokidar watcher
 * (`src/db/issues-mirror.ts`) mirrors the rewritten file to Postgres on
 * the file event, and the next poller tick mirrors to the tracker.
 *
 * The new entry shape matches the production schema (id + author +
 * timestamp + text — `id` is a 32-hex string mirroring Trello's comment
 * ID format).
 */
export async function appendNeedsHelpComment(
  cardPath: string,
  body: string,
): Promise<void> {
  const original = await fsPromises.readFile(cardPath, "utf-8");
  const doc = parseYaml(original) as Record<string, unknown>;

  const comments = Array.isArray(doc.comments) ? doc.comments : [];
  // 32-hex string (24 chars) — same shape Trello returns for comment ids.
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const newEntry = {
    id,
    author: "danxbot",
    timestamp: new Date().toISOString(),
    text: body,
  };
  doc.comments = [...comments, newEntry];

  // `lineWidth: 0` disables aggressive line-wrapping that would mangle
  // long markdown URLs / paths in the comment body. `blockQuote: 'literal'`
  // keeps the body as a `|-` literal scalar rather than folding whitespace.
  const next = stringifyYaml(doc, { lineWidth: 0, blockQuote: "literal" });
  await fsPromises.writeFile(cardPath, next, "utf-8");
}
