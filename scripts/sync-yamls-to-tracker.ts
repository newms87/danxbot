#!/usr/bin/env -S tsx
/**
 * One-shot: walk <repo>/.danxbot/issues/open/*.yml and call syncIssue per
 * card so the tracker reflects local YAML state. Bridges the gap until
 * ISS-67 (poller dispatch + outbound mirror reads from local YAML)
 * lands.
 *
 * Usage: DANXBOT_REPO_NAME=danxbot tsx scripts/sync-yamls-to-tracker.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadRepoContext } from "../src/repo-context.js";
import { createIssueTracker, parseIssue, syncIssue } from "../src/issue-tracker/index.js";

async function main(): Promise<void> {
  const repoName = process.env.DANXBOT_REPO_NAME;
  if (!repoName) {
    console.error("DANXBOT_REPO_NAME required");
    process.exit(1);
  }
  const localPath = resolve(process.cwd(), "repos", repoName);
  const ctx = loadRepoContext({ name: repoName, url: "", localPath });
  const tracker = createIssueTracker(ctx);

  const openDir = resolve(ctx.localPath, ".danxbot/issues/open");
  const files = readdirSync(openDir).filter((f) => f.endsWith(".yml"));
  console.log(`syncing ${files.length} YAMLs from ${openDir}`);

  for (const f of files) {
    const path = resolve(openDir, f);
    try {
      const issue = parseIssue(readFileSync(path, "utf8"));
      const { remoteWriteCount } = await syncIssue(tracker, issue);
      console.log(`  ${issue.id} ${issue.status.padEnd(12)} writes=${remoteWriteCount}`);
    } catch (err) {
      console.error(`  ${f} FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
