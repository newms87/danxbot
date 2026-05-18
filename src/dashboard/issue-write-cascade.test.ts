import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";

// Mocks declared BEFORE module-under-test imports so vitest hoists them
// (matches the issue-write.test.ts pattern).
vi.mock("./auth-middleware.js", () => ({
  requireUser: async (req: { headers: { authorization?: string } }) => {
    const h = req.headers?.authorization;
    const t = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!t || !t.startsWith("user-")) return { ok: false, status: 401 };
    return {
      ok: true,
      user: { userId: 1, username: t.slice("user-".length) },
    };
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockEventBusPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: { publish: (...args: unknown[]) => mockEventBusPublish(...args) },
}));

// Empty `dbListAllIssues` so the canonical publisher fan-out finds no
// cross-card references — each write emits exactly ONE SSE event for the
// changed card itself.
vi.mock("../poller/issues-db.js", () => ({
  dbListAllIssues: vi.fn(async () => []),
}));

import {
  applyIssueCascade,
  handlePatchIssueCascade,
  type CascadeDeps,
} from "./issue-write-cascade.js";
import { IssuePatchError } from "./issue-write.js";
import { serializeIssue, createEmptyIssue } from "../issue-tracker/yaml.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
import { listsFilePath, defaultLists } from "../lists-file.js";
import { stringify as stringifyYaml } from "yaml";
import type { Issue } from "../issue-tracker/interface.js";
import { createMockReqWithBody, createMockRes } from "../__tests__/helpers/http-mocks.js";
import { deps as buildDeps } from "./agents-test-fixtures.js";

let tmpRoot: string;
let repoLocalPath: string;

