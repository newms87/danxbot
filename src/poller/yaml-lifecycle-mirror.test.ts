/**
 * writeIssue ↔ DB mirror contract (post-DX-549 — writer-owned).
 *
 * Writer OWNS the DB write via a synchronous `upsertIssueRowNow` call
 * BEFORE `writeFileSync`, so the DB row is consistent the moment
 * `writeIssue` resolves. The chokidar watcher is a backstop: its later
 * event finds the hash already matches and runs the skip-match branch
 * (which still fires `onWatcherUpsert` so reconcile fanout happens
 * exactly once per writer save).
 *
 * Behaviors pinned here:
 *   1. With a registered mirror: `writeIssue` upserts the DB row
 *      synchronously (before the file write) and resolves. No watcher
 *      event needed for the writer's promise to settle.
 *   2. With no mirror registered: `writeIssue` returns after the file
 *      write (legacy path — no DB activity).
 *
 * The mirror layer is mocked via `IssuesMirrorDb`; chokidar is disabled.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  startIssuesMirror,
  type IssuesMirror,
  type IssuesMirrorDb,
  type UpsertArgs,
} from "../db/issues-mirror.js";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { writeIssue } from "./yaml-lifecycle.js";
import type { Issue } from "../issue-tracker/interface.js";

function makeRepo(): { localPath: string; tmpdir: string } {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-write-mirror-"));
  mkdirSync(resolve(root, ".danxbot", "issues", "open"), { recursive: true });
  mkdirSync(resolve(root, ".danxbot", "issues", "closed"), { recursive: true });
  return { localPath: root, tmpdir: root };
}

function makeIssue(id: string): Issue {
  return {
    schema_version: 9,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: `Test ${id}`,
    description: `desc ${id}`,
    priority: 3,
    position: null,
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
    history: [],
    retro: {
      good: "",
      bad: "",
      action_item_ids: [],
      commits: [],
    },
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    db_updated_at: "",
  };
}

interface FakeDb extends IssuesMirrorDb {
  rows: Map<string, { data: Record<string, unknown>; content_hash: string }>;
  upserts: UpsertArgs[];
}

function createFakeDb(): FakeDb {
  const rows = new Map<
    string,
    { data: Record<string, unknown>; content_hash: string }
  >();
  const upserts: UpsertArgs[] = [];
  const db: FakeDb = {
    rows,
    upserts,
    async selectExisting(repoName, id) {
      return rows.get(`${repoName}|${id}`) ?? null;
    },
    async upsertWithHistory(args) {
      rows.set(`${args.repoName}|${args.id}`, {
        data: args.data,
        content_hash: args.contentHash,
      });
      upserts.push(args);
    },
    async tombstone(args) {
      rows.delete(`${args.repoName}|${args.id}`);
    },
    async listIds(repoName) {
      const out: Array<{ id: string; content_hash: string }> = [];
      for (const [key, row] of rows) {
        const [r, id] = key.split("|");
        if (r === repoName) out.push({ id, content_hash: row.content_hash });
      }
      return out;
    },
  };
  return db;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("writeIssue ↔ mirror — read-your-writes", () => {
  it("upserts the DB row synchronously (writer owns the DB write)", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const mirror = await startIssuesMirror(
      { name: "rw-repo", localPath: repo.localPath },
      { db, disableWatcher: true, reconcileIntervalMs: 0 },
    );
    try {
      const issue = makeIssue("DX-1");
      // DX-547 Phase 2: writer upserts BEFORE writeFileSync. After
      // `writeIssue` resolves, the DB row is in place and the file is
      // on disk. No watcher event needed — `startIssuesMirror` registered
      // the writer DB, and `upsertIssueRowNow` ran the same transaction
      // shape as the watcher's `mirrorOne`.
      await writeIssue(repo.localPath, issue);

      const open = resolve(
        repo.localPath,
        ".danxbot",
        "issues",
        "open",
        "DX-1.yml",
      );
      expect(readFileSync(open, "utf-8")).toContain("DX-1");

      // DB row carries the writer's content + the history row was
      // tagged `source: "writer"`.
      const stored = db.rows.get("rw-repo|DX-1");
      expect(stored).not.toBeUndefined();
      expect(db.upserts).toHaveLength(1);
      expect(db.upserts[0]!.source).toBe("writer");
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  it("returns immediately when no mirror is active (legacy path)", async () => {
    const repo = makeRepo();
    try {
      // No mirror registered for this repoLocalPath.
      const issue = makeIssue("DX-2");
      const start = Date.now();
      await writeIssue(repo.localPath, issue);
      const elapsed = Date.now() - start;
      // Legacy path is just writeFileSync — well under 100ms even on a
      // slow machine. No 5s mirror timeout.
      expect(elapsed).toBeLessThan(500);

      const open = resolve(
        repo.localPath,
        ".danxbot",
        "issues",
        "open",
        "DX-2.yml",
      );
      expect(readFileSync(open, "utf-8")).toContain("DX-2");
    } finally {
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

});
