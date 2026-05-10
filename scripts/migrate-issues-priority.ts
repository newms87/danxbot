#!/usr/bin/env tsx
// One-shot migration for ISS-210: walk every YAML in
// `.danxbot/issues/{open,closed}/`, parse it (parseIssue defaults
// `priority = 3.0` and re-emits `schema_version: 5`), and rewrite the
// file with the canonical v5 shape. Idempotent: a fully-migrated file
// round-trips byte-stable.
//
// Run from a connected repo's root:
//
//     npx tsx <danxbot>/scripts/migrate-issues-priority.ts
//
// `<danxbot>` is the path to this danxbot checkout. The script reads
// `process.cwd()` so it always operates on the repo it is invoked
// from — never on the danxbot repo itself unless run from there.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseIssue, serializeIssue } from "../src/issue-tracker/yaml.js";

const repo = process.cwd();
let migrated = 0;
let skipped = 0;
let failed = 0;

for (const dir of ["open", "closed"]) {
  const dirPath = join(repo, ".danxbot", "issues", dir);
  let entries: string[];
  try {
    entries = readdirSync(dirPath).filter((n) => n.endsWith(".yml"));
  } catch {
    continue;
  }
  for (const name of entries) {
    const path = join(dirPath, name);
    const stem = name.replace(/\.yml$/, "");
    const m = /^([A-Z]{2,4})-\d+$/.exec(stem);
    if (!m) {
      console.warn(`skip rogue filename: ${name}`);
      skipped++;
      continue;
    }
    const before = readFileSync(path, "utf-8");
    let issue;
    try {
      issue = parseIssue(before, { expectedPrefix: m[1]! });
    } catch (err) {
      console.error(`FAIL ${name}:`, (err as Error).message);
      failed++;
      continue;
    }
    const after = serializeIssue(issue);
    if (after !== before) {
      writeFileSync(path, after);
      migrated++;
    } else {
      skipped++;
    }
  }
}

console.log(`migrated=${migrated} skipped=${skipped} failed=${failed}`);
