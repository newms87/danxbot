#!/usr/bin/env npx tsx
/**
 * One-shot migration: schema v1 → v2 for `.danxbot/issues/{open,closed}/*.yml`.
 *
 * v1 carried `external_id` as the primary id and as the filename basename.
 * v2 introduces a separate internal `id` (`ISS-N`), keeps `external_id` for
 * tracker mapping, and renames every YAML to `<id>.yml`.
 *
 * Per repo:
 *   1. Discover every .yml in `<repo>/.danxbot/issues/open/` + `closed/`.
 *   2. Sort by mtime ascending (oldest first → lowest ISS-N).
 *   3. Assign sequential ISS-N starting at 1.
 *   4. Rewrite each YAML: `schema_version: 2`, insert `id: ISS-N`, keep
 *      `external_id`. Rename file to `<id>.yml`.
 *   5. Patch `parent_id` references — v1 stored the parent's external_id;
 *      v2 stores the parent's internal id. Build a map external_id → id
 *      first; rewrite `parent_id` in every issue.
 *   6. (Trello-only) PATCH each tracker card's title to add the `#<id>: `
 *      prefix when missing. Skipped when `tracker !== "trello"` or when
 *      `--no-tracker` is passed.
 *
 * Usage:
 *   npx tsx scripts/migrate-issues-to-v2.ts <repo-path> [--no-tracker] [--dry-run]
 *
 * Examples:
 *   npx tsx scripts/migrate-issues-to-v2.ts /home/newms/web/danxbot
 *   npx tsx scripts/migrate-issues-to-v2.ts /home/newms/web/gpt-manager --dry-run
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

interface CliArgs {
  repoPath: string;
  noTracker: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  if (positional.length !== 1) {
    console.error(
      "Usage: npx tsx scripts/migrate-issues-to-v2.ts <repo-path> [--no-tracker] [--dry-run]",
    );
    process.exit(2);
  }
  return {
    repoPath: path.resolve(positional[0]),
    noTracker: flags.has("--no-tracker"),
    dryRun: flags.has("--dry-run"),
  };
}

interface FileEntry {
  state: "open" | "closed";
  oldPath: string;
  oldStem: string;
  mtimeMs: number;
}

function collectFiles(issuesRoot: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const state of ["open", "closed"] as const) {
    const dir = path.join(issuesRoot, state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yml")) continue;
      const oldPath = path.join(dir, entry);
      const stem = entry.slice(0, -".yml".length);
      const stat = statSync(oldPath);
      out.push({ state, oldPath, oldStem: stem, mtimeMs: stat.mtimeMs });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

function main(): void {
  const args = parseArgs(process.argv);
  const issuesRoot = path.join(args.repoPath, ".danxbot", "issues");
  if (!existsSync(issuesRoot)) {
    console.error(`No .danxbot/issues/ directory at ${args.repoPath}`);
    process.exit(1);
  }

  const files = collectFiles(issuesRoot);
  if (files.length === 0) {
    console.log("No issue YAMLs found — nothing to migrate.");
    return;
  }

  console.log(
    `Migrating ${files.length} issue${files.length === 1 ? "" : "s"} in ${args.repoPath}...`,
  );

  // Pass 1: assign ISS-N + rewrite each file. Capture external_id → id map.
  const externalToInternal = new Map<string, string>();
  const planned: Array<{
    entry: FileEntry;
    newId: string;
    newPath: string;
    nextDoc: Record<string, unknown>;
  }> = [];

  files.forEach((entry, i) => {
    const newId = `ISS-${i + 1}`;
    const raw = readFileSync(entry.oldPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      console.error(`  ${entry.oldStem}: malformed YAML — skipping`);
      return;
    }

    const existingExternal =
      typeof parsed.external_id === "string" ? parsed.external_id : entry.oldStem;
    externalToInternal.set(existingExternal, newId);

    // Build the v2 doc preserving canonical key order.
    const nextDoc: Record<string, unknown> = {
      schema_version: 2,
      tracker: parsed.tracker ?? "memory",
      id: newId,
      external_id: existingExternal,
      parent_id: parsed.parent_id ?? null,
      dispatch_id: parsed.dispatch_id ?? null,
      status: parsed.status ?? "ToDo",
      type: parsed.type ?? "Feature",
      title: parsed.title ?? "",
      description: parsed.description ?? "",
      triaged: parsed.triaged ?? { timestamp: "", status: "", explain: "" },
      ac: parsed.ac ?? [],
      phases: parsed.phases ?? [],
      comments: parsed.comments ?? [],
      retro: parsed.retro ?? {
        good: "",
        bad: "",
        action_items: [],
        commits: [],
      },
    };

    const newPath = path.join(
      issuesRoot,
      entry.state,
      `${newId}.yml`,
    );
    planned.push({ entry, newId, newPath, nextDoc });
  });

  // Pass 2: rewrite parent_id (v1 = external_id, v2 = internal id).
  for (const item of planned) {
    const parent = item.nextDoc.parent_id;
    if (typeof parent === "string" && parent.length > 0) {
      const mapped = externalToInternal.get(parent);
      if (mapped) {
        item.nextDoc.parent_id = mapped;
      } else {
        console.warn(
          `  ${item.newId}: parent_id "${parent}" has no migrated target — leaving as-is`,
        );
      }
    }
  }

  // Pass 3: write + rename.
  for (const item of planned) {
    const yamlText = stringifyYaml(item.nextDoc, { lineWidth: 0 });
    if (args.dryRun) {
      console.log(
        `  [dry-run] ${item.entry.oldStem}.yml → ${item.newId}.yml (${item.entry.state}/)`,
      );
      continue;
    }
    writeFileSync(item.entry.oldPath, yamlText);
    if (item.entry.oldPath !== item.newPath) {
      renameSync(item.entry.oldPath, item.newPath);
    }
    console.log(
      `  ${item.entry.oldStem}.yml → ${item.newId}.yml (${item.entry.state}/)`,
    );
  }

  if (args.dryRun) {
    console.log("\nDry-run complete. No files written.");
    return;
  }

  // Pass 4 (optional): patch tracker titles.
  if (!args.noTracker) {
    console.log("\nTitle-prefix migration on tracker not yet wired in this script.");
    console.log("Run with --no-tracker to silence this notice. To add the");
    console.log("`#<id>: ` prefix to Trello cards, edit the cards manually");
    console.log("or extend this script with the Trello API call (mirrors");
    console.log("trello.ts#updateCard's body shape).");
  }

  console.log(
    `\nMigrated ${planned.length} issue${planned.length === 1 ? "" : "s"}.`,
  );
}

main();
