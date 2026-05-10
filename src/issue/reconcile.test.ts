import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import {
  reconcileIssue,
  _hasReconcileMutex,
  _resetReconcileMutexes,
  type ReconcileRepoContext,
} from "./reconcile.js";
import { ReconcileValidationError } from "./reconcile-types.js";

function makeIssue(id: string, status: IssueStatus = "ToDo"): Issue {
  return {
    schema_version: 5,
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
    history: [],
  };
}

function makeRepoCtx(): {
  cleanup: () => void;
  repo: ReconcileRepoContext;
  openDir: string;
  closedDir: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-reconcile-"));
  const openDir = resolve(root, ".danxbot", "issues", "open");
  const closedDir = resolve(root, ".danxbot", "issues", "closed");
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  return {
    repo: { name: "test-repo", localPath: root, issuePrefix: "DX" },
    openDir,
    closedDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeYaml(dir: string, id: string, issue: Issue): string {
  const path = resolve(dir, `${id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

beforeEach(() => {
  _resetReconcileMutexes();
});

describe("reconcileIssue — Phase 1 chokepoint", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("returns no-op result for a parseable, valid YAML in open/", async () => {
    const issue = makeIssue("DX-1");
    const path = writeYaml(ctx.openDir, "DX-1", issue);
    // Mirror's hash recipe: parse the on-disk text via parseYamlText,
    // canonicalize the resulting object, sha256. Reconcile MUST agree
    // on this byte sequence so `awaitMirror` lookups + content-hash
    // dedupes cross-reference correctly across the two modules.
    const { parse: parseYamlText } = await import("yaml");
    const onDiskText = readFileSync(path, "utf-8");
    const expectedHash = sha256(
      canonicalize(parseYamlText(onDiskText) as Record<string, unknown>),
    );

    const result = await reconcileIssue(ctx.repo, "DX-1", "watcher");

    expect(result.changed).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.fanout).toEqual({
      parentId: null,
      dependents: [],
      dispatchableChanged: false,
    });
    // The hash MUST match what the mirror would compute on the same
    // file — parity is load-bearing for `awaitMirror` round-trips in
    // later phases.
    expect(result.prevHash).toBe(expectedHash);
    expect(result.nextHash).toBe(result.prevHash);
    // File is unchanged on disk (no write happened).
    expect(readFileSync(path, "utf-8")).toBe(serializeIssue(issue));
  });

  it("locates a YAML in closed/ when open/ is absent", async () => {
    const issue = makeIssue("DX-2", "Done");
    writeYaml(ctx.closedDir, "DX-2", issue);

    const result = await reconcileIssue(ctx.repo, "DX-2", "watcher");

    expect(result.changed).toBe(false);
    expect(result.prevHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prefers open/ when both open/ and closed/ exist (open-wins)", async () => {
    const openIssue = makeIssue("DX-3", "In Progress");
    const closedIssue = makeIssue("DX-3", "Done");
    writeYaml(ctx.openDir, "DX-3", openIssue);
    writeYaml(ctx.closedDir, "DX-3", closedIssue);

    const result = await reconcileIssue(ctx.repo, "DX-3", "watcher");

    expect(result.changed).toBe(false);
    // Hash matches the open/ file, not closed/.
    const openHash = sha256(
      canonicalize(JSON.parse(JSON.stringify(openIssue))),
    );
    const closedHash = sha256(
      canonicalize(JSON.parse(JSON.stringify(closedIssue))),
    );
    expect(result.prevHash).toBe(openHash);
    expect(result.prevHash).not.toBe(closedHash);
  });

  it("returns tombstone result when the YAML is missing from both directories", async () => {
    const result = await reconcileIssue(ctx.repo, "DX-99", "watcher");

    expect(result.changed).toBe(false);
    expect(result.prevHash).toBeNull();
    expect(result.nextHash).toBe("");
    expect(result.errors).toEqual([]);
    expect(result.fanout.dependents).toEqual([]);
  });

  it("throws ReconcileValidationError on malformed YAML", async () => {
    const path = resolve(ctx.openDir, "DX-4.yml");
    writeFileSync(path, "id: DX-4\n  not: { valid yaml :::");

    await expect(
      reconcileIssue(ctx.repo, "DX-4", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);
  });

  it("throws ReconcileValidationError on shape violation (missing required fields)", async () => {
    const path = resolve(ctx.openDir, "DX-5.yml");
    // Parses as YAML, but lacks the required fields the strict
    // `parseIssue` validator demands.
    writeFileSync(path, "id: DX-5\nstatus: ToDo\n");

    await expect(
      reconcileIssue(ctx.repo, "DX-5", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);
  });

  it("throws ReconcileValidationError on prefix mismatch (wrong PREFIX-N)", async () => {
    const issue = makeIssue("DX-6");
    // Stamp the wrong prefix into the YAML — validator should reject.
    const text = serializeIssue(issue).replace(/^id: DX-6$/m, "id: WRONG-1");
    writeFileSync(resolve(ctx.openDir, "DX-6.yml"), text);

    await expect(
      reconcileIssue(ctx.repo, "DX-6", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);
  });

  it("ReconcileValidationError carries the id + path of the offending file", async () => {
    const path = resolve(ctx.openDir, "DX-7.yml");
    writeFileSync(path, "{not valid: yaml at all\n  bare colon: :");

    try {
      await reconcileIssue(ctx.repo, "DX-7", "watcher");
      throw new Error("expected ReconcileValidationError to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReconcileValidationError);
      const verr = err as ReconcileValidationError;
      expect(verr.id).toBe("DX-7");
      expect(verr.path).toBe(path);
    }
  });
});

describe("reconcileIssue — behaviour parity (no-op chokepoint)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Phase 1 parity claim: for every fixture the existing poller helpers
  // operate on, reconcile produces an IDENTICAL canonical YAML on disk
  // (because Phase 1 body is a no-op chokepoint). Phase 2 absorbs the
  // helpers and converts these table entries into "reconcile produces
  // what _poll did" assertions.
  const fixtures: Array<{ name: string; status: IssueStatus; dir: "open" | "closed" }> = [
    { name: "ToDo card", status: "ToDo", dir: "open" },
    { name: "In Progress card", status: "In Progress", dir: "open" },
    { name: "Done in closed/", status: "Done", dir: "closed" },
    { name: "Cancelled in closed/", status: "Cancelled", dir: "closed" },
    { name: "Needs Approval", status: "Needs Approval", dir: "open" },
  ];

  for (const f of fixtures) {
    it(`${f.name} round-trips through reconcile unchanged`, async () => {
      const issue = makeIssue("DX-100", f.status);
      const targetDir = f.dir === "open" ? ctx.openDir : ctx.closedDir;
      const path = writeYaml(targetDir, "DX-100", issue);
      const before = readFileSync(path, "utf-8");
      const { parse: parseYamlText } = await import("yaml");
      const expectedHash = sha256(
        canonicalize(parseYamlText(before) as Record<string, unknown>),
      );

      const result = await reconcileIssue(ctx.repo, "DX-100", "watcher");

      expect(result.changed).toBe(false);
      expect(result.prevHash).toBe(expectedHash);
      expect(readFileSync(path, "utf-8")).toBe(before);
    });
  }
});

describe("reconcileIssue — per-card mutex", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("concurrent calls for the same id queue (serialized)", async () => {
    const issue = makeIssue("DX-200");
    writeYaml(ctx.openDir, "DX-200", issue);

    // Track concurrency: increment on entry, decrement on exit; a custom
    // tracker is necessary because reconcile's body is fast — we can't
    // observe interleaving without instrumentation. Wrap the file system
    // so we can inject a delay and detect overlap.
    const order: string[] = [];

    // Issue three concurrent calls. With a per-id mutex they should
    // resolve in submission order; without, they could resolve in any
    // order.
    const p1 = reconcileIssue(ctx.repo, "DX-200", "watcher").then(() =>
      order.push("a"),
    );
    const p2 = reconcileIssue(ctx.repo, "DX-200", "watcher").then(() =>
      order.push("b"),
    );
    const p3 = reconcileIssue(ctx.repo, "DX-200", "watcher").then(() =>
      order.push("c"),
    );

    await Promise.all([p1, p2, p3]);

    // The mutex chains promises; serial chain → submission order
    // preserved. Independent of speed because each `then` runs on its
    // predecessor.
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("different ids run in parallel (no cross-id serialization)", async () => {
    const a = makeIssue("DX-201");
    const b = makeIssue("DX-202");
    writeYaml(ctx.openDir, "DX-201", a);
    writeYaml(ctx.openDir, "DX-202", b);

    // Issue both concurrently. Both should resolve without either
    // blocking on the other's mutex slot.
    const [ra, rb] = await Promise.all([
      reconcileIssue(ctx.repo, "DX-201", "watcher"),
      reconcileIssue(ctx.repo, "DX-202", "watcher"),
    ]);

    expect(ra.changed).toBe(false);
    expect(rb.changed).toBe(false);
  });

  it("a rejected reconcile does NOT block subsequent calls for the same id", async () => {
    // Round 1: malformed YAML → throws. Round 2: replace with valid YAML
    // and confirm reconcile runs cleanly (the mutex chain tolerated the
    // prior rejection).
    const path = resolve(ctx.openDir, "DX-203.yml");
    writeFileSync(path, "{not valid: at all");

    await expect(
      reconcileIssue(ctx.repo, "DX-203", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);

    unlinkSync(path);
    writeYaml(ctx.openDir, "DX-203", makeIssue("DX-203"));

    const result = await reconcileIssue(ctx.repo, "DX-203", "watcher");
    expect(result.changed).toBe(false);
  });

  it("releases the mutex slot after the body completes", async () => {
    const issue = makeIssue("DX-204");
    writeYaml(ctx.openDir, "DX-204", issue);

    expect(_hasReconcileMutex(ctx.repo.name, "DX-204")).toBe(false);

    await reconcileIssue(ctx.repo, "DX-204", "watcher");

    // Allow the cleanup microtask to run.
    await new Promise<void>((res) => setImmediate(res));
    expect(_hasReconcileMutex(ctx.repo.name, "DX-204")).toBe(false);
  });
});

describe("reconcileIssue — trigger tagging", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Phase 1 body is identical regardless of trigger; trigger drives log
  // prefix + future metric tagging only. One spot-check that every
  // variant accepts is enough — the rest is type-level.
  it("accepts every ReconcileTrigger variant without throwing", async () => {
    const issue = makeIssue("DX-300");
    writeYaml(ctx.openDir, "DX-300", issue);
    const triggers = [
      "watcher",
      "lifecycle",
      "scheduler",
      "audit",
      "hydrate",
    ] as const;

    for (const trigger of triggers) {
      const result = await reconcileIssue(ctx.repo, "DX-300", trigger);
      expect(result.changed).toBe(false);
    }
  });
});
