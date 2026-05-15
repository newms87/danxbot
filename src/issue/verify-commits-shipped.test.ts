/**
 * DX-559 — Unit suite for verifyCommitsShipped.
 *
 * Strategy: spin up a real temp git repo per test. No mocks — `execFile`
 * against git's actual binary is the only honest test of `merge-base
 * --is-ancestor` ancestry semantics. Each test creates its own repo +
 * tears it down in afterEach, so the suite is parallel-safe and leaves
 * no state on the developer's tree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyCommitsShipped } from "./verify-commits-shipped.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

interface Repo {
  path: string;
}

function makeRepo(): Repo {
  const path = mkdtempSync(join(tmpdir(), "verify-commits-shipped-"));
  git(path, ["init", "--quiet", "--initial-branch=main"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "Test"]);
  git(path, ["commit", "--allow-empty", "-m", "root"]);
  return { path };
}

function commit(repo: Repo, message: string): string {
  git(repo.path, ["commit", "--allow-empty", "-m", message]);
  return git(repo.path, ["rev-parse", "HEAD"]);
}

function makeRemote(local: Repo): Repo {
  const path = mkdtempSync(join(tmpdir(), "verify-commits-shipped-remote-"));
  git(path, ["init", "--bare", "--quiet", "--initial-branch=main"]);
  git(local.path, ["remote", "add", "origin", path]);
  git(local.path, ["push", "--quiet", "origin", "main"]);
  return { path };
}

describe("verifyCommitsShipped", () => {
  let local: Repo;
  let remote: Repo;

  beforeEach(() => {
    local = makeRepo();
    remote = makeRemote(local);
  });

  afterEach(() => {
    rmSync(local.path, { recursive: true, force: true });
    rmSync(remote.path, { recursive: true, force: true });
  });

  it("returns ok when every sha is an ancestor of origin/main", async () => {
    // A sha that's already on origin/main (the root we pushed at setup).
    const rootSha = git(local.path, ["rev-parse", "HEAD"]);
    const result = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [rootSha],
    });
    expect(result).toEqual({ ok: true, missing: [], unresolved: [] });
  });

  it("reports missing when a sha is on the local branch but NOT on origin/main", async () => {
    // Commit locally without pushing — this is the DX-559 failure mode.
    const localOnlySha = commit(local, "local only");
    const result = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [localOnlySha],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([localOnlySha]);
    expect(result.unresolved).toEqual([]);
  });

  it("partitions a mixed list into shipped vs missing", async () => {
    const rootSha = git(local.path, ["rev-parse", "HEAD"]);
    const localOnly = commit(local, "local only");

    const result = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [rootSha, localOnly],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([localOnly]);
    expect(result.unresolved).toEqual([]);
  });

  it("classifies an unresolvable sha as missing AND unresolved", async () => {
    const bogus = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const result = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [bogus],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([bogus]);
    expect(result.unresolved).toEqual([bogus]);
  });

  it("returns ok for an empty sha list (docs-only / no commit)", async () => {
    const result = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [],
    });
    expect(result).toEqual({ ok: true, missing: [], unresolved: [] });
  });

  it("skips empty / non-string entries instead of treating them as failures", async () => {
    const result = await verifyCommitsShipped({
      repoLocalPath: local.path,
      // Intentional malformed input — caller may pass through whatever
      // landed in YAML; the verifier should not blow up on it.
      shas: ["", null as unknown as string, undefined as unknown as string],
    });
    expect(result.ok).toBe(true);
  });

  it("verifies a sha that was pushed (lands on origin/main after push)", async () => {
    const pushed = commit(local, "will push");
    git(local.path, ["push", "--quiet", "origin", "main"]);
    const result = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [pushed],
    });
    expect(result.ok).toBe(true);
  });

  it("respects a custom gitRef parameter", async () => {
    git(local.path, ["checkout", "-b", "agent", "--quiet"]);
    const agentSha = commit(local, "agent work");
    git(local.path, ["push", "--quiet", "origin", "agent"]);

    // Against origin/agent the sha IS an ancestor.
    const againstAgent = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [agentSha],
      gitRef: "origin/agent",
    });
    expect(againstAgent.ok).toBe(true);

    // Against origin/main it is NOT — never merged.
    const againstMain = await verifyCommitsShipped({
      repoLocalPath: local.path,
      shas: [agentSha],
      gitRef: "origin/main",
    });
    expect(againstMain.ok).toBe(false);
    expect(againstMain.missing).toEqual([agentSha]);
  });
});