function writeConfig(prefix: string): void {
  const configDir = resolve(repoLocalPath, ".danxbot/config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "config.yml"), `issue_prefix: ${prefix}\n`);
}

/**
 * Seed lists.yaml with the canonical 7-list seed (Backlog / Review /
 * To Do / Blocked / In Progress / Done / Cancelled). Pinned uuids so
 * tests can refer to a list by name without UUID lookups.
 */
function writeListsFile(): void {
  const path = listsFilePath(repoLocalPath);
  mkdirSync(resolve(repoLocalPath, ".danxbot"), { recursive: true });
  let counter = 0;
  const seeded = defaultLists({ uuid: () => `test-${++counter}` });
  writeFileSync(path, stringifyYaml(seeded, { lineWidth: 0 }));
}

function writeFixture(issue: Issue, state: "open" | "closed"): string {
  ensureIssuesDirs(repoLocalPath);
  const path = issuePath(repoLocalPath, issue.id, state);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const base = createEmptyIssue({
    id: "DX-1",
    title: "Test card",
    description: "Body",
    status: "ToDo",
    type: "Feature",
  });
  return { ...base, ...overrides };
}

function readYaml(id: string, state: "open" | "closed"): Record<string, unknown> {
  return parseYamlText(
    readFileSync(issuePath(repoLocalPath, id, state), "utf-8"),
  ) as Record<string, unknown>;
}

function stubDeps(dispatchable: Issue[] = []): CascadeDeps {
  return {
    listDispatchable: vi.fn(async () => dispatchable),
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "issue-write-cascade-test-"));
  repoLocalPath = resolve(tmpRoot, "danxbot");
  mkdirSync(repoLocalPath, { recursive: true });
  writeConfig("DX");
  writeListsFile();
  mockEventBusPublish.mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("validateCascadeBody (via applyIssueCascade)", () => {
  it("rejects non-object body with 400", async () => {
    await expect(
      applyIssueCascade("danxbot", repoLocalPath, "nope", stubDeps()),
    ).rejects.toBeInstanceOf(IssuePatchError);
  });

  it("rejects unknown field with 400", async () => {
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        {
          epic_id: "DX-1",
          dest_list_name: "To Do",
          unblock_confirmed: false,
          extra: true,
        },
        stubDeps(),
      ),
    ).rejects.toMatchObject({ status: 400, body: { error: "Field not patchable: extra" } });
  });

  it("rejects malformed epic_id with 400", async () => {
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        { epic_id: "not-an-id", dest_list_name: "To Do", unblock_confirmed: false },
        stubDeps(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects empty dest_list_name with 400", async () => {
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        { epic_id: "DX-1", dest_list_name: "", unblock_confirmed: false },
        stubDeps(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects non-boolean unblock_confirmed with 400", async () => {
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        { epic_id: "DX-1", dest_list_name: "To Do", unblock_confirmed: "yes" },
        stubDeps(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects malformed override id with 400", async () => {
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        {
          epic_id: "DX-1",
          dest_list_name: "To Do",
          unblock_confirmed: false,
          overrides: { "bad-id": { kind: "stay" } },
        },
        stubDeps(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unknown override kind with 400", async () => {
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        {
          epic_id: "DX-1",
          dest_list_name: "To Do",
          unblock_confirmed: false,
          overrides: { "DX-2": { kind: "bogus" } },
        },
        stubDeps(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("applyIssueCascade — gates", () => {
  it("404s when epic not found", async () => {
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        { epic_id: "DX-99", dest_list_name: "To Do", unblock_confirmed: false },
        stubDeps(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s on unknown dest_list_name", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssueCascade(
        "danxbot",
        repoLocalPath,
        { epic_id: "DX-1", dest_list_name: "Nope", unblock_confirmed: false },
        stubDeps(),
      ),
    ).rejects.toMatchObject({
      status: 404,
      body: {
        error: expect.stringContaining('"Nope" not found'),
      },
    });
  });

  // DX-658 — `"blocked"` is no longer a ListType; cascade never touches
  // Issue.blocked; the `blocked_reason` validation + unblock-confirm
  // gate are retired. Removed test:
  //   "400s on empty blocked_reason when destType=blocked"
});

describe("applyIssueCascade — happy path (epic + 5 descendants)", () => {
  beforeEach(() => {
    // Epic + five descendants in the canonical 7-list seed states. We
    // pin list_name + the gate fields so deriveListTypeForIssue reads
    // the intended ListType for each.
    const epic = makeIssue({
      id: "DX-1",
      type: "Epic",
      title: "Epic",
      children: ["DX-2", "DX-3", "DX-4", "DX-5", "DX-6"],
      status: "Review",
      list_name: "Review",
    });
    writeFixture(epic, "open");
    writeFixture(
      makeIssue({
        id: "DX-2",
        title: "review child",
        parent_id: "DX-1",
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-3",
        title: "ready child",
        parent_id: "DX-1",
        status: "ToDo",
        ready_at: "2026-05-01T00:00:00Z",
        list_name: "To Do",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-4",
        title: "in-progress child",
        parent_id: "DX-1",
        status: "ToDo",
        ready_at: "2026-05-01T00:00:00Z",
        dispatch: {
          id: "disp-1",
          pid: 100,
          host: "test",
          kind: "work",
          started_at: "2026-05-01T01:00:00Z",
          ttl_seconds: 3600,
        },
        list_name: "In Progress",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-5",
        title: "blocked child",
        parent_id: "DX-1",
        status: "In Progress",
        blocked: { at: "2026-05-01T00:00:00Z", reason: "stuck" },
        list_name: "Blocked",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-6",
        title: "done child",
        parent_id: "DX-1",
        status: "Done",
        completed_at: "2026-05-01T00:00:00Z",
        list_name: "Done",
      }),
      "closed",
    );
  });

  it("moves epic Review → To Do: lateral-same-type descendant follows; others stay", async () => {
    // unblock_confirmed=true bypasses the cascade's confirm gate — but
    // the FROM-blocked TO-ready default action still returns "stay"
    // regardless, so DX-5 ends up in skipped[]. The test exercises the
    // SAME-TYPE-LATERAL cell + every other passive-destination skip.
    const result = await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "To Do",
        unblock_confirmed: true,
      },
      stubDeps(),
    );
    // - FROM review + TO ready = SAME-TYPE-LATERAL → only descendants in
    //   parent's list_name (Review) follow → DX-2 follows.
    // - FROM ready + TO ready = SAME-TYPE-LATERAL → DX-3 stays in its
    //   current list since it's not in parent.list_name (Review).
    // - FROM in_progress + TO ready = stay
    // - FROM blocked + TO ready = stay (default-action; confirm bypassed
    //   but the cell's policy is still stay)
    // - FROM completed + TO ready = stay (terminal source)
    expect(result.updated).toContain("DX-1");
    expect(result.updated).toContain("DX-2");
    expect(result.skipped).toEqual(
      expect.arrayContaining(["DX-3", "DX-4", "DX-5", "DX-6"]),
    );
  });

  it("epic Review → Done: every non-terminal descendant cascades to Done", async () => {
    // dest=completed → spec: FROM review/ready/in_progress + TO completed
    // = move→completed. FROM blocked + TO completed needs confirm.
    const result = await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "Done",
        unblock_confirmed: true,
        // DX-6 was already completed; cascade keeps it as stay (terminal source).
      },
      stubDeps(),
    );
    expect(result.updated).toEqual(
      expect.arrayContaining(["DX-1", "DX-2", "DX-3", "DX-4", "DX-5"]),
    );
    expect(result.skipped).toEqual(["DX-6"]);

    // Parent epic now Done — should have moved to closed/
    const parent = readYaml("DX-1", "closed");
    expect(parent).toMatchObject({ status: "Done" });

    // Cascaded children also Done + in closed/
    for (const id of ["DX-2", "DX-3", "DX-4", "DX-5"]) {
      const c = readYaml(id, "closed");
      expect(c.status).toBe("Done");
      expect(c.completed_at).toBeTruthy();
    }

    // DX-658: cascade no longer touches Issue.blocked — the gate
    // persists across the descendant move. The blocked-descendant
    // unblock-confirm gate is also retired (entire flow removed).
    const dx5 = readYaml("DX-5", "closed");
    expect(dx5.blocked).toMatchObject({ at: "2026-05-01T00:00:00Z" });
  });

  // DX-658 — `requires unblock_confirmed=true when cascading across
  // blocked descendants to non-blocked` test removed: the entire
  // unblock-confirm gate was retired with the `"blocked"` ListType.

  it("override kind=stay skips a descendant regardless of spec", async () => {
    const result = await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "Done",
        unblock_confirmed: true,
        overrides: { "DX-2": { kind: "stay" } },
      },
      stubDeps(),
    );
    expect(result.skipped).toEqual(expect.arrayContaining(["DX-2", "DX-6"]));
    expect(result.updated).not.toContain("DX-2");
    // DX-2 still in open/, untouched.
    const dx2 = readYaml("DX-2", "open");
    expect(dx2.status).toBe("Review");
  });

  // DX-658 — `moving epic INTO blocked stamps parent only` test removed:
  // `"Blocked"` is no longer a list, so the cascade dest cannot resolve
  // to it. INTO-blocked is now a standalone `Issue.blocked` gate write
  // (covered by issue-write.test.ts).

  it("publishes one SSE issue:updated event per touched id", async () => {
    mockEventBusPublish.mockClear();
    await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "Done",
        unblock_confirmed: true,
      },
      stubDeps(),
    );
    // Touched: DX-1, DX-2, DX-3, DX-4, DX-5 (DX-6 stays terminal).
    const upsertEvents = mockEventBusPublish.mock.calls.filter(
      (call) => (call[0] as { topic: string }).topic === "issue:updated",
    );
    const touchedIds = upsertEvents.map(
      (call) => (call[0] as { data: { id: string } }).data.id,
    );
    // Exactly one event per touched id (no duplicates) — the upserts are
    // ordered parent first then descendants by BFS visit order.
    expect(touchedIds).toEqual(["DX-1", "DX-2", "DX-3", "DX-4", "DX-5"]);
    expect(new Set(touchedIds).size).toBe(touchedIds.length);
  });
});

