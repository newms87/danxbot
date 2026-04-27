#!/usr/bin/env tsx
/**
 * One-shot inject runner for install-time setup.
 *
 * Walks every repo in REPOS, loads its RepoContext, and calls
 * `syncRepoFiles` — the same pipeline the poller runs on every tick.
 * Populates `<repo>/.danxbot/workspaces/trello-worker/.claude/skills/`
 * (and rules/tools/workspaces) so install-time symlinks at
 * `<repo>/.claude/skills/danx-*` resolve immediately, without waiting
 * for the worker's first tick.
 *
 * Idempotent — running twice is a no-op (poller does this every tick
 * anyway). Safe to invoke from `install.sh` or by hand.
 *
 * Requires: `.env` with REPOS + DANXBOT_DB_* (config.ts module-load
 * dependency), and each repo's `.danxbot/.env` with DANXBOT_WORKER_PORT
 * (loadRepoContext throws otherwise — those are created by `/setup`).
 */

import { repos } from "../src/config.js";
import { loadRepoContext } from "../src/repo-context.js";
import { syncRepoFiles } from "../src/poller/index.js";

function main(): void {
  if (repos.length === 0) {
    console.log("No repos configured (REPOS env var empty). Nothing to sync.");
    return;
  }

  console.log(`Syncing inject pipeline for ${repos.length} repo(s)...`);
  let failures = 0;

  for (const repo of repos) {
    try {
      const ctx = loadRepoContext(repo);
      syncRepoFiles(ctx);
      console.log(`  OK: ${repo.name}`);
    } catch (err) {
      failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL: ${repo.name} - ${msg}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} repo(s) failed to sync.`);
    process.exit(1);
  }
}

main();
