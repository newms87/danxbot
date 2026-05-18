/**
 * DX-640 / Phase 2 of DX-638 — pure-projection invariant.
 *
 * The Kubernetes-style controller contract: `desired =
 * deriveAll(observed, env)`. Steady-state runs (observed unchanged AND
 * env unchanged) produce `desired === observed`, an empty action set,
 * and ZERO side effects — no history append, no YAML write, no
 * tracker push, no recursion.
 *
 * These tests load a card, run `reconcileIssue` twice, and assert the
 * second run is a no-op modulo the in-memory caches reconcile
 * maintains.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import {
  reconcileIssue,
  _resetReconcileMutexes,
  _resetDispatchableCache,
  _resetTriageExpiresCache,
  _resetLastPushedHashes,
  _resetSkipCache,
  _getSkipCacheEntry,
  type ReconcileRepoContext,
} from "./reconcile.js";
import { bumpEnvGen, _resetEnvGen } from "./env-generation.js";
import { clearAllRepoNames, setRepoName } from "../poller/repo-name.js";

function makeIssue(id: string, status: IssueStatus = "ToDo"): Issue {
  return {
    schema_version: 11,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status,
    type: "Feature",
    title: `Title for ${id}`,
    description: "Body",
    priority: 3.0,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };
}

function makeRepoCtx(): {
  cleanup: () => void;
  repo: ReconcileRepoContext;
  openDir: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-reconcile-idem-"));
  const openDir = resolve(root, ".danxbot", "issues", "open");
  const closedDir = resolve(root, ".danxbot", "issues", "closed");
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  // Register the repo name so `repoNameFromPath` resolves to "test-repo"
  // instead of the tmpdir basename — keeps the test's `bumpEnvGen` calls
  // aimed at the same key reconcile reads from.
  setRepoName(root, "test-repo");
  return {
    repo: { name: "test-repo", localPath: root, issuePrefix: "DX" },
    openDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeYaml(dir: string, id: string, issue: Issue): string {
  const path = resolve(dir, `${id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

beforeEach(async () => {
  _resetReconcileMutexes();
  _resetDispatchableCache();
  _resetTriageExpiresCache();
  _resetLastPushedHashes();
  _resetSkipCache();
  _resetEnvGen();
  clearAllRepoNames();
  const triageTimer = await import("../dispatch/triage-timer.js");
  triageTimer._clearAllTriageTimers();
});

describe("reconcileIssue — pure-projection idempotency (DX-640)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("second reconcile on a steady-state card is a no-op (SKIP via cache)", async () => {
    const issue = makeIssue("DX-1");
    const path = writeYaml(ctx.openDir, "DX-1", issue);
    const beforeBytes = readFileSync(path, "utf-8");
    const beforeMtimeMs = statSync(path).mtimeMs;

    // Run 1: cache miss, full reconcile body (no derivations fire on
    // this empty-children card → mutatedFlag false → no write, no
    // history). Skip-cache gets stamped at end-of-body.
    const r1 = await reconcileIssue(ctx.repo, "DX-1", "watcher");
    expect(r1.changed).toBe(false);
    // First-observation pokes scheduler when dispatchable.
    expect(r1.fanout.dispatchableChanged).toBe(true);
    expect(_getSkipCacheEntry("test-repo", "DX-1")).toBeDefined();

    // Run 2: skip-cache hits (same hash, same envGen). The fast-path
    // returns BEFORE any derive / write / history step runs.
    const r2 = await reconcileIssue(ctx.repo, "DX-1", "watcher");
    expect(r2.changed).toBe(false);
    expect(r2.prevHash).toBe(r1.prevHash);
    expect(r2.nextHash).toBe(r1.nextHash);
    // dispatchableChanged is false on cache-hit (the prior reconcile
    // already stamped + poked; nothing new for the scheduler).
    expect(r2.fanout.dispatchableChanged).toBe(false);
    expect(r2.fanout.parentId).toBeNull();
    expect(r2.fanout.dependents).toEqual([]);
    expect(r2.errors).toEqual([]);

    // No file write happened on either run — bytes + mtime unchanged.
    expect(readFileSync(path, "utf-8")).toBe(beforeBytes);
    expect(statSync(path).mtimeMs).toBe(beforeMtimeMs);

    // History is empty on disk and stays empty — no projection
    // re-affirm emitted an entry.
    const reread = readFileSync(path, "utf-8");
    expect(reread).not.toMatch(/worker:auto-derive/);
    expect(reread).not.toMatch(/worker:heal/);
  });

  it("envGen bump between runs invalidates skip-cache (re-derives on next reconcile)", async () => {
    const issue = makeIssue("DX-2");
    writeYaml(ctx.openDir, "DX-2", issue);

    const r1 = await reconcileIssue(ctx.repo, "DX-2", "watcher");
    expect(r1.changed).toBe(false);
    const cached1 = _getSkipCacheEntry("test-repo", "DX-2");
    expect(cached1).toBeDefined();
    expect(cached1!.envGen).toBe(0);

    // Operator-style mutation elsewhere bumps the per-repo counter.
    // The candidate card's hash hasn't moved, but the cache key
    // (hash, envGen) now differs from what's stamped.
    bumpEnvGen("test-repo", "operator simulated change");

    const r2 = await reconcileIssue(ctx.repo, "DX-2", "watcher");
    // Body ran (no skip). For an empty-children card the derive
    // produces no actions, so `changed: false` still holds, but the
    // skip-cache entry was re-stamped with the new envGen.
    expect(r2.changed).toBe(false);
    const cached2 = _getSkipCacheEntry("test-repo", "DX-2");
    expect(cached2!.envGen).toBe(1);
    expect(cached2!.hash).toBe(cached1!.hash);
  });

  it("file write between runs invalidates skip-cache (hash changes)", async () => {
    const issue = makeIssue("DX-3");
    const path = writeYaml(ctx.openDir, "DX-3", issue);

    const r1 = await reconcileIssue(ctx.repo, "DX-3", "watcher");
    const hash1 = r1.prevHash!;

    // Operator-style edit: change title, leave everything else.
    const issue2: Issue = { ...issue, title: "Updated title" };
    writeFileSync(path, serializeIssue(issue2));

    const r2 = await reconcileIssue(ctx.repo, "DX-3", "watcher");
    expect(r2.prevHash).not.toBe(hash1);
    expect(r2.changed).toBe(false); // still no derivation needed
    const cached = _getSkipCacheEntry("test-repo", "DX-3");
    expect(cached!.hash).toBe(r2.nextHash);
  });

  it("tombstone clears skip-cache so a recreated id triggers a fresh reconcile", async () => {
    const issue = makeIssue("DX-4");
    const path = writeYaml(ctx.openDir, "DX-4", issue);

    await reconcileIssue(ctx.repo, "DX-4", "watcher");
    expect(_getSkipCacheEntry("test-repo", "DX-4")).toBeDefined();

    // File deleted → next reconcile sees tombstone.
    rmSync(path);
    const tombstoneResult = await reconcileIssue(ctx.repo, "DX-4", "watcher");
    expect(tombstoneResult.changed).toBe(false);
    expect(tombstoneResult.prevHash).toBeNull();
    expect(_getSkipCacheEntry("test-repo", "DX-4")).toBeUndefined();
  });

  it("partial-body throw (validation error) does NOT stamp skip-cache (re-attempt next run)", async () => {
    // Plant a malformed YAML — reconcile throws BEFORE reaching the
    // end-of-body stamp. The skip-cache must NOT carry an entry that
    // would let a subsequent reconcile short-circuit past the same
    // failure path on the next fire.
    const path = resolve(ctx.openDir, "DX-6.yml");
    writeFileSync(path, "id: DX-6\n  not: { valid yaml :::");

    await expect(
      reconcileIssue(ctx.repo, "DX-6", "watcher"),
    ).rejects.toBeDefined();
    expect(_getSkipCacheEntry("test-repo", "DX-6")).toBeUndefined();

    // Recover; first successful reconcile populates the cache.
    writeFileSync(path, serializeIssue(makeIssue("DX-6")));
    await reconcileIssue(ctx.repo, "DX-6", "watcher");
    expect(_getSkipCacheEntry("test-repo", "DX-6")).toBeDefined();
  });

  it("emits ZERO file writes across 10 consecutive reconciles on a steady-state card", async () => {
    const issue = makeIssue("DX-5", "Done"); // Done in open/ would trigger a heal-move ONCE.
    writeYaml(ctx.openDir, "DX-5", issue);

    // Run 1: heal moves Done → closed/. ONE write happens here.
    const r1 = await reconcileIssue(ctx.repo, "DX-5", "watcher");
    expect(r1.changed).toBe(true);
    const closedPath = resolve(
      ctx.repo.localPath,
      ".danxbot",
      "issues",
      "closed",
      "DX-5.yml",
    );
    const afterMoveMtime = statSync(closedPath).mtimeMs;

    // Runs 2-10: skip-cache hits every time. No further writes.
    for (let i = 0; i < 9; i++) {
      const r = await reconcileIssue(ctx.repo, "DX-5", "watcher");
      expect(r.changed).toBe(false);
    }
    // mtime invariant — the file has not been re-written since the
    // initial heal move.
    expect(statSync(closedPath).mtimeMs).toBe(afterMoveMtime);
  });
});
