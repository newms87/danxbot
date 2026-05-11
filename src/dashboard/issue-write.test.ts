import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";

// Mock auth-middleware before importing issue-write so the route's
// requireUser bypass mirrors the agents-toggles test pattern (Bearer
// "user-<name>" → authed; everything else → 401).
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

// Logger mock — silences the route's error logger during fault tests.
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

import {
  applyIssuePatch,
  handlePatchIssue,
  IssuePatchError,
  type IssuePatch,
} from "./issue-write.js";
import { serializeIssue, createEmptyIssue } from "../issue-tracker/yaml.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
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

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "issue-write-test-"));
  repoLocalPath = resolve(tmpRoot, "danxbot");
  mkdirSync(repoLocalPath, { recursive: true });
  writeConfig("DX");
  mockEventBusPublish.mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("applyIssuePatch — allowlist + body shape", () => {
  it("rejects an unknown field with 400 Field not patchable", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", { foo: "bar" }, "alice"),
    ).rejects.toMatchObject({ status: 400, body: { error: "Field not patchable: foo" } });
  });

  it("rejects an empty patch with 400", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", {}, "alice"),
    ).rejects.toMatchObject({ status: 400, body: { error: "Empty patch" } });
  });

  it("rejects a non-object body with 400", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", "nope", "alice"),
    ).rejects.toThrow(IssuePatchError);
  });

  it("rejects status not in the enum with 400", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", { status: "Bogus" }, "alice"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects empty title with 400", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", { title: "" }, "alice"),
    ).rejects.toMatchObject({ status: 400, body: { error: "title must be a non-empty string" } });
  });

  it("rejects ac items missing required fields with 400", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { ac: [{ title: 123, checked: true }] },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects comments_append without text", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { comments_append: { text: "" } },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects requires_human with empty reason", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { requires_human: { reason: "", steps: [], set_by: "human", set_at: "x" } },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects requires_human.steps when it is not an array", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        {
          requires_human: {
            reason: "x",
            // Wrong shape — `steps` is a string instead of an array.
            steps: "not an array" as unknown as string[],
            set_by: "human",
            set_at: "x",
          },
        },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects requires_human.steps[i] when an entry is non-string", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        {
          requires_human: {
            reason: "x",
            // Second entry is a number — the panel's reorder UI guarantees
            // strings, but a malformed external client must 400.
            steps: ["valid", 42 as unknown as string],
            set_by: "human",
            set_at: "x",
          },
        },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects requires_human when the body is an array (must be mapping or null)", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { requires_human: [] as unknown as null },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects reopen ≠ true literally", async () => {
    writeFixture(makeIssue({ status: "Done" }), "closed");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { reopen: false } as unknown as IssuePatch,
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("applyIssuePatch — round-trip mutation", () => {
  it("applies title + description and writes the YAML in place", async () => {
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { title: "Renamed", description: "New body" },
      "alice",
    );
    expect(issue.title).toBe("Renamed");
    expect(issue.description).toBe("New body");
    const onDisk = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    );
    expect(onDisk).toMatchObject({ title: "Renamed", description: "New body" });
  });

  it("ac is full-array replace (not merge)", async () => {
    writeFixture(
      makeIssue({
        ac: [
          { check_item_id: "old-1", title: "first", checked: false },
          { check_item_id: "old-2", title: "second", checked: false },
        ],
      }),
      "open",
    );
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { ac: [{ check_item_id: "old-1", title: "first", checked: true }] },
      "alice",
    );
    expect(issue.ac).toHaveLength(1);
    expect(issue.ac[0]).toMatchObject({ check_item_id: "old-1", checked: true });
  });

  it("comments_append server-stamps author + timestamp; client-supplied values are ignored", async () => {
    // Frozen clock — under load Date.now() can drift back across an
    // await boundary (WSL2 NTP correction observed ~800ms). Locking
    // the clock makes the stamp deterministic and lets the assertion
    // be exact equality, not a flaky `>=`. The patch path uses
    // `new Date().toISOString()` which respects vi.setSystemTime.
    vi.useFakeTimers();
    const frozen = new Date("2026-05-11T12:00:00.000Z");
    vi.setSystemTime(frozen);
    try {
      writeFixture(makeIssue(), "open");
      const issue = await applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        // Even if a malicious client passes author+timestamp, the route
        // only reads `text` from the validated patch shape.
        { comments_append: { text: "looks good" } } as IssuePatch,
        "alice",
      );
      expect(issue.comments).toHaveLength(1);
      expect(issue.comments[0].author).toBe("alice");
      expect(issue.comments[0].text).toBe("looks good");
      expect(issue.comments[0].timestamp).toBe(frozen.toISOString());
      expect(issue.comments[0]).not.toHaveProperty("id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires_human server-stamps set_by: human + set_at; client cannot fake set_by", async () => {
    // Same frozen-clock discipline as the comments_append test above —
    // exact-equality assertion replaces the flaky `>=` and removes the
    // load-induced clock-drift failure mode.
    vi.useFakeTimers();
    const frozen = new Date("2026-05-11T12:00:00.000Z");
    vi.setSystemTime(frozen);
    try {
      writeFixture(makeIssue(), "open");
      const issue = await applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        {
          requires_human: {
            reason: "Need API key",
            steps: ["rotate it"],
            // Client tries to spoof "agent" — server overrides to "human".
            set_by: "agent",
            set_at: "1970-01-01T00:00:00Z",
          },
        },
        "alice",
      );
      expect(issue.requires_human).not.toBeNull();
      expect(issue.requires_human?.set_by).toBe("human");
      expect(issue.requires_human?.set_at).toBe(frozen.toISOString());
      expect(issue.requires_human?.reason).toBe("Need API key");
      expect(issue.requires_human?.steps).toEqual(["rotate it"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves requires_human.steps[] order verbatim (panel reorder UX contract)", async () => {
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      {
        requires_human: {
          reason: "ordered actions",
          // Deliberately unsorted — the dashboard's RequiresHumanPanel
          // ships ↑↓ reorder; the server must not alphabetize or dedupe.
          steps: ["c-first", "a-second", "b-third"],
          set_by: "human",
          set_at: "x",
        },
      },
      "alice",
    );
    expect(issue.requires_human?.steps).toEqual([
      "c-first",
      "a-second",
      "b-third",
    ]);
  });

  it("requires_human: null clears the field", async () => {
    writeFixture(
      makeIssue({
        requires_human: {
          reason: "Old",
          steps: ["x"],
          set_by: "agent",
          set_at: "2026-05-09T00:00:00Z",
        },
      }),
      "open",
    );
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { requires_human: null },
      "alice",
    );
    expect(issue.requires_human).toBeNull();
  });

  it("status: Done moves the file open/ → closed/ and unlinks the source", async () => {
    const openPath = writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { status: "Done" },
      "alice",
    );
    expect(issue.status).toBe("Done");
    expect(existsSync(openPath)).toBe(false);
    expect(existsSync(issuePath(repoLocalPath, "DX-1", "closed"))).toBe(true);
  });

  it("status: Cancelled also closes the card", async () => {
    const openPath = writeFixture(makeIssue(), "open");
    await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { status: "Cancelled" },
      "alice",
    );
    expect(existsSync(openPath)).toBe(false);
    expect(existsSync(issuePath(repoLocalPath, "DX-1", "closed"))).toBe(true);
  });

  it("reopen: true moves closed/ → open/ and defaults status to ToDo", async () => {
    const closedPath = writeFixture(
      makeIssue({ status: "Done" }),
      "closed",
    );
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { reopen: true },
      "alice",
    );
    expect(issue.status).toBe("ToDo");
    expect(existsSync(closedPath)).toBe(false);
    expect(existsSync(issuePath(repoLocalPath, "DX-1", "open"))).toBe(true);
  });

  it("reopen: true with explicit status overrides the default", async () => {
    writeFixture(makeIssue({ status: "Done" }), "closed");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { reopen: true, status: "In Progress" },
      "alice",
    );
    expect(issue.status).toBe("In Progress");
  });

  it("reopen against an open card returns 400", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", { reopen: true }, "alice"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reopen + status: Done is rejected as contradictory", async () => {
    writeFixture(makeIssue({ status: "Done" }), "closed");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { reopen: true, status: "Done" },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("404 when the file is missing in both open/ and closed/", async () => {
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-99", { title: "x" }, "alice"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("status: Blocked auto-stamps `blocked` so the YAML invariant survives a drag (DX-237)", async () => {
    // The dashboard write API is the human-driven surface — a drag-to-Blocked
    // operator gesture has no place to declare a reason, so the server stamps
    // a generic record. The agent path still uses the full `blocked: {reason,
    // timestamp}` shape via Edit/Write — this normalization only fires for
    // the dashboard's status-only patches.
    //
    // Frozen clock — same flake class as the server-stamp tests above
    // (DX-254). Exact-equality removes the WSL2 NTP-drift failure mode.
    vi.useFakeTimers();
    const frozen = new Date("2026-05-11T12:00:00.000Z");
    vi.setSystemTime(frozen);
    try {
      writeFixture(makeIssue(), "open");
      const issue = await applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { status: "Blocked" },
        "alice",
      );
      expect(issue.status).toBe("Blocked");
      expect(issue.blocked).not.toBeNull();
      expect(issue.blocked!.reason).toBe("Manually moved to Blocked via dashboard");
      expect(issue.blocked!.timestamp).toBe(frozen.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("status away from Blocked auto-clears `blocked` (drag out of Blocked)", async () => {
    writeFixture(
      makeIssue({
        status: "Blocked",
        blocked: { reason: "old reason", timestamp: "2026-04-20T00:00:00Z" },
      }),
      "open",
    );
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { status: "In Progress" },
      "alice",
    );
    expect(issue.status).toBe("In Progress");
    expect(issue.blocked).toBeNull();
  });

  it("status away from ToDo auto-clears `waiting_on` (operator wins over dispatch gates)", async () => {
    writeFixture(
      makeIssue({
        status: "ToDo",
        waiting_on: {
          reason: "queued behind DX-99",
          timestamp: "2026-04-20T00:00:00Z",
          by: ["DX-99"],
        },
      }),
      "open",
    );
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { status: "In Progress" },
      "alice",
    );
    expect(issue.status).toBe("In Progress");
    expect(issue.waiting_on).toBeNull();
  });

  it("status patch that does not touch Blocked leaves `blocked` alone", async () => {
    writeFixture(makeIssue({ status: "ToDo", blocked: null }), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { status: "In Progress" },
      "alice",
    );
    expect(issue.blocked).toBeNull();
  });
});

describe("applyIssuePatch — atomic write + rollback", () => {
  it("leaves the original file unchanged when validation rejects the patch", async () => {
    writeFixture(makeIssue(), "open");
    const before = readFileSync(
      issuePath(repoLocalPath, "DX-1", "open"),
      "utf-8",
    );
    // Empty title is rejected by parseIssue's strict schema, so the
    // serialized YAML round-trip throws and the temp file is rolled back
    // before the destination is touched.
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { title: "" },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
    const after = readFileSync(
      issuePath(repoLocalPath, "DX-1", "open"),
      "utf-8",
    );
    expect(after).toBe(before);
  });

  it("does not leave .tmp residue alongside the destination on success", async () => {
    writeFixture(makeIssue(), "open");
    await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { title: "Renamed" },
      "alice",
    );
    const dir = readdirSync(resolve(repoLocalPath, ".danxbot/issues/open"));
    expect(dir.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("applyIssuePatch — atomic write rolls back on disk error", () => {
  it("returns 500 + leaves the destination unchanged when the target dir is unwritable", async () => {
    writeFixture(makeIssue(), "open");
    const openDir = resolve(repoLocalPath, ".danxbot/issues/open");
    const before = readFileSync(
      issuePath(repoLocalPath, "DX-1", "open"),
      "utf-8",
    );
    // chmod the open/ dir to read+execute only — `writeFileSync(tmpPath)`
    // throws EACCES, hitting the route's `IssuePatchError(500)` path.
    // ensureIssuesDirs's mkdirSync(recursive) is a no-op on the existing
    // dir so it doesn't trip on the missing-write bit.
    const { chmodSync, statSync } = await import("node:fs");
    const originalMode = statSync(openDir).mode & 0o777;
    chmodSync(openDir, 0o500);
    try {
      await expect(
        applyIssuePatch(
          "danxbot",
          repoLocalPath,
          "DX-1",
          { title: "renamed" },
          "alice",
        ),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      chmodSync(openDir, originalMode);
    }
    // No .tmp residue (writeFileSync threw before creating the file).
    const dir = readdirSync(openDir);
    expect(dir.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    // Original file unchanged — atomic = "all-or-nothing".
    const after = readFileSync(
      issuePath(repoLocalPath, "DX-1", "open"),
      "utf-8",
    );
    expect(after).toBe(before);
    // No SSE event on disk failure.
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });
});

describe("applyIssuePatch — error-path coverage", () => {
  it("returns 500 when on-disk YAML is malformed", async () => {
    writeFixture(makeIssue(), "open");
    // Overwrite the YAML with garbage AFTER the fixture write so the
    // parseIssue call inside applyValidatedPatch throws.
    writeFileSync(
      issuePath(repoLocalPath, "DX-1", "open"),
      "this: is: not: valid: yaml: at: all",
    );
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", { title: "x" }, "alice"),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("a prior patch's rejection does NOT poison subsequent patches on the same id (M1 regression)", async () => {
    // Code-review M1: without the prior-rejection swallow, the second
    // queued patch on DX-1 would propagate-reject the first patch's
    // error forever, breaking every dashboard write on that card for
    // the rest of the process lifetime.
    writeFixture(makeIssue(), "open");
    // First patch deliberately fails (non-allowlisted field).
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { foo: "bar" },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400, body: { error: "Field not patchable: foo" } });
    // Second patch on the SAME id MUST run cleanly.
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { title: "Renamed" },
      "alice",
    );
    expect(issue.title).toBe("Renamed");
  });
});

describe("applyIssuePatch — per-id mutex serializes concurrent writes", () => {
  it("two concurrent comments_append both land (no lost update)", async () => {
    writeFixture(makeIssue(), "open");
    await Promise.all([
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { comments_append: { text: "first" } },
        "alice",
      ),
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { comments_append: { text: "second" } },
        "bob",
      ),
    ]);
    // Reload from disk — both comments must be present. Without the
    // mutex, the second writer would read the pre-first-write snapshot
    // and lose the first append.
    const onDisk = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    ) as { comments: Array<{ text: string }> };
    expect(onDisk.comments).toHaveLength(2);
    const texts = onDisk.comments.map((c) => c.text).sort();
    expect(texts).toEqual(["first", "second"]);
  });

  it("two concurrent writers on different cards do NOT serialize against each other", async () => {
    writeFixture(makeIssue({ id: "DX-1" }), "open");
    writeFixture(makeIssue({ id: "DX-2" }), "open");
    // Both should resolve. The mutex is per-id, not per-repo.
    await Promise.all([
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { title: "A" },
        "alice",
      ),
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-2",
        { title: "B" },
        "bob",
      ),
    ]);
    const a = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    ) as { title: string };
    const b = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-2", "open"), "utf-8"),
    ) as { title: string };
    expect(a.title).toBe("A");
    expect(b.title).toBe("B");
  });
});

