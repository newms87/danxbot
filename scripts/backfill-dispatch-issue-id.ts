/**
 * DX-84 — one-shot backfill for `dispatches.issue_id` after the column
 * was added. Pre-existing rows have `issue_id = NULL` because the column
 * didn't exist when they were inserted; this script walks every connected
 * repo's local YAML store, builds an `(repo_name, external_id)` →
 * `local_issue_id` index, and UPDATEs every NULL row whose
 * `triggerMetadata` carries a matching reference.
 *
 * Idempotent — re-running is a no-op (rows already populated stay as-is).
 *
 * Two lookup paths, in order:
 *   1. Trello-triggered rows: `triggerMetadata.cardId` matches an
 *      `external_id` in the YAML index → stamp the YAML's `id`.
 *   2. API/Slack rows: scan `triggerMetadata.initialPrompt` (api) or
 *      `triggerMetadata.messageText` (slack) for any `<PREFIX>-N`
 *      pattern from the YAML index. First match wins.
 *
 * Run via:
 *
 *   npx tsx scripts/backfill-dispatch-issue-id.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { repos } from "../src/config.js";
import { getPool, query } from "../src/db/connection.js";
import { createLogger } from "../src/logger.js";
import type { DispatchRow } from "../src/dashboard/dispatches-db.js";
import type {
  TrelloTriggerMetadata,
  ApiTriggerMetadata,
  SlackTriggerMetadata,
} from "../src/dashboard/dispatches.js";

const log = createLogger("backfill-issue-id");

interface IssueRecord {
  id: string;
  externalId: string | null;
}

/**
 * Walk a repo's `.danxbot/issues/{open,closed}/*.yml` and return one
 * record per YAML with both the local id and the external (tracker) id.
 * Filenames are not authoritative — every YAML carries `id:` and
 * `external_id:` fields. Malformed YAMLs are skipped with a warning.
 */
async function loadRepoIssues(repoLocalPath: string): Promise<IssueRecord[]> {
  const out: IssueRecord[] = [];
  for (const subdir of ["open", "closed"]) {
    const dir = join(repoLocalPath, ".danxbot", "issues", subdir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".yml")) continue;
      const path = join(dir, file);
      let yaml: unknown;
      try {
        yaml = parse(await readFile(path, "utf-8"));
      } catch (err) {
        log.warn(`Skipping malformed YAML ${path}`, err);
        continue;
      }
      if (!yaml || typeof yaml !== "object") continue;
      const obj = yaml as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id : null;
      if (!id) continue;
      const externalId =
        typeof obj.external_id === "string" && obj.external_id.length > 0
          ? obj.external_id
          : null;
      out.push({ id, externalId });
    }
  }
  return out;
}

interface ExtractCandidate {
  trigger: string;
  metadata: TrelloTriggerMetadata | ApiTriggerMetadata | SlackTriggerMetadata;
}

/**
 * Resolve an issue id from a dispatch row's trigger metadata using the
 * repo's YAML index. Returns the local issue id, or `null` if no match.
 *
 * Pure function — testable in isolation. Mirror the lookup order in the
 * file header: trello cardId first, then prompt-regex fallback.
 */
export function resolveIssueIdForRow(
  candidate: ExtractCandidate,
  index: { byExternalId: Map<string, string>; ids: ReadonlySet<string> },
): string | null {
  if (candidate.trigger === "trello") {
    const meta = candidate.metadata as TrelloTriggerMetadata;
    if (meta.cardId) {
      const match = index.byExternalId.get(meta.cardId);
      if (match) return match;
    }
  }

  // Prompt-regex fallback. Aggregate every text field that might carry an
  // `<PREFIX>-N` reference across the three known trigger shapes.
  const haystacks: string[] = [];
  if (candidate.trigger === "trello") {
    const meta = candidate.metadata as TrelloTriggerMetadata;
    if (meta.cardName) haystacks.push(meta.cardName);
  } else if (candidate.trigger === "api") {
    const meta = candidate.metadata as ApiTriggerMetadata;
    if (meta.initialPrompt) haystacks.push(meta.initialPrompt);
  } else if (candidate.trigger === "slack") {
    const meta = candidate.metadata as SlackTriggerMetadata;
    if (meta.messageText) haystacks.push(meta.messageText);
  }

  for (const text of haystacks) {
    // Greedy left-to-right scan for any uppercase prefix + dash + digits
    // sequence. We accept the first one we recognize from the repo's
    // YAML id set so a stray `[ABC-1]` reference to an unrelated tracker
    // doesn't bleed into this repo's results.
    const pattern = /\b([A-Z]{1,8})-(\d+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const candidate = `${m[1]}-${m[2]}`;
      if (index.ids.has(candidate)) return candidate;
    }
  }

  return null;
}

interface RepoIndex {
  byExternalId: Map<string, string>;
  ids: Set<string>;
}

function buildIndex(records: IssueRecord[]): RepoIndex {
  const byExternalId = new Map<string, string>();
  const ids = new Set<string>();
  for (const rec of records) {
    ids.add(rec.id);
    if (rec.externalId) byExternalId.set(rec.externalId, rec.id);
  }
  return { byExternalId, ids };
}

async function backfillRepo(repoName: string, repoLocalPath: string): Promise<{
  scanned: number;
  updated: number;
}> {
  const records = await loadRepoIssues(repoLocalPath);
  const index = buildIndex(records);
  log.info(
    `[${repoName}] Loaded ${records.length} YAMLs (${index.byExternalId.size} with external_id)`,
  );

  const rows = await query<DispatchRow>(
    `SELECT * FROM dispatches WHERE repo_name = $1 AND issue_id IS NULL`,
    [repoName],
  );

  let updated = 0;
  for (const row of rows) {
    const meta =
      typeof row.trigger_metadata === "string"
        ? JSON.parse(row.trigger_metadata)
        : (row.trigger_metadata as Record<string, unknown>);
    const issueId = resolveIssueIdForRow(
      { trigger: row.trigger, metadata: meta as never },
      index,
    );
    if (!issueId) continue;
    await query(`UPDATE dispatches SET issue_id = $1 WHERE id = $2`, [
      issueId,
      row.id,
    ]);
    updated++;
  }

  return { scanned: rows.length, updated };
}

async function main(): Promise<void> {
  let totalScanned = 0;
  let totalUpdated = 0;
  for (const repo of repos) {
    const result = await backfillRepo(repo.name, repo.localPath);
    log.info(
      `[${repo.name}] Backfill: ${result.updated}/${result.scanned} rows updated`,
    );
    totalScanned += result.scanned;
    totalUpdated += result.updated;
  }
  log.info(
    `Backfill complete: ${totalUpdated}/${totalScanned} rows updated across ${repos.length} repo(s)`,
  );
  await getPool().end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error("Backfill failed", err);
    process.exit(1);
  });
}