describe("applyIssueCascade — must-fix coverage gaps", () => {
  it("override kind=move_to lands the descendant on a cross-type list with synthetic status", async () => {
    // Epic Review → Done with override DX-3 → Cancelled (move_to).
    writeFixture(
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2", "DX-3"],
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-2",
        parent_id: "DX-1",
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-3",
        parent_id: "DX-1",
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    const result = await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "Done",
        unblock_confirmed: false,
        overrides: {
          "DX-3": {
            kind: "move_to",
            listType: "cancelled",
            listName: "Cancelled",
          },
        },
      },
      stubDeps(),
    );
    expect(result.updated).toEqual(
      expect.arrayContaining(["DX-1", "DX-2", "DX-3"]),
    );
    // Parent + DX-2 → Done; DX-3 → Cancelled per override
    const dx2 = readYaml("DX-2", "closed");
    expect(dx2.status).toBe("Done");
    expect(dx2.completed_at).toBeTruthy();
    const dx3 = readYaml("DX-3", "closed");
    expect(dx3.status).toBe("Cancelled");
    expect(dx3.cancelled_at).toBeTruthy();
    expect(dx3.list_name).toBe("Cancelled");
  });

  it("DX-658: leftward override move_to ready-type list flips raw status off (blocked gate untouched)", async () => {
    // DX-658 retired the cascade's coupling between list_name moves and
    // the Issue.blocked field. The override still moves the card off the
    // (former) Blocked list to a ready-type list, flips status, stamps
    // ready_at — but `blocked` persists as an independent gate the
    // operator clears via the dashboard's dispatch-gates affordance.
    writeFixture(
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2"],
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-2",
        parent_id: "DX-1",
        status: "In Progress",
        blocked: { at: "2026-05-01T00:00:00Z", reason: "stuck" },
        list_name: "Blocked",
      }),
      "open",
    );
    await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        // Cascade default-action FROM blocked + TO ready = stay. Use an
        // override to force the move so the leftward-out-of-blocked
        // status sync surface actually fires.
        dest_list_name: "To Do",
        unblock_confirmed: true,
        overrides: {
          "DX-2": { kind: "move_to", listType: "ready", listName: "To Do" },
        },
      },
      stubDeps(),
    );
    const dx2 = readYaml("DX-2", "open");
    expect(dx2.blocked).toMatchObject({ at: "2026-05-01T00:00:00Z" });
    expect(dx2.status).toBe("ToDo");
    expect(dx2.ready_at).toBeTruthy();
  });

  it("terminal dest clears stale `dispatch` on an in-progress descendant", async () => {
    // DX-3 carries a stale `dispatch` record (active agent run); a
    // cascade to Done should clear it so the closed YAML doesn't carry
    // a misleading dispatch sidecar.
    writeFixture(
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-3"],
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-3",
        parent_id: "DX-1",
        status: "ToDo",
        ready_at: "2026-05-01T00:00:00Z",
        dispatch: {
          id: "disp-stale",
          pid: 100,
          host: "test",
          kind: "work",
          started_at: "2026-05-01T01:00:00Z",
          ttl_seconds: 3600,
        },
        list_name: "In Progress",
      }),
      "open",
    );
    await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "Done",
        unblock_confirmed: false,
      },
      stubDeps(),
    );
    const dx3 = readYaml("DX-3", "closed");
    expect(dx3.dispatch).toBeNull();
    expect(dx3.status).toBe("Done");
    expect(dx3.completed_at).toBeTruthy();
  });
});