describe("applyIssuePatch — SSE event emission", () => {
  it("publishes issue:updated with the post-patch issue on success", async () => {
    writeFixture(makeIssue(), "open");
    await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { title: "Renamed" },
      "alice",
    );
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const call = mockEventBusPublish.mock.calls[0][0];
    expect(call.topic).toBe("issue:updated");
    expect(call.data.repo).toBe("danxbot");
    expect(call.data.id).toBe("DX-1");
    expect(call.data.issue.title).toBe("Renamed");
  });

  it("does NOT publish issue:updated when validation rejects", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch("danxbot", repoLocalPath, "DX-1", {}, "alice"),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  it("publishes the post-patch requires_human block in the issue:updated payload (DX-239 cross-client sync)", async () => {
    writeFixture(makeIssue(), "open");
    await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      {
        requires_human: {
          reason: "Need vendor access",
          steps: ["Grant role A", "Notify ops"],
        },
      },
      "alice",
    );
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const call = mockEventBusPublish.mock.calls[0][0];
    expect(call.topic).toBe("issue:updated");
    // The broadcast carries the post-patch Issue verbatim — the SPA
    // relies on this so a second operator's view updates without a refetch.
    expect(call.data.issue.requires_human).toMatchObject({
      reason: "Need vendor access",
      steps: ["Grant role A", "Notify ops"],
      set_by: "human",
    });
    expect(call.data.issue.requires_human.set_at.length).toBeGreaterThan(0);
  });
});

