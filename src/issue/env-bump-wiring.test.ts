/**
 * DX-640 / Phase 2 of DX-638 — bump-site wiring assertions.
 *
 * The skip-cache in `reconcile.ts` short-circuits steady-state reconciles
 * based on `(cardHash, envGen)`. The bump-site contract is what keeps
 * `envGen` honest: every writer that mutates an environment input
 * (lists.yaml, settings.json `agents{}`, any card's `children[]` /
 * `parent_id`, any tombstone) bumps the per-repo counter; everything
 * else MUST NOT bump (otherwise the cache thrashes).
 *
 * This file asserts each wired bump fires at the right moment AND that
 * unrelated writes (display patches, title-only edits) do NOT bump.
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
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defaultLists, writeLists, ensureListsFile } from "../lists-file.js";
import {
  defaultSettings,
  mutateAgents,
  writeSettings,
  type AgentRecord,
} from "../settings-file.js";
import {
  getEnvGen,
  graphFieldsChanged,
  _resetEnvGen,
} from "./env-generation.js";
import { clearAllRepoNames, setRepoName } from "../poller/repo-name.js";
import {
  upsertIssueRowNow,
  registerWriterDb,
  unregisterWriterDb,
  type IssuesMirrorDb,
} from "../db/issues-mirror.js";

function makeTmpRepo(name: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-bump-"));
  mkdirSync(resolve(root, ".danxbot"), { recursive: true });
  setRepoName(root, name);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeAgent(_name: string, opts: Partial<AgentRecord> = {}): AgentRecord {
  return {
    type: "agent",
    bio: "",
    capabilities: ["issue-worker"],
    schedule: { tz: "UTC", windows: [] },
    enabled: true,
    broken: null,
    strikes: {
      count: 0,
      history: [],
    },
    effortLevel: "medium",
    created_at: "2026-05-18T00:00:00Z",
    updated_at: "2026-05-18T00:00:00Z",
    ...opts,
  } as AgentRecord;
}

beforeEach(() => {
  _resetEnvGen();
  clearAllRepoNames();
});

afterEach(() => {
  clearAllRepoNames();
});

describe("lists-file → bumpEnvGen wiring (AC#5)", () => {
  let ctx: ReturnType<typeof makeTmpRepo>;

  beforeEach(async () => {
    ctx = makeTmpRepo("test-repo");
    // Seed the file so subsequent `writeLists` calls have a base.
    await ensureListsFile(ctx.root);
    // ensureListsFile uses writeListsRawUnsafe; the boot path does NOT
    // bump (no operator-visible mutation yet). Confirm baseline.
    expect(getEnvGen("test-repo")).toBe(0);
  });

  afterEach(() => ctx.cleanup());

  it("writeLists bumps envGen exactly once per call", async () => {
    const before = defaultLists();
    await writeLists(ctx.root, before);
    expect(getEnvGen("test-repo")).toBe(1);
    await writeLists(ctx.root, before);
    expect(getEnvGen("test-repo")).toBe(2);
  });
});

describe("settings-file → bumpEnvGen wiring (AC#5)", () => {
  let ctx: ReturnType<typeof makeTmpRepo>;

  beforeEach(() => {
    ctx = makeTmpRepo("test-repo");
  });

  afterEach(() => ctx.cleanup());

  it("writeSettings({display}) does NOT bump (unrelated to agents map)", async () => {
    // Seed the file with a baseline write — this WILL bump because it
    // creates the initial `agents: {}` map and the comparator treats
    // the first write as a mutation. Read the counter AFTER seeding so
    // subsequent assertions are deltas.
    await writeSettings(ctx.root, {
      display: { worker: { port: 5566 } },
      writtenBy: "dashboard:test",
    });
    const baseline = getEnvGen("test-repo");

    // Display-only patch — agents map unchanged.
    await writeSettings(ctx.root, {
      display: { worker: { port: 5567 } },
      writtenBy: "dashboard:test",
    });
    expect(getEnvGen("test-repo")).toBe(baseline);
  });

  it("writeSettings({overrides}) does NOT bump", async () => {
    await writeSettings(ctx.root, {
      display: { worker: { port: 5566 } },
      writtenBy: "dashboard:test",
    });
    const baseline = getEnvGen("test-repo");

    await writeSettings(ctx.root, {
      overrides: { slack: { enabled: true } },
      writtenBy: "dashboard:test",
    });
    expect(getEnvGen("test-repo")).toBe(baseline);
  });

  it("writeSettings({agents}) with NEW key bumps", async () => {
    await writeSettings(ctx.root, {
      display: { worker: { port: 5566 } },
      writtenBy: "dashboard:test",
    });
    const baseline = getEnvGen("test-repo");

    await writeSettings(ctx.root, {
      agents: { alice: makeAgent("alice") },
      writtenBy: "dashboard:test",
    });
    expect(getEnvGen("test-repo")).toBe(baseline + 1);
  });

  it("writeSettings({agents}) with IDENTICAL existing key does NOT bump (idempotent)", async () => {
    const alice = makeAgent("alice");
    await writeSettings(ctx.root, {
      agents: { alice },
      writtenBy: "dashboard:test",
    });
    const baseline = getEnvGen("test-repo");

    // Same key, identical record content.
    await writeSettings(ctx.root, {
      agents: { alice },
      writtenBy: "dashboard:test",
    });
    expect(getEnvGen("test-repo")).toBe(baseline);
  });

  it("mutateAgents() that drops an existing key bumps", async () => {
    await writeSettings(ctx.root, {
      agents: { alice: makeAgent("alice"), bob: makeAgent("bob") },
      writtenBy: "dashboard:test",
    });
    const baseline = getEnvGen("test-repo");

    await mutateAgents(
      ctx.root,
      (current) => {
        const next = { ...current };
        delete next.bob;
        return next;
      },
      "dashboard:test",
    );
    expect(getEnvGen("test-repo")).toBe(baseline + 1);
  });

  it("mutateAgents() that returns identical map does NOT bump", async () => {
    const alice = makeAgent("alice");
    await writeSettings(ctx.root, {
      agents: { alice },
      writtenBy: "dashboard:test",
    });
    const baseline = getEnvGen("test-repo");

    await mutateAgents(ctx.root, (current) => current, "dashboard:test");
    expect(getEnvGen("test-repo")).toBe(baseline);
  });
});

describe("issues-mirror → bumpEnvGen wiring (AC#5)", () => {
  let ctx: ReturnType<typeof makeTmpRepo>;

  /**
   * Minimal in-memory IssuesMirrorDb stub. Records the (data,
   * contentHash) per id; `selectExisting` returns the prior value,
   * `upsertWithHistory` overwrites. This exercises the bump-on-graph-
   * change gate without needing Postgres.
   */
  function makeFakeDb(): IssuesMirrorDb & {
    rows: Map<string, { data: Record<string, unknown>; content_hash: string }>;
  } {
    const rows = new Map<
      string,
      { data: Record<string, unknown>; content_hash: string }
    >();
    return {
      rows,
      async selectExisting(_repoName, id) {
        return rows.get(id) ?? null;
      },
      async upsertWithHistory(args) {
        rows.set(args.id, {
          data: args.data,
          content_hash: args.contentHash,
        });
      },
      async tombstone(args) {
        rows.delete(args.id);
      },
      async listIds(_repoName) {
        return Array.from(rows.entries()).map(([id, r]) => ({
          id,
          content_hash: r.content_hash,
        }));
      },
    };
  }

  beforeEach(() => {
    ctx = makeTmpRepo("test-repo");
  });

  afterEach(() => {
    unregisterWriterDb(ctx.root);
    ctx.cleanup();
  });

  it("upsertIssueRowNow bumps when graph fields move (parent_id non-null on new card)", async () => {
    const db = makeFakeDb();
    registerWriterDb(ctx.root, db);

    await upsertIssueRowNow({
      repoLocalPath: ctx.root,
      repoName: "test-repo",
      id: "DX-1",
      data: { id: "DX-1", parent_id: "DX-100", children: [] },
      contentHash: "hash-1",
      source: "writer",
    });

    // graphFieldsChanged(null, {parent_id: "DX-100", ...}) → true (new card).
    expect(getEnvGen("test-repo")).toBe(1);
  });

  it("upsertIssueRowNow does NOT bump on title-only re-write (no graph movement)", async () => {
    const db = makeFakeDb();
    registerWriterDb(ctx.root, db);

    await upsertIssueRowNow({
      repoLocalPath: ctx.root,
      repoName: "test-repo",
      id: "DX-2",
      data: {
        id: "DX-2",
        parent_id: null,
        children: [],
        title: "original",
      },
      contentHash: "h1",
      source: "writer",
    });
    const baseline = getEnvGen("test-repo");
    expect(baseline).toBe(1); // first write = brand-new card = mutation.

    // Second write — same parent_id + same children, title changed.
    await upsertIssueRowNow({
      repoLocalPath: ctx.root,
      repoName: "test-repo",
      id: "DX-2",
      data: {
        id: "DX-2",
        parent_id: null,
        children: [],
        title: "renamed",
      },
      contentHash: "h2",
      source: "writer",
    });
    expect(getEnvGen("test-repo")).toBe(baseline);
  });

  it("upsertIssueRowNow bumps when children[] changes on an existing card", async () => {
    const db = makeFakeDb();
    registerWriterDb(ctx.root, db);

    await upsertIssueRowNow({
      repoLocalPath: ctx.root,
      repoName: "test-repo",
      id: "DX-3",
      data: { id: "DX-3", parent_id: null, children: [] },
      contentHash: "h1",
      source: "writer",
    });
    const baseline = getEnvGen("test-repo");

    await upsertIssueRowNow({
      repoLocalPath: ctx.root,
      repoName: "test-repo",
      id: "DX-3",
      data: { id: "DX-3", parent_id: null, children: ["DX-3a"] },
      contentHash: "h2",
      source: "writer",
    });
    expect(getEnvGen("test-repo")).toBe(baseline + 1);
  });

  it("upsertIssueRowNow canonical-no-op (same hash) does NOT touch envGen", async () => {
    const db = makeFakeDb();
    registerWriterDb(ctx.root, db);

    await upsertIssueRowNow({
      repoLocalPath: ctx.root,
      repoName: "test-repo",
      id: "DX-4",
      data: { id: "DX-4", parent_id: "DX-100", children: [] },
      contentHash: "h-same",
      source: "writer",
    });
    const baseline = getEnvGen("test-repo");

    // Same content_hash → upsertIssueRowNow short-circuits BEFORE the
    // upsert + bump path. envGen MUST stay put.
    await upsertIssueRowNow({
      repoLocalPath: ctx.root,
      repoName: "test-repo",
      id: "DX-4",
      data: { id: "DX-4", parent_id: "DX-100", children: [] },
      contentHash: "h-same",
      source: "writer",
    });
    expect(getEnvGen("test-repo")).toBe(baseline);
  });
});