describe("applyIssueCascade — nested epic-of-epics", () => {
  it("BFS-walks 3 levels and applies trigger writes across grandchildren", async () => {
    // Root epic DX-1 → child epic DX-2 → grandchild DX-3
    writeFixture(
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2"],
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-2",
        type: "Epic",
        parent_id: "DX-1",
        children: ["DX-3"],
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    writeFixture(
      makeIssue({
        id: "DX-3",
        parent_id: "DX-2",
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );

    const result = await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "Done",
        unblock_confirmed: false,
      },
      stubDeps(),
    );
    // All three moved to Done.
    expect(result.updated).toEqual(
      expect.arrayContaining(["DX-1", "DX-2", "DX-3"]),
    );
    // Grandchild moved to closed/.
    const dx3 = readYaml("DX-3", "closed");
    expect(dx3.status).toBe("Done");
  });
});

describe("applyIssueCascade — first-dispatch + dispatchableByPriority reuse", () => {
  it("only the first dispatchable descendant moves when dest=in_progress", async () => {
    writeFixture(
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2", "DX-3"],
        status: "Review",
        list_name: "Review",
      }),
      "open",
    );
    const dx2 = makeIssue({
      id: "DX-2",
      parent_id: "DX-1",
      status: "ToDo",
      ready_at: "2026-05-01T00:00:00Z",
      list_name: "To Do",
    });
    const dx3 = makeIssue({
      id: "DX-3",
      parent_id: "DX-1",
      status: "ToDo",
      ready_at: "2026-05-01T00:00:00Z",
      list_name: "To Do",
    });
    writeFixture(dx2, "open");
    writeFixture(dx3, "open");

    // Stub picker to put DX-3 first (priority order).
    const result = await applyIssueCascade(
      "danxbot",
      repoLocalPath,
      {
        epic_id: "DX-1",
        dest_list_name: "In Progress",
        unblock_confirmed: false,
      },
      stubDeps([dx3, dx2]),
    );
    expect(result.updated).toEqual(expect.arrayContaining(["DX-1", "DX-3"]));
    expect(result.updated).not.toContain("DX-2");
    expect(result.skipped).toContain("DX-2");
  });
});

describe("handlePatchIssueCascade — HTTP wrapping", () => {
  it("401s without a bearer", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", {
      epic_id: "DX-1",
      dest_list_name: "Done",
      unblock_confirmed: true,
    });
    const res = createMockRes();
    await handlePatchIssueCascade(req, res, "danxbot", buildDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("400s when repo query missing", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", {
      epic_id: "DX-1",
      dest_list_name: "Done",
      unblock_confirmed: true,
    });
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handlePatchIssueCascade(req, res, null, buildDeps());
    expect(res._getStatusCode()).toBe(400);
  });

  it("404s when repo unknown", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", {
      epic_id: "DX-1",
      dest_list_name: "Done",
      unblock_confirmed: true,
    });
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handlePatchIssueCascade(req, res, "missing-repo", buildDeps());
    expect(res._getStatusCode()).toBe(404);
  });
});
