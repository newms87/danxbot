/**
 * Phase 3 of ISS-99 — per-repo issue id prefix migration.
 *
 * Walks `<repo>/.danxbot/issues/{open,closed}/*.yml`, rewrites every
 * `<oldPrefix>-<N>` reference to `<newPrefix>-<N>`, renames the file from
 * `<oldPrefix>-<N>.yml` to `<newPrefix>-<N>.yml`, and finally swaps
 * `issue_prefix` in `<repo>/.danxbot/config/config.yml`.
 *
 * Order matters — `config.yml` is updated LAST. The dashboard reader
 * (Phase 2) treats cross-prefix YAMLs as malformed, so flipping the
 * config before the YAMLs is renamed makes the reader silently skip
 * every still-old card during the partial state. By rewriting + renaming
 * every YAML first and only then swapping `config.yml`, the active prefix
 * lines up with on-disk state at every observable moment.
 *
 * Atomicity — every write goes through an in-memory journal. On failure
 * (parse error, validation error, IO error), the journal is unwound in
 * reverse: `config.yml` is restored first (if it was flipped), then each
 * renamed file is moved back to its old name and rewritten with its
 * original utf-8 content. Issue YAMLs are utf-8 by contract; binary
 * smuggled in via stray bytes is not a supported input.
 *
 * Idempotency — a repo whose `config.yml` already carries the new prefix
 * AND whose `<repo>/.danxbot/issues/{open,closed}/` contains zero
 * `<oldPrefix>-N.yml` files reports zero changes. Running the migration
 * twice on the same input produces the same byte content.
 *
 * Fail-loud surfaces (no silent papering-over):
 *   - Missing `<repo>/.danxbot/config/config.yml` → error. The migration
 *     does NOT bootstrap a config for a repo the operator hasn't set up
 *     — that would mask a real misconfiguration.
 *   - Pre-existing `<newPrefix>-N.yml` colliding with a rename target →
 *     error. POSIX `renameSync` would silently overwrite, destroying the
 *     destination file with no journal entry. The operator must resolve
 *     the collision (delete the stale file, or audit which copy is
 *     correct) before re-running.
 *
 * CLI:
 *
 *   npx tsx scripts/migrate-issue-prefix.ts
 *
 * Migrates the three connected repos hardcoded in the CLI block below.
 * For programmatic use (tests, future ad-hoc migrations), import
 * `runMigration` and pass an explicit list of repo plans.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ISSUE_PREFIX_SHAPE,
  IssueParseError,
  buildIssueIdRegex,
  parseIssue,
  serializeIssue,
} from "../src/issue-tracker/yaml.js";
import type { Issue } from "../src/issue-tracker/interface.js";

export interface RepoPlan {
  repoRoot: string;
  oldPrefix: string;
  newPrefix: string;
}

export interface RunOptions {
  repos: RepoPlan[];
  log?: (msg: string) => void;
}

export interface RepoResult {
  repoRoot: string;
  oldPrefix: string;
  newPrefix: string;
  configUpdated: boolean;
  filesRenamed: number;
  filesRewritten: number;
  skipped: number;
  errors: string[];
  rolledBack: boolean;
}

export interface RunResult {
  perRepo: RepoResult[];
  totalFilesRenamed: number;
  totalErrors: number;
}

/**
 * Boundary-aware free-text rewrite. `\b` covers punctuation, parens,
 * line breaks, and end-of-string — the cases that show up in card
 * descriptions and commit messages. Cross-prefix references (e.g.
 * `SG-3` inside a danxbot YAML's body) don't match the regex and pass
 * through unchanged.
 */
