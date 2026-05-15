/**
 * DX-559 — Integration suite for enforceCommitsShipped.
 *
 * Spins up a real temp git repo per test, lays a YAML fixture into
 * `<repo>/.danxbot/issues/open/<id>.yml` with a known `retro.commits[]`
 * value, and asserts that the helper correctly classifies shipped vs
 * not-shipped state. Mirrors the layout of `verify-commits-shipped.test.ts`
 * (real git, no mocks) — anything less than a real repo would dodge the
 * exact bug DX-559 is fixing (ancestry against `origin/main`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { enforceCommitsShipped } from "./enforce-commits-shipped.js";
import {
  createEmptyIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import type { Issue } from "../issue-tracker/interface.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

interface Setup {
  local: string;
  remote: string;
}

function makeRepoPair(): Setup {
  const local = mkdtempSync(resolve(tmpdir(), "enforce-commits-shipped-local-"));
  const remote = mkdtempSync(
    resolve(tmpdir(), "enforce-commits-shipped-remote-"),
  );
  git(remote, ["init", "--bare", "--quiet", "--initial-branch=main"]);
  git(local, ["init", "--quiet", "--initial-branch=main"]);
  git(local, ["config", "user.email", "test@example.com"]);
  git(local, ["config", "user.name", "Test"]);
  git(local, ["commit", "--allow-empty", "-m", "root"]);
  git(local, ["remote", "add", "origin", remote]);
  git(local, ["push", "--quiet", "origin", "main"]);
  mkdirSync(join(local, ".danxbot/issues/open"), { recursive: true });
  return { local, remote };
}

function writeIssueFixture(
  repoLocalPath: string,
  id: string,
  retroCommits: string[],
): void {
  const base = createEmptyIssue({
    id,
    status: "Done",
    title: `${id} title`,
    description: "fixture",
  });
  const issue: Issue = {
    ...base,
    retro: {
      good: "g",
      bad: "b",
      action_item_ids: [],
      commits: retroCommits,
    },
  };
  writeFileSync(
    join(repoLocalPath, ".danxbot/issues/open", `${id}.yml`),
    serializeIssue(issue),
  );
}

describe("enforceCommitsShipped", () => {
  let setup: Setup;

  beforeEach(() => {
    setup = makeRepoPair();
  });

  afterEach(() => {
    rmSync(setup.local, { recursive: true, force: true });
    rmSync(setup.remote, { recursive: true, force: true });
  });

  it("returns null when retro.commits[] is empty (docs-only branch)", async () => {
    writeIssueFixture(setup.local, "DX-1", []);
    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-1",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).toBeNull();
  });

  it("returns null when every sha is reachable from origin/main", async () => {
    const rootSha = git(setup.local, ["rev-parse", "HEAD"]);
    writeIssueFixture(setup.local, "DX-2", [rootSha]);
    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-2",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).toBeNull();
  });

  it("returns a Violation when an agent committed locally but never pushed", async () => {
    // This is the DX-557 / DX-559 reproducer. Agent's branch carries the
    // sha; origin/main does not.
    git(setup.local, ["checkout", "-b", "dani", "--quiet"]);
    git(setup.local, ["commit", "--allow-empty", "-m", "agent work"]);
    const agentSha = git(setup.local, ["rev-parse", "HEAD"]);

    writeIssueFixture(setup.local, "DX-3", [agentSha]);

    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-3",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).not.toBeNull();
    expect(result!.missingShas).toEqual([agentSha]);
    expect(result!.reason).toContain("DX-559");
    expect(result!.reason).toContain(agentSha);
    expect(result!.reason).toContain("origin/main");
  });

  it("returns a Violation listing only the unshipped shas in a mixed list", async () => {
    const rootSha = git(setup.local, ["rev-parse", "HEAD"]);
    git(setup.local, ["checkout", "-b", "dani", "--quiet"]);
    git(setup.local, ["commit", "--allow-empty", "-m", "agent work"]);
    const agentSha = git(setup.local, ["rev-parse", "HEAD"]);

    writeIssueFixture(setup.local, "DX-4", [rootSha, agentSha]);

    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-4",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).not.toBeNull();
    expect(result!.missingShas).toEqual([agentSha]);
    expect(result!.unresolvedShas).toEqual([]);
  });

  it("classifies a bogus sha as unresolved + missing", async () => {
    const bogus = "0000000000000000000000000000000000000000";
    writeIssueFixture(setup.local, "DX-5", [bogus]);
    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-5",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).not.toBeNull();
    expect(result!.missingShas).toEqual([bogus]);
    expect(result!.unresolvedShas).toEqual([bogus]);
  });

  it("returns null when the candidate YAML does not exist (idempotent on stray invocations)", async () => {
    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-99",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).toBeNull();
  });

  it("returns null when the candidate YAML is unparseable (does not turn YAML corruption into a stall)", async () => {
    writeFileSync(
      join(setup.local, ".danxbot/issues/open/DX-7.yml"),
      "this is not valid yaml: [[[",
    );
    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-7",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).toBeNull();
  });

  it("fetchOrigin=true exercises the fetch path and proceeds when the remote is reachable", async () => {
    const rootSha = git(setup.local, ["rev-parse", "HEAD"]);
    writeIssueFixture(setup.local, "DX-900", [rootSha]);
    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-900",
      expectedPrefix: "DX",
      fetchOrigin: true,
    });
    expect(result).toBeNull();
  });

  it("fetchOrigin=true swallows fetch failures (logs + verifies against stale local ref)", async () => {
    // Tear down the remote BEFORE invoking the helper — `git fetch` will
    // fail but the helper must NOT throw; it logs at warn and proceeds
    // with whatever local origin/main already points at. The sha was
    // already on origin/main from setup, so verification still passes.
    const rootSha = git(setup.local, ["rev-parse", "HEAD"]);
    rmSync(setup.remote, { recursive: true, force: true });
    writeIssueFixture(setup.local, "DX-901", [rootSha]);

    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-901",
      expectedPrefix: "DX",
      fetchOrigin: true,
    });
    expect(result).toBeNull();
  });

  it("acceptance — repro of DX-557 scenario: agent finalizes correctly, no violation", async () => {
    // AC2 from DX-559: synthetic card on a peer worktree → marked Done →
    // commits land on origin/main BEFORE the card closes. Simulates the
    // agent-finalize.sh happy path: agent commits on its branch, pushes
    // HEAD:main, retro.commits[] holds the pushed sha. Verification ok.
    git(setup.local, ["checkout", "-b", "dani", "--quiet"]);
    git(setup.local, ["commit", "--allow-empty", "-m", "feat(DX-557): work"]);
    git(setup.local, ["push", "--quiet", "origin", "HEAD:main"]);
    git(setup.local, ["fetch", "--quiet", "origin"]);
    const pushedSha = git(setup.local, ["rev-parse", "origin/main"]);

    writeIssueFixture(setup.local, "DX-557", [pushedSha]);

    const result = await enforceCommitsShipped({
      repoLocalPath: setup.local,
      candidateId: "DX-557",
      expectedPrefix: "DX",
      fetchOrigin: false,
    });
    expect(result).toBeNull();
  });
});
