/**
 * DX-700 — operator-runnable one-shot migration sweep across every
 * connected repo.
 *
 * Walks `<danxbot-root>/repos/*` (the deployment convention is one
 * symlink per connected repo) and calls `runBootMigrationSweep` once
 * per repo. The sweep is the same primitive the worker runs on boot;
 * this script lets the operator force a sweep without restarting the
 * worker process — useful right after publishing a schema bump or
 * tightening the heal pass (e.g. DX-700 added the
 * `healBlockedReferences` pass to repair v12 files whose history
 * carried pre-v12 `"Blocked"` entries).
 *
 * Idempotent: re-running on a canonical repo yields
 * `{unchanged: N, migrated: 0, healed: 0}` and exits 0. Any failure
 * propagates a non-zero exit so CI / `make` can chain on success.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverConnectedRepos } from "../src/repo-discovery.js";
import { runBootMigrationSweep } from "../src/worker/migrate-on-boot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const repos = discoverConnectedRepos(resolve(__dirname, ".."));
  if (repos.length === 0) {
    console.warn(
      "[migrate-all-issues] no connected repos found under <danxbot-root>/repos — nothing to do",
    );
    return;
  }
  console.log(
    `[migrate-all-issues] sweeping ${repos.length} repo(s): ${repos
      .map((r) => r.name)
      .join(", ")}`,
  );
  let totalFailed = 0;
  for (const repo of repos) {
    const result = await runBootMigrationSweep([{ localPath: repo.localPath }]);
    console.log(
      `[migrate-all-issues] [${repo.name}] migrated=${result.migrated} healed=${result.healed} unchanged=${result.unchanged} deletedClosed=${result.deletedClosed} failed=${result.failed.length}`,
    );
    if (result.failed.length > 0) {
      totalFailed += result.failed.length;
      for (const f of result.failed) {
        console.error(`  [${repo.name}] FAIL ${f.path} — ${f.error}`);
      }
    }
  }
  if (totalFailed > 0) {
    console.error(
      `[migrate-all-issues] ${totalFailed} per-file failure(s) — see above`,
    );
    process.exit(1);
  }
}

void main();
