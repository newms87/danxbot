import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createPgIssuesMirrorDb,
  getWriterDb,
  registerWriterDb,
  startIssuesMirror,
  unregisterWriterDb,
  upsertIssueRowNow,
  type IssuesMirror,
  type IssuesMirrorDb,
  type UpsertArgs,
  type TombstoneArgs,
} from "./issues-mirror.js";
import { canonicalize, sha256 } from "./canonicalize.js";
import { flagPath, readFlag } from "../critical-failure.js";

interface DbStateRow {
  data: Record<string, unknown>;
  content_hash: string;
}

interface FakeDb extends IssuesMirrorDb {
  rows: Map<string, DbStateRow>;
  history: UpsertArgs[];
  tombstones: TombstoneArgs[];
  /** When set, every operation throws this error (fault injection). */
  fail?: Error;
  /** When set, only the next op throws and the flag is then cleared. */
  failOnce?: Error;
}

function rowKey(repoName: string, id: string): string {
  return `${repoName}|${id}`;
}

function createFakeDb(): FakeDb {
  const rows = new Map<string, DbStateRow>();
  const history: UpsertArgs[] = [];
  const tombstones: TombstoneArgs[] = [];
  const db: FakeDb = {
    rows,
    history,
    tombstones,
    async selectExisting(repoName, id) {
      maybeFail(db);
      return rows.get(rowKey(repoName, id)) ?? null;
    },
    async upsertWithHistory(args) {
      maybeFail(db);
      rows.set(rowKey(args.repoName, args.id), {
        data: args.data,
        content_hash: args.contentHash,
      });
      history.push(args);
    },
    async tombstone(args) {
      maybeFail(db);
      rows.delete(rowKey(args.repoName, args.id));
      tombstones.push(args);
    },
    async listIds(repoName) {
      maybeFail(db);
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

function maybeFail(db: FakeDb): void {
  if (db.failOnce) {
    const err = db.failOnce;
    db.failOnce = undefined;
    throw err;
  }
  if (db.fail) throw db.fail;
}

function makeRepo(): { tmpdir: string; localPath: string; name: string } {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-mirror-"));
  const localPath = root;
  mkdirSync(resolve(localPath, ".danxbot", "issues", "open"), {
    recursive: true,
  });
  mkdirSync(resolve(localPath, ".danxbot", "issues", "closed"), {
    recursive: true,
  });
  return { tmpdir: root, localPath, name: "test-repo" };
}

function writeYaml(
  localPath: string,
  state: "open" | "closed",
  id: string,
  content: string,
): string {
  const path = resolve(localPath, ".danxbot", "issues", state, `${id}.yml`);
  writeFileSync(path, content);
  return path;
}

const SAMPLE_YAML = (id: string, status = "ToDo") =>
  `id: ${id}\nstatus: ${status}\ntype: Feature\n`;

const PARSED_SAMPLE = (id: string, status = "ToDo") => ({
  id,
  status,
  type: "Feature",
});

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("issues-mirror — per-event flow (mocked DB, simulated watcher)", () => {
  let repo: ReturnType<typeof makeRepo>;
  let db: FakeDb;
  let mirror: IssuesMirror;

  beforeEach(async () => {
    repo = makeRepo();
    db = createFakeDb();
    mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await mirror.stop();
    rmSync(repo.tmpdir, { recursive: true, force: true });
  });

  it("add event: upserts row + appends history with prev_hash null", async () => {
    const path = writeYaml(repo.localPath, "open", "DX-1", SAMPLE_YAML("DX-1"));
    await mirror.simulateWatcherEvent({ event: "add", path });
    expect(db.rows.get(rowKey("test-repo", "DX-1"))).toMatchObject({
      data: PARSED_SAMPLE("DX-1"),
    });
    expect(db.history).toHaveLength(1);
    expect(db.history[0]).toMatchObject({
      id: "DX-1",
      prevHash: null,
      source: "watcher",
    });
    expect(db.history[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("change event with same content: no upsert, no history", async () => {
    const path = writeYaml(repo.localPath, "open", "DX-2", SAMPLE_YAML("DX-2"));
    await mirror.simulateWatcherEvent({ event: "add", path });
    const before = db.history.length;
    await mirror.simulateWatcherEvent({ event: "change", path });
    expect(db.history.length).toBe(before);
  });

  it("change event with new content: upsert + history with correct prev/next hashes", async () => {
    const path = writeYaml(repo.localPath, "open", "DX-3", SAMPLE_YAML("DX-3"));
    await mirror.simulateWatcherEvent({ event: "add", path });
    const firstHash = db.history[0].contentHash;

    writeFileSync(path, SAMPLE_YAML("DX-3", "In Progress"));
    await mirror.simulateWatcherEvent({ event: "change", path });

    expect(db.history).toHaveLength(2);
    expect(db.history[1].prevHash).toBe(firstHash);
    expect(db.history[1].contentHash).not.toBe(firstHash);
    expect(db.history[1].contentHash).toBe(
      sha256(canonicalize(PARSED_SAMPLE("DX-3", "In Progress"))),
    );
  });

  it("unlink event: deletes row + appends history with empty next_hash", async () => {
    const path = writeYaml(repo.localPath, "open", "DX-4", SAMPLE_YAML("DX-4"));
    await mirror.simulateWatcherEvent({ event: "add", path });
    expect(db.rows.has(rowKey("test-repo", "DX-4"))).toBe(true);

    rmSync(path);
    await mirror.simulateWatcherEvent({ event: "unlink", path });

    expect(db.rows.has(rowKey("test-repo", "DX-4"))).toBe(false);
    expect(db.tombstones).toHaveLength(1);
    expect(db.tombstones[0]).toMatchObject({
      id: "DX-4",
      existingHash: db.history[0].contentHash,
      source: "watcher",
    });
  });

  it("parse-error YAML: stores _malformed:true + raw text + id from filename, no crash", async () => {
    const malformed = "id: DX-5\n  not: { valid yaml :::";
    const path = writeYaml(repo.localPath, "open", "DX-5", malformed);
    await mirror.simulateWatcherEvent({ event: "add", path });
    const stored = db.rows.get(rowKey("test-repo", "DX-5"));
    expect(stored?.data).toMatchObject({
      id: "DX-5",
      _malformed: true,
      raw: malformed,
    });
  });

  it("DB write failure: writes CRITICAL_FAILURE flag + mirror keeps running", async () => {
    db.fail = new Error("connection refused");
    const path = writeYaml(repo.localPath, "open", "DX-6", SAMPLE_YAML("DX-6"));
    await mirror.simulateWatcherEvent({ event: "add", path });
    const flag = readFlag(repo.localPath);
    expect(flag).not.toBeNull();
    expect(flag?.source).toBe("issues-db-mirror");
    expect(flag?.reason).toMatch(/select existing|upsert/i);

    // Mirror keeps running — recover after fault clears.
    db.fail = undefined;
    const path2 = writeYaml(
      repo.localPath,
      "open",
      "DX-7",
      SAMPLE_YAML("DX-7"),
    );
    await mirror.simulateWatcherEvent({ event: "add", path: path2 });
    expect(db.rows.has(rowKey("test-repo", "DX-7"))).toBe(true);
  });

});

describe("issues-mirror — boot scan", () => {
  it("upserts every YAML on disk + tombstones missing rows", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    // Pre-populate DB with a row whose YAML disappears.
    db.rows.set(rowKey("test-repo", "DX-50"), {
      data: { id: "DX-50", status: "Done" },
      content_hash: "stale",
    });
    writeYaml(repo.localPath, "open", "DX-10", SAMPLE_YAML("DX-10"));
    writeYaml(repo.localPath, "open", "DX-11", SAMPLE_YAML("DX-11"));
    writeYaml(repo.localPath, "closed", "DX-12", SAMPLE_YAML("DX-12", "Done"));

    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
    try {
      const sources = db.history.map((h) => h.source);
      expect(sources.filter((s) => s === "boot-scan")).toHaveLength(3);
      expect(db.rows.has(rowKey("test-repo", "DX-10"))).toBe(true);
      expect(db.rows.has(rowKey("test-repo", "DX-11"))).toBe(true);
      expect(db.rows.has(rowKey("test-repo", "DX-12"))).toBe(true);
      // Tombstoned the orphaned row.
      expect(db.rows.has(rowKey("test-repo", "DX-50"))).toBe(false);
      expect(db.tombstones).toHaveLength(1);
      expect(db.tombstones[0].id).toBe("DX-50");
      expect(db.tombstones[0].source).toBe("boot-scan");
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });
});

describe("issues-mirror — reconcileNow (periodic timer logic)", () => {
  it("re-scans open/ only and tags drift with source=reconcile", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
    try {
      // Bypass the watcher to simulate a missed event: write the YAML
      // AFTER startup so boot scan didn't see it. Reconcile should pick
      // it up.
      writeYaml(repo.localPath, "open", "DX-20", SAMPLE_YAML("DX-20"));
      writeYaml(
        repo.localPath,
        "closed",
        "DX-21",
        SAMPLE_YAML("DX-21", "Done"),
      );
      const before = db.history.length;
      await mirror.reconcileNow();
      const reconcileRows = db.history
        .slice(before)
        .filter((h) => h.source === "reconcile");
      expect(reconcileRows.map((r) => r.id)).toEqual(["DX-20"]);
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });
});

describe("createPgIssuesMirrorDb — pure factory smoke", () => {
  it("produces an object with the IssuesMirrorDb method shape", () => {
    // Shape check only — actual SQL exercised in the integration suite.
    const fakePool = {} as unknown as Parameters<
      typeof createPgIssuesMirrorDb
    >[0];
    const db = createPgIssuesMirrorDb(fakePool);
    expect(typeof db.selectExisting).toBe("function");
    expect(typeof db.upsertWithHistory).toBe("function");
    expect(typeof db.tombstone).toBe("function");
    expect(typeof db.listIds).toBe("function");
  });
});

describe("issues-mirror — public-API contract", () => {
  let repo: ReturnType<typeof makeRepo>;
  let db: FakeDb;
  let mirror: IssuesMirror;

  beforeEach(async () => {
    repo = makeRepo();
    db = createFakeDb();
    mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await mirror.stop();
    rmSync(repo.tmpdir, { recursive: true, force: true });
  });

  it("hasAnyMirror reflects registry state", async () => {
    const { hasAnyMirror } = await import("./issues-mirror.js");
    expect(hasAnyMirror()).toBe(true);
    await mirror.stop();
    // After stop the mirror is deregistered; if no other test mirror is
    // active, hasAnyMirror is false. With other mirrors potentially
    // registered by parallel tests, just assert the contract: at least
    // the registry no longer holds OUR repoLocalPath.
    const { getMirrorByLocalPath } = await import("./issues-mirror.js");
    expect(getMirrorByLocalPath(repo.localPath)).toBeUndefined();

    // Re-create so afterEach's `mirror.stop()` is a no-op via the
    // `stopped` guard. The original mirror is already stopped above.
    mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
  });
});

describe("issues-mirror — onWatcherUpsert (DX-216)", () => {
  it("invokes onWatcherUpsert exactly once per watcher add event AFTER the upsert", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const calls: Array<{ id: string; rowsAtCallTime: number }> = [];
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
      onWatcherUpsert: async (id) => {
        // Capture the DB state at callback time so we can assert the
        // upsert ran first (the precondition the wiring guarantees).
        calls.push({ id, rowsAtCallTime: db.rows.size });
      },
    });
    try {
      const path = writeYaml(
        repo.localPath,
        "open",
        "DX-300",
        SAMPLE_YAML("DX-300"),
      );
      await mirror.simulateWatcherEvent({ event: "add", path });
      expect(calls).toEqual([{ id: "DX-300", rowsAtCallTime: 1 }]);
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  it("invokes onWatcherUpsert even when content is unchanged (no upsert this tick)", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const calls: string[] = [];
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
      onWatcherUpsert: async (id) => {
        calls.push(id);
      },
    });
    try {
      const path = writeYaml(
        repo.localPath,
        "open",
        "DX-301",
        SAMPLE_YAML("DX-301"),
      );
      // First event: upsert + reconcile.
      await mirror.simulateWatcherEvent({ event: "add", path });
      // Second event with same content: no upsert (mirror short-circuits)
      // but reconcile MUST still fire — the fs event reached the
      // chokepoint and downstream fanout is independent of whether THIS
      // tick wrote a row.
      await mirror.simulateWatcherEvent({ event: "change", path });
      expect(calls).toEqual(["DX-301", "DX-301"]);
      // History only grew once (no duplicate upsert).
      expect(db.history).toHaveLength(1);
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  it("does NOT invoke onWatcherUpsert for boot-scan or reconcile sources", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const calls: string[] = [];
    // Pre-populate disk; boot scan must NOT fire reconcile.
    writeYaml(repo.localPath, "open", "DX-302", SAMPLE_YAML("DX-302"));
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
      onWatcherUpsert: async (id) => {
        calls.push(id);
      },
    });
    try {
      // Boot scan ran during startIssuesMirror and shouldn't have invoked.
      expect(calls).toEqual([]);
      await mirror.reconcileNow();
      // reconcileNow source is "reconcile" — also no invocation.
      expect(calls).toEqual([]);
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  it("does NOT invoke onWatcherUpsert for unlink events (Phase 1 scope)", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const calls: string[] = [];
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
      onWatcherUpsert: async (id) => {
        calls.push(id);
      },
    });
    try {
      const path = writeYaml(
        repo.localPath,
        "open",
        "DX-303",
        SAMPLE_YAML("DX-303"),
      );
      await mirror.simulateWatcherEvent({ event: "add", path });
      expect(calls).toEqual(["DX-303"]);
      rmSync(path);
      await mirror.simulateWatcherEvent({ event: "unlink", path });
      // Phase 1 wires only the upsert path. Unlink wiring is a Phase 2+
      // concern (parent recursion on tombstone).
      expect(calls).toEqual(["DX-303"]);
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  it("end-to-end: a malformed YAML routed through reconcile records system-error with source=reconcile", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    // Real reconcile-style callback: throw a ReconcileValidationError
    // shape so the error message reaches the system-errors buffer with
    // the prefix the dashboard surfaces. This is the production wiring
    // path collapsed to a unit-level seam.
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
      onWatcherUpsert: async (id) => {
        throw new Error(`Issue validation failed for ${id}`);
      },
    });
    try {
      const path = writeYaml(
        repo.localPath,
        "open",
        "DX-310",
        SAMPLE_YAML("DX-310"),
      );
      const { _clearSystemErrors } = await import(
        "../dashboard/system-errors.js"
      );
      _clearSystemErrors();
      await mirror.simulateWatcherEvent({ event: "add", path });

      const { listSystemErrors } = await import(
        "../dashboard/system-errors.js"
      );
      const errs = listSystemErrors({ repo: "test-repo" });
      const reconcileErrs = errs.filter((e) => e.source === "reconcile");
      expect(reconcileErrs).toHaveLength(1);
      expect(reconcileErrs[0]!.message).toContain("DX-310");
      expect(reconcileErrs[0]!.message).toContain("Issue validation failed");
      _clearSystemErrors();
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  it("a thrown reconcile error does NOT take down the watcher (recordSystemError + continue)", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
      onWatcherUpsert: async () => {
        throw new Error("boom");
      },
    });
    try {
      const path = writeYaml(
        repo.localPath,
        "open",
        "DX-304",
        SAMPLE_YAML("DX-304"),
      );
      // The throw must be caught — the simulate call resolves cleanly.
      await expect(
        mirror.simulateWatcherEvent({ event: "add", path }),
      ).resolves.toBeUndefined();
      // The upsert still landed (reconcile failure is post-upsert).
      expect(db.rows.has(rowKey("test-repo", "DX-304"))).toBe(true);

      // The system-errors module captured the failure under
      // source: "reconcile". Asserting on the buffer keeps this test
      // hermetic w.r.t. log output.
      const { listSystemErrors, _clearSystemErrors } = await import(
        "../dashboard/system-errors.js"
      );
      const errs = listSystemErrors({ repo: "test-repo" });
      expect(errs.some((e) => e.source === "reconcile")).toBe(true);
      _clearSystemErrors();

      // A second event for a different card still processes.
      const path2 = writeYaml(
        repo.localPath,
        "open",
        "DX-305",
        SAMPLE_YAML("DX-305"),
      );
      await mirror.simulateWatcherEvent({ event: "add", path: path2 });
      expect(db.rows.has(rowKey("test-repo", "DX-305"))).toBe(true);
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });
});

describe("issues-mirror — non-object YAML fall-through", () => {
  it("stores a top-level array as malformed (not an object)", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
    try {
      const arrayYaml = "- item1\n- item2\n";
      const path = writeYaml(repo.localPath, "open", "DX-40", arrayYaml);
      await mirror.simulateWatcherEvent({ event: "add", path });
      const stored = db.rows.get(rowKey("test-repo", "DX-40"));
      expect(stored?.data).toMatchObject({
        id: "DX-40",
        _malformed: true,
        raw: arrayYaml,
      });
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });
});

// ----- DX-547 — upsertIssueRowNow (writer-side direct upsert) -----
describe("upsertIssueRowNow (DX-547 — writer path)", () => {
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    unregisterWriterDb(repo.localPath);
    rmSync(repo.tmpdir, { recursive: true, force: true });
  });

  it("no-ops when no writer DB is registered (legacy file-only path)", async () => {
    // Pure unit-test scenario: nothing registered → upsert is a no-op
    // that resolves cleanly. Defends the legacy yaml-lifecycle test
    // suite which relies on `writeIssue` running without a DB.
    await expect(
      upsertIssueRowNow({
        repoName: "no-db-repo",
        repoLocalPath: repo.localPath,
        id: "DX-99",
        data: { id: "DX-99" },
        contentHash: "abc",
        source: "writer",
      }),
    ).resolves.toBeUndefined();
  });

  it("selectExisting failure: writes CRITICAL_FAILURE + rethrows", async () => {
    const db = createFakeDb();
    const boom = new Error("pg connection lost");
    db.fail = boom;
    registerWriterDb(repo.localPath, db);

    await expect(
      upsertIssueRowNow({
        repoName: repo.name,
        repoLocalPath: repo.localPath,
        id: "DX-1",
        data: { id: "DX-1" },
        contentHash: "h1",
        source: "writer",
      }),
    ).rejects.toBe(boom);

    // CRITICAL_FAILURE flag MUST be present so the next poller tick
    // halts — the operator-facing safety net per `agent-dispatch.md`.
    const flag = readFlag(repo.localPath);
    expect(flag).not.toBeNull();
    expect(flag!.reason).toContain("writer DB write failed");
    expect(flag!.reason).toContain("select existing for DX-1");
  });

  it("upsertWithHistory failure: writes CRITICAL_FAILURE + rethrows", async () => {
    const db = createFakeDb();
    // Override upsertWithHistory in isolation so selectExisting still
    // succeeds — targets the second try/catch branch in
    // `upsertIssueRowNow`.
    const boom = new Error("pg insert deadlock");
    db.upsertWithHistory = async () => {
      throw boom;
    };
    registerWriterDb(repo.localPath, db);

    await expect(
      upsertIssueRowNow({
        repoName: repo.name,
        repoLocalPath: repo.localPath,
        id: "DX-2",
        data: { id: "DX-2" },
        contentHash: "h2",
        source: "writer",
      }),
    ).rejects.toBe(boom);

    const flag = readFlag(repo.localPath);
    expect(flag).not.toBeNull();
    expect(flag!.reason).toContain("writer DB write failed");
    expect(flag!.reason).toContain("upsert DX-2");
  });

  it("registerWriterDb / unregisterWriterDb / getWriterDb round-trip (path normalization)", () => {
    const db = createFakeDb();
    // Register via the raw path; lookup via a path with redundant `./`
    // segments — resolve() inside the registry MUST normalize both
    // sides so the lookup hits.
    registerWriterDb(repo.localPath, db);
    expect(getWriterDb(repo.localPath)).toBe(db);
    expect(getWriterDb(`${repo.localPath}/.`)).toBe(db);

    unregisterWriterDb(repo.localPath);
    expect(getWriterDb(repo.localPath)).toBeUndefined();
  });

  it("mirror.stop() unregisters the writer DB", async () => {
    const db = createFakeDb();
    const m = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
    // startIssuesMirror registered the writer DB.
    expect(getWriterDb(repo.localPath)).toBe(db);
    await m.stop();
    // stop() drops the registration so a subsequent unrelated test
    // doesn't pick up a stale registration.
    expect(getWriterDb(repo.localPath)).toBeUndefined();
  });
});

describe("DX-548 — watcher debug log distinguishes skip-match vs upsert", () => {
  let repo: ReturnType<typeof makeRepo>;
  let db: FakeDb;
  let mirror: IssuesMirror;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let prevLogLevel: string | undefined;

  beforeEach(async () => {
    prevLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    repo = makeRepo();
    db = createFakeDb();
    mirror = await startIssuesMirror(repo, {
      db,
      disableWatcher: true,
      reconcileIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await mirror.stop();
    rmSync(repo.tmpdir, { recursive: true, force: true });
    logSpy.mockRestore();
    if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLogLevel;
  });

  function debugLogsContaining(needle: string): string[] {
    return logSpy.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .filter((line: string) => {
        try {
          const parsed = JSON.parse(line) as { level?: string; message?: string };
          return parsed.level === "debug" && (parsed.message ?? "").includes(needle);
        } catch {
          return false;
        }
      });
  }

  it("writer pre-populates the DB row → watcher hits skip-match branch + logs action=skip-match (no second history row)", async () => {
    // Phase 3 invariant: post phase 2, the writer's synchronous upsert
    // lands BEFORE the file write, so by the time chokidar fires the row
    // and content hash already match. mirrorOne MUST short-circuit on
    // the existing-hash branch — no second history row, no second
    // upsert call.
    const yaml = SAMPLE_YAML("DX-5480");
    const path = writeYaml(repo.localPath, "open", "DX-5480", yaml);
    const hash = sha256(canonicalize(PARSED_SAMPLE("DX-5480")));
    // Simulate phase 2 — the writer pre-populated the row.
    db.rows.set(rowKey("test-repo", "DX-5480"), {
      data: PARSED_SAMPLE("DX-5480"),
      content_hash: hash,
    });

    await mirror.simulateWatcherEvent({ event: "add", path });

    // mirrorOne short-circuited: zero history rows, zero upsert calls.
    expect(db.history).toHaveLength(0);
    // Debug log fires the action=skip-match branch (and not the upsert one).
    const skipLines = debugLogsContaining("action=skip-match");
    expect(skipLines.length).toBeGreaterThan(0);
    expect(skipLines.some((l) => l.includes("DX-5480"))).toBe(true);
    expect(skipLines.some((l) => l.includes("source=watcher"))).toBe(true);
    expect(debugLogsContaining("action=upsert")).toHaveLength(0);
  });

  it("external write (DB empty) → watcher upserts + logs action=upsert with source=watcher", async () => {
    // Mirror image of the skip-match test: when the writer did NOT run
    // first (operator hand-edit, git pull, external tool), mirrorOne
    // MUST upsert. Asserts the new debug-log distinction so the
    // operator can grep worker logs for external-write activity.
    const path = writeYaml(repo.localPath, "open", "DX-5481", SAMPLE_YAML("DX-5481"));

    await mirror.simulateWatcherEvent({ event: "add", path });

    expect(db.history).toHaveLength(1);
    expect(db.history[0].source).toBe("watcher");
    const upsertLines = debugLogsContaining("action=upsert");
    expect(upsertLines.length).toBeGreaterThan(0);
    expect(upsertLines.some((l) => l.includes("DX-5481"))).toBe(true);
    expect(upsertLines.some((l) => l.includes("source=watcher"))).toBe(true);
    expect(debugLogsContaining("action=skip-match")).toHaveLength(0);
  });

  it("integration: writeIssue + chokidar-event share one DB → ONE history row (writer), no second watcher row", async () => {
    // AC #3 (DX-548): the writer's sync upsert lands first (source=writer),
    // so when chokidar fires later for the same file, the watcher MUST
    // hit the skip-match branch — NOT add a second history row. This
    // test wires the writer DB and the mirror DB to the same FakeDb
    // instance (startIssuesMirror already registers the writer DB to
    // the same db handle), calls writeIssue, then simulates the
    // watcher event the real chokidar would fire ~1s later.
    const { writeIssue: writeIssueFn } = await import(
      "../poller/yaml-lifecycle.js"
    );
    const id = "DX-5483";
    const issue = {
      schema_version: 9 as const,
      tracker: "memory" as const,
      id,
      external_id: "",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "ToDo" as const,
      type: "Feature" as const,
      title: `Title for ${id}`,
      description: "Body",
      priority: 3.0,
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
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      assigned_agent: null,
      waiting_on: null,
      blocked: null,
      requires_human: null,
      conflict_on: [],
      effort_level: "medium" as const,
      db_updated_at: "",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writeIssueFn(repo.localPath, issue as any);

    // After writeIssue, FakeDb's history records ONE writer row.
    const writerCount = db.history.filter((h) => h.source === "writer").length;
    expect(writerCount).toBe(1);
    const writerRow = db.history.find((h) => h.source === "writer")!;
    const writerHash = writerRow.contentHash;

    // Simulate chokidar firing for the same file ~1s later (real watcher
    // would do this; we drive deterministically via simulateWatcherEvent).
    const yamlPath = resolve(
      repo.localPath,
      ".danxbot",
      "issues",
      "open",
      `${id}.yml`,
    );
    await mirror.simulateWatcherEvent({ event: "add", path: yamlPath });

    // No second history row — the watcher saw existing.content_hash ===
    // contentHash and short-circuited. The skip-match debug log fired.
    expect(db.history.filter((h) => h.source === "watcher")).toHaveLength(0);
    expect(db.history).toHaveLength(1);
    expect(db.history[0].contentHash).toBe(writerHash);
    expect(
      debugLogsContaining("action=skip-match").some((l) => l.includes(id)),
    ).toBe(true);
  });

  it("integration: external writeFileSync (writer NOT involved) → chokidar fires → watcher history row appears", async () => {
    // AC #4 (DX-548): when an external actor (operator hand-edit, git
    // pull, agent Edit tool) writes the YAML directly without going
    // through writeIssue, the writer's upsertIssueRowNow never runs.
    // The DB row is missing — mirrorOne MUST upsert + record a
    // source=watcher history row.
    const path = writeYaml(
      repo.localPath,
      "open",
      "DX-5484",
      SAMPLE_YAML("DX-5484"),
    );

    await mirror.simulateWatcherEvent({ event: "add", path });

    expect(db.history).toHaveLength(1);
    expect(db.history[0].source).toBe("watcher");
    expect(
      debugLogsContaining("action=upsert").some((l) => l.includes("DX-5484")),
    ).toBe(true);
  });

  it("reconcile sweep hits hash-skip on a healthy card (no churn, no new history)", async () => {
    // AC: per-tick reconcile sweep against a row whose DB hash already
    // matches the on-disk YAML must NOT add a new history row. The same
    // hash-match branch carries the source=reconcile path.
    const yaml = SAMPLE_YAML("DX-5482");
    writeYaml(repo.localPath, "open", "DX-5482", yaml);
    const hash = sha256(canonicalize(PARSED_SAMPLE("DX-5482")));
    db.rows.set(rowKey("test-repo", "DX-5482"), {
      data: PARSED_SAMPLE("DX-5482"),
      content_hash: hash,
    });

    await mirror.reconcileNow();

    expect(db.history).toHaveLength(0);
    const skipLines = debugLogsContaining("action=skip-match");
    expect(skipLines.some((l) => l.includes("source=reconcile"))).toBe(true);
  });
});
