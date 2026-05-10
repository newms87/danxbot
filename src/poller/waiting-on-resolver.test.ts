import {
  afterAll,
  afterEach,
  beforeAll,
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { createTestDb, type TestDbHandle } from "../db/test-db.js";
import { up as upIssuesMirror } from "../db/migrations/016_issues_mirror.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type {
  Issue,
  IssueRef,
  IssueStatus,
} from "../issue-tracker/interface.js";
import { resolveWaitingOnCards } from "./waiting-on-resolver.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "./issues-db.js";
import { clearAllRepoNames, setRepoName } from "./repo-name.js";

/**
 * Phase 4 of the Issues DB Mirror epic (DX-151 / DX-155). The resolver
 * delegates to `findByExternalId` + `loadLocal`, which are now SQL
 * queries against the `issues` table — these tests seed the DB
 * directly. The waiting card's YAML still gets written to disk so
 * `writeIssue`'s file output can be inspected for history-append
 * assertions; deps live in the DB only (the resolver never touches
 * their files).
 */
const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[waiting-on-resolver] skipping — local Postgres not reachable",
  );
} else {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    await upIssuesMirror(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const REPO_NAME = "waiting-on-resolver-test-repo";

afterAll(async () => {
  resetIssueDbQueryFn();
  clearAllRepoNames();
  if (handle) await handle.close();
});

if (handle) {
  beforeAll(() => {
    setIssueDbQueryFn(async (sql, params) => {
      const result = await handle.pool.query(sql, params ?? []);
      return result.rows as never;
    });
  });
}

function buildIssue(overrides: Partial<Issue> & { id: string }): Issue {
  const { id, ...rest } = overrides;
  const merged: Issue = {
    schema_version: 6,
    tracker: "memory",
    id,
    external_id: `ext-${id}`,
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: `Title for ${id}`,
    description: "",
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
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    history: [],
    ...rest,
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function writeIssueAt(
  repoRoot: string,
  issue: Issue,
  state: "open" | "closed" = "open",
): void {
  const dir = resolve(repoRoot, ".danxbot", "issues", state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${issue.id}.yml`), serializeIssue(issue));
}

async function seed(issue: Issue): Promise<void> {
  if (!handle) return;
  const data = issue as unknown as Record<string, unknown>;
  const contentHash = sha256(canonicalize(data));
  await handle.pool.query(
    `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at)
     VALUES ($1, $2::jsonb, $3, now())`,
    [REPO_NAME, JSON.stringify(data), contentHash],
  );
}

function loadIssue(
  repoRoot: string,
  id: string,
  state: "open" | "closed" = "open",
): Issue {
  const path = resolve(repoRoot, ".danxbot", "issues", state, `${id}.yml`);
  return parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "ISS" });
}

function ref(externalId: string, title: string, status: IssueStatus): IssueRef {
  return { id: "", external_id: externalId, title, status };
}

describe("resolveWaitingOnCards", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-waiting-on-resolver-"));
    if (handle) {
      await handle.pool.query("DELETE FROM issues");
      setRepoName(repoRoot, REPO_NAME);
    }
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const ctx = (root: string) => ({
    name: "test-repo",
    localPath: root,
    issuePrefix: "ISS",
  });

  it.skipIf(!handle)(
    "passes through cards with no local YAML (defensive — bulk-sync covers these)",
    async () => {
      const cards = [ref("ext-orphan", "No local YAML yet", "ToDo")];
      expect(await resolveWaitingOnCards(ctx(repoRoot), cards)).toEqual(cards);
    },
  );

  it.skipIf(!handle)(
    "passes through cards whose local YAML has waiting_on: null",
    async () => {
      const issue = buildIssue({ id: "ISS-1", waiting_on: null });
      writeIssueAt(repoRoot, issue);
      await seed(issue);

      const cards = [ref(issue.external_id, issue.title, "ToDo")];
      expect(await resolveWaitingOnCards(ctx(repoRoot), cards)).toEqual(cards);

      // Untouched — no history added.
      expect(loadIssue(repoRoot, "ISS-1").history).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "drops cards whose deps are still non-terminal — no clear, no history entry",
    async () => {
      const dep = buildIssue({ id: "ISS-99", status: "In Progress" });
      const waiting = buildIssue({
        id: "ISS-1",
        waiting_on: {
          reason: "Waits on ISS-99",
          timestamp: "2026-05-08T00:00:00.000Z",
          by: ["ISS-99"],
        },
      });
      writeIssueAt(repoRoot, dep);
      writeIssueAt(repoRoot, waiting);
      await seed(dep);
      await seed(waiting);

      const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
      const out = await resolveWaitingOnCards(ctx(repoRoot), cards);
      expect(out).toEqual([]);

      const reloaded = loadIssue(repoRoot, "ISS-1");
      expect(reloaded.waiting_on).not.toBeNull();
      expect(reloaded.history).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "DX-147: clearing waiting_on when every dep is terminal appends ONE worker:auto-derive unblocked entry with the dep ids in the note",
    async () => {
      const d1 = buildIssue({ id: "ISS-90", status: "Done" });
      const d2 = buildIssue({ id: "ISS-91", status: "Cancelled" });
      writeIssueAt(repoRoot, d1, "closed");
      writeIssueAt(repoRoot, d2, "closed");
      await seed(d1);
      await seed(d2);

      const waiting = buildIssue({
        id: "ISS-1",
        waiting_on: {
          reason: "Waits on ISS-90 + ISS-91",
          timestamp: "2026-05-08T00:00:00.000Z",
          by: ["ISS-90", "ISS-91"],
        },
      });
      writeIssueAt(repoRoot, waiting);
      await seed(waiting);

      const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
      const out = await resolveWaitingOnCards(ctx(repoRoot), cards);
      expect(out).toEqual(cards);

      const reloaded = loadIssue(repoRoot, "ISS-1");
      expect(reloaded.waiting_on).toBeNull();
      expect(reloaded.history).toHaveLength(1);
      const entry = reloaded.history[0];
      expect(entry.actor).toBe("worker:auto-derive");
      expect(entry.event).toBe("unblocked");
      expect(entry.note).toContain("ISS-90");
      expect(entry.note).toContain("ISS-91");
      expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    },
  );

  it.skipIf(!handle)(
    "DX-147: a missing dep (no row in DB) keeps the card waiting — no clear, no history entry",
    async () => {
      const waiting = buildIssue({
        id: "ISS-1",
        waiting_on: {
          reason: "Waits on ISS-99 (does not exist locally)",
          timestamp: "2026-05-08T00:00:00.000Z",
          by: ["ISS-99"],
        },
      });
      writeIssueAt(repoRoot, waiting);
      await seed(waiting);

      const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
      const out = await resolveWaitingOnCards(ctx(repoRoot), cards);
      expect(out).toEqual([]);

      const reloaded = loadIssue(repoRoot, "ISS-1");
      expect(reloaded.waiting_on).not.toBeNull();
      expect(reloaded.history).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "DX-147: ANY non-terminal dep keeps the card waiting even if other deps are terminal (mixed set)",
    async () => {
      const done = buildIssue({ id: "ISS-90", status: "Done" });
      const cancelled = buildIssue({ id: "ISS-91", status: "Cancelled" });
      const live = buildIssue({ id: "ISS-92", status: "In Progress" });
      writeIssueAt(repoRoot, done, "closed");
      writeIssueAt(repoRoot, cancelled, "closed");
      writeIssueAt(repoRoot, live);
      await seed(done);
      await seed(cancelled);
      await seed(live);

      const waiting = buildIssue({
        id: "ISS-1",
        waiting_on: {
          reason: "Waits on three deps",
          timestamp: "2026-05-08T00:00:00.000Z",
          by: ["ISS-90", "ISS-91", "ISS-92"],
        },
      });
      writeIssueAt(repoRoot, waiting);
      await seed(waiting);

      const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
      const out = await resolveWaitingOnCards(ctx(repoRoot), cards);
      expect(out).toEqual([]);

      const reloaded = loadIssue(repoRoot, "ISS-1");
      expect(reloaded.waiting_on).not.toBeNull();
      expect(reloaded.history).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "appends history without losing prior entries (cap + truncation are appendHistory's responsibility)",
    async () => {
      const d = buildIssue({ id: "ISS-90", status: "Done" });
      writeIssueAt(repoRoot, d, "closed");
      await seed(d);

      const prior = {
        timestamp: "2026-05-01T00:00:00.000Z",
        actor: "dispatch:abc",
        event: "blocked" as const,
        to: "ToDo" as IssueStatus,
        note: "Waiting on ISS-90",
      };
      const waiting = buildIssue({
        id: "ISS-1",
        waiting_on: {
          reason: "Waits on ISS-90",
          timestamp: "2026-05-08T00:00:00.000Z",
          by: ["ISS-90"],
        },
        history: [prior],
      });
      writeIssueAt(repoRoot, waiting);
      await seed(waiting);

      await resolveWaitingOnCards(ctx(repoRoot), [
        ref(waiting.external_id, waiting.title, "ToDo"),
      ]);

      const reloaded = loadIssue(repoRoot, "ISS-1");
      expect(reloaded.history).toHaveLength(2);
      expect(reloaded.history[0]).toMatchObject(prior);
      expect(reloaded.history[1].actor).toBe("worker:auto-derive");
      expect(reloaded.history[1].event).toBe("unblocked");
    },
  );
});