export function rewriteFreeText(
  text: string,
  oldPrefix: string,
  newPrefix: string,
): string {
  if (oldPrefix === newPrefix) return text;
  const re = new RegExp(`\\b${escapeRegex(oldPrefix)}-(\\d+)\\b`, "g");
  return text.replace(re, `${newPrefix}-$1`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swap every in-repo `<oldPrefix>-<N>` reference on an Issue. ID-shaped
 * fields (`id`, `parent_id`, `children[]`, `blocked.by[]`,
 * `retro.action_item_ids[]`) get exact-match rewrites. Free-text fields
 * (`title`, `description`, `comments[].text`, `retro.good`, `retro.bad`,
 * `retro.commits[]`) get the boundary-aware regex.
 *
 * Foreign-prefix ids on ID-shaped fields (e.g. someone hand-wrote
 * `parent_id: SG-3` in a danxbot YAML pre-migration) are left alone —
 * they don't match the per-prefix exact regex. This is defensive; the
 * Phase 1 validator wouldn't accept that shape in the first place, but
 * the rewrite still preserves it instead of corrupting it.
 */
export function rewriteIdFields(
  issue: Issue,
  oldPrefix: string,
  newPrefix: string,
): Issue {
  // Validate the prefix shape via the canonical helper — it throws on
  // bad input, which gives us the same fail-loud guard the rest of the
  // codebase uses for prefix-shaped strings. Building the swap regex
  // with a capture group is local because `buildIssueIdRegex` returns
  // a no-capture matcher (used in hot validation paths where capture
  // overhead matters).
  buildIssueIdRegex(oldPrefix);
  buildIssueIdRegex(newPrefix);
  const idRegex = new RegExp(`^${oldPrefix}-(\\d+)$`);
  function swap(id: string): string {
    const m = idRegex.exec(id);
    if (m === null) return id;
    return `${newPrefix}-${m[1]}`;
  }
  return {
    ...issue,
    id: swap(issue.id),
    parent_id: issue.parent_id === null ? null : swap(issue.parent_id),
    children: issue.children.map(swap),
    waiting_on:
      issue.waiting_on === null
        ? null
        : { ...issue.waiting_on, by: issue.waiting_on.by.map(swap) },
    title: rewriteFreeText(issue.title, oldPrefix, newPrefix),
    description: rewriteFreeText(issue.description, oldPrefix, newPrefix),
    comments: issue.comments.map((c) => ({
      ...c,
      text: rewriteFreeText(c.text, oldPrefix, newPrefix),
    })),
    retro: {
      ...issue.retro,
      good: rewriteFreeText(issue.retro.good, oldPrefix, newPrefix),
      bad: rewriteFreeText(issue.retro.bad, oldPrefix, newPrefix),
      action_item_ids: issue.retro.action_item_ids.map(swap),
      commits: issue.retro.commits.map((c) =>
        rewriteFreeText(c, oldPrefix, newPrefix),
      ),
    },
  };
}

/**
 * Set the `issue_prefix` field in a `config.yml` text body without
 * disturbing other keys, comments, or trailing whitespace.
 *
 * Three branches:
 *   - existing `issue_prefix:` line → replaced in place (drops trailing
 *     comments on that line so quoted/legacy values normalize).
 *   - no existing line, but `name:` present → inserted as a new line
 *     immediately after `name:`.
 *   - neither present → prepended to the top of the file.
 *
 * Returns the input unchanged when the existing value already equals the
 * new prefix (idempotent).
 */
export function setConfigPrefix(content: string, newPrefix: string): string {
  if (!ISSUE_PREFIX_SHAPE.test(newPrefix)) {
    throw new Error(
      `setConfigPrefix: invalid newPrefix "${newPrefix}" — must match ${ISSUE_PREFIX_SHAPE}`,
    );
  }
  const existingRe = /^([\t ]*)issue_prefix:[\t ]*([^\r\n]*)$/m;
  const match = existingRe.exec(content);
  if (match !== null) {
    const currentRaw = match[2].trim();
    // Strip optional surrounding quotes for the equality check.
    const stripped = currentRaw.replace(/^"(.+)"$/, "$1").replace(/^'(.+)'$/, "$1");
    // Trailing-comment portion is dropped — the canonical form has no
    // inline comment after the value.
    const valueOnly = stripped.replace(/\s+#.*$/, "");
    if (valueOnly === newPrefix && currentRaw === valueOnly) {
      return content;
    }
    return content.replace(existingRe, `${match[1]}issue_prefix: ${newPrefix}`);
  }
  const nameRe = /^name:[^\r\n]*$/m;
  if (nameRe.test(content)) {
    return content.replace(nameRe, (m) => `${m}\nissue_prefix: ${newPrefix}`);
  }
  return `issue_prefix: ${newPrefix}\n${content}`;
}

interface JournalEntry {
  /**
   * Restore the on-disk state to what it was BEFORE this entry executed.
   * Each step's mutator captures enough state (original path, original
   * content, new path) to undo itself.
   */
  rollback: () => void;
}

/**
 * Per-repo migration. Returns the result; never throws — the caller
 * walks `result.errors` to decide whether to surface a non-zero exit.
 */
function migrateRepo(plan: RepoPlan, log: (msg: string) => void): RepoResult {
  const { repoRoot, oldPrefix, newPrefix } = plan;
  const result: RepoResult = {
    repoRoot,
    oldPrefix,
    newPrefix,
    configUpdated: false,
    filesRenamed: 0,
    filesRewritten: 0,
    skipped: 0,
    errors: [],
    rolledBack: false,
  };

  if (!ISSUE_PREFIX_SHAPE.test(oldPrefix) || !ISSUE_PREFIX_SHAPE.test(newPrefix)) {
    result.errors.push(
      `Invalid prefix(es) — old="${oldPrefix}" new="${newPrefix}", both must match ${ISSUE_PREFIX_SHAPE}`,
    );
    return result;
  }

  const journal: JournalEntry[] = [];
  const oldStemRe = new RegExp(`^${oldPrefix}-(\\d+)\\.yml$`);
  const newStemRe = new RegExp(`^${newPrefix}-(\\d+)\\.yml$`);

  try {
    // Walk every issues dir (open + closed). Missing dirs are tolerated;
    // they show up on platform repos that have never been used.
    const subdirs = ["open", "closed"];
    const issuesRoot = join(repoRoot, ".danxbot", "issues");

    interface FileMutation {
      oldPath: string;
      newPath: string;
      originalText: string;
      newText: string;
    }
    const mutations: FileMutation[] = [];

    for (const sub of subdirs) {
      const dir = join(issuesRoot, sub);
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".yml")) continue;
        if (oldStemRe.test(entry)) {
          const oldPath = join(dir, entry);
          const originalText = readFileSync(oldPath, "utf-8");
          // Parse with the OLD prefix to validate the pre-migration shape.
          let issue: Issue;
          try {
            issue = parseIssue(originalText, { expectedPrefix: oldPrefix });
          } catch (err) {
            const msg = err instanceof IssueParseError ? err.message : String(err);
            throw new Error(`[parse] Failed to parse ${oldPath}: ${msg}`);
          }
          const rewritten = rewriteIdFields(issue, oldPrefix, newPrefix);
          const newText = serializeIssue(rewritten);
          // Verify the rewritten YAML parses with the NEW prefix.
          try {
            parseIssue(newText, { expectedPrefix: newPrefix });
          } catch (err) {
            const msg = err instanceof IssueParseError ? err.message : String(err);
            throw new Error(`[rewrite] Rewrite of ${oldPath} failed validation: ${msg}`);
          }
          const newName = entry.replace(oldStemRe, `${newPrefix}-$1.yml`);
          const newPath = join(dir, newName);
          // Fail-loud collision check: POSIX `renameSync` silently
          // overwrites an existing destination, which would destroy a
          // pre-existing `<newPrefix>-N.yml` (operator-created stub or
          // leftover from a prior partial migration) with no journal
          // entry to roll it back. Catch the case BEFORE we mutate
          // anything; the operator must resolve manually.
          if (oldPath !== newPath && existsSync(newPath)) {
            throw new Error(
              `[collision] Refusing to migrate ${oldPath}: destination ${newPath} already exists. ` +
                `Resolve manually (delete or audit the destination file) and re-run.`,
            );
          }
          mutations.push({ oldPath, newPath, originalText, newText });
        } else if (newStemRe.test(entry)) {
          // Already migrated — idempotent skip.
          result.skipped++;
        }
        // Anything else (draft slugs, unrelated prefixes) is left alone.
      }
    }

    // Apply mutations: write new content at the OLD path first (to keep
    // rollback simple — original byte content is in journal), then rename
    // to the NEW path. This way a partial mid-rename failure leaves the
    // file at its old path with rewritten content, which the journal still
    // restores correctly.
    for (const m of mutations) {
      const { oldPath, newPath, originalText, newText } = m;

      // Step 1: rewrite content at old path. Atomic: write to temp,
      // rename onto old path.
      atomicWrite(oldPath, newText);
      journal.push({
        rollback: () => atomicWrite(oldPath, originalText),
      });
      result.filesRewritten++;

      // Step 2: rename old path → new path. Rollback re-renames newPath
      // back to oldPath (idempotent — a no-op if newPath was already
      // restored, e.g. from an earlier rollback step).
      if (oldPath !== newPath) {
        renameSync(oldPath, newPath);
        journal.push({
          rollback: () => {
            if (existsSync(newPath)) {
              renameSync(newPath, oldPath);
            }
          },
        });
        result.filesRenamed++;
      }
    }

    // Finally: update config.yml (LAST — see header).
    const configPath = join(repoRoot, ".danxbot", "config", "config.yml");
    if (!existsSync(configPath)) {
      // Fail loud: a repo we are migrating MUST have a config.yml.
      // Silently bootstrapping one would mask a real misconfiguration —
      // the operator hasn't connected this repo properly yet, and the
      // migration is the wrong place to discover that.
      throw new Error(
        `[config] Missing ${configPath}. Set up the repo (run /setup) ` +
          `before migrating its issue prefix.`,
      );
    }
    const originalConfig = readFileSync(configPath, "utf-8");
    const newConfig = setConfigPrefix(originalConfig, newPrefix);
    if (newConfig !== originalConfig) {
      atomicWrite(configPath, newConfig);
      journal.push({
        rollback: () => atomicWrite(configPath, originalConfig),
      });
      result.configUpdated = true;
    }

    log(
      `[migrate-issue-prefix] ${repoRoot}: renamed ${result.filesRenamed}, rewrote ${result.filesRewritten}, skipped ${result.skipped}, configUpdated=${result.configUpdated}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    log(`[migrate-issue-prefix] ${repoRoot}: ERROR — ${message} — rolling back`);
    // Walk journal in reverse, swallowing errors so one bad rollback step
    // doesn't suppress the others.
    for (let i = journal.length - 1; i >= 0; i--) {
      try {
        journal[i].rollback();
      } catch (rollbackErr) {
        const rmsg =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        result.errors.push(`Rollback step ${i} failed: ${rmsg}`);
      }
    }
    result.rolledBack = true;
    // Reset counts to reflect the rollback — nothing landed.
    result.filesRenamed = 0;
    result.filesRewritten = 0;
    result.configUpdated = false;
  }

  return result;
}

/**
 * Atomic write: stage to `<path>.migrate.tmp`, then rename onto the
 * target. Same FS guarantees a non-torn write.
 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.migrate.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function runMigration(options: RunOptions): RunResult {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const perRepo = options.repos.map((plan) => migrateRepo(plan, log));
  return {
    perRepo,
    totalFilesRenamed: perRepo.reduce((sum, r) => sum + r.filesRenamed, 0),
    totalErrors: perRepo.reduce((sum, r) => sum + r.errors.length, 0),
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function isMain(): boolean {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMain()) {
  const danxbotRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const reposDir = resolve(danxbotRoot, "repos");
  const result = runMigration({
    repos: [
      { repoRoot: join(reposDir, "danxbot"), oldPrefix: "ISS", newPrefix: "DX" },
      {
        repoRoot: join(reposDir, "gpt-manager"),
        oldPrefix: "ISS",
        newPrefix: "SG",
      },
      { repoRoot: join(reposDir, "platform"), oldPrefix: "ISS", newPrefix: "FD" },
    ],
  });

  console.log("\n=== migrate-issue-prefix summary ===");
  for (const r of result.perRepo) {
    console.log(
      `  ${r.repoRoot}: ${r.oldPrefix} → ${r.newPrefix} — renamed=${r.filesRenamed}, rewritten=${r.filesRewritten}, skipped=${r.skipped}, configUpdated=${r.configUpdated}, rolledBack=${r.rolledBack}, errors=${r.errors.length}`,
    );
    for (const e of r.errors) console.log(`    ! ${e}`);
  }
  if (result.totalErrors > 0) {
    process.exitCode = 1;
  }
}