describe("handlePatchIssue — HTTP route", () => {
  function makeDeps() {
    return buildDeps({
      repos: [
        {
          name: "danxbot",
          url: "x",
          localPath: repoLocalPath,
          hostPath: repoLocalPath,
          workerPort: 5562,
        },
      ],
    });
  }

  it("401 without a user bearer", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", { title: "x" });
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("401 when the bearer is the dispatch token shape", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", { title: "x" });
    req.headers = { authorization: "Bearer test-token" };
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("400 when repo query is missing", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", { title: "x" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", null, makeDeps());
    expect(res._getStatusCode()).toBe(400);
  });

  it("404 when the repo is not configured", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", { title: "x" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", "unknown-repo", makeDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("200 on success, returns the post-patch issue", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", { title: "Renamed" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.issue.title).toBe("Renamed");
  });

  it("404 when the issue file is not on disk", async () => {
    const req = createMockReqWithBody("PATCH", { title: "x" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-99", "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("400 on a non-allowlisted field", async () => {
    writeFixture(makeIssue(), "open");
    const req = createMockReqWithBody("PATCH", { foo: "bar" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Field not patchable: foo",
    });
  });

  it("400 Invalid JSON body when parseBody throws", async () => {
    // Build a request whose body never closes with valid JSON — emit
    // garbage then end. parseBody resolves with parse error.
    const http = await import("http");
    const req = new http.IncomingMessage(null as never);
    req.method = "PATCH";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not-json{"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Invalid JSON body" });
  });

  it("500 when applyIssuePatch throws a non-IssuePatchError", async () => {
    // No config file at the test repo path → loadIssuePrefix throws a
    // plain Error (not an IssuePatchError). The route's catch block
    // 500s with the error message, which the SPA can render directly.
    writeFixture(makeIssue(), "open");
    rmSync(resolve(repoLocalPath, ".danxbot/config"), {
      recursive: true,
      force: true,
    });
    const req = createMockReqWithBody("PATCH", { title: "x" });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePatchIssue(req, res, "DX-1", "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/issue_prefix|config\.yml/);
  });
});
