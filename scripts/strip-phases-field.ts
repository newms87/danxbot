/**
 * One-shot ISS-81 migration: strip the legacy `phases:` field from every
 * YAML in `<repo>/.danxbot/issues/{open,closed}/*.yml`.
 *
 * Run with: npx tsx scripts/strip-phases-field.ts
 *
 * The runtime parse path (`yaml.ts#validateIssue`) already tolerates a
 * legacy `phases:` key, but YAMLs only re-emit clean on the next
 * `danx_issue_save`. Run this script to clean up everything in one pass.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseIssue, serializeIssue } from "../src/issue-tracker/yaml.js";

const repoRoot = resolve(import.meta.dirname, "..");
const dirs = ["open", "closed"].map((sub) =>
  join(repoRoot, ".danxbot", "issues", sub),
);

let scanned = 0;
let stripped = 0;
const skipped: Array<{ path: string; reason: string }> = [];

for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const path = join(dir, entry);
    scanned++;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      skipped.push({ path, reason: String(err) });
      continue;
    }
    if (!text.includes("phases:")) continue;
    let issue;
    try {
      issue = parseIssue(text);
    } catch (err) {
      skipped.push({ path, reason: String(err) });
      continue;
    }
    const cleaned = serializeIssue(issue);
    if (cleaned === text) continue;
    writeFileSync(path, cleaned);
    stripped++;
    console.log(`stripped: ${path}`);
  }
}

console.log(`\nScanned ${scanned} files. Stripped phases: from ${stripped}.`);
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length} files:`);
  for (const s of skipped) console.log(`  ${s.path} — ${s.reason}`);
}
