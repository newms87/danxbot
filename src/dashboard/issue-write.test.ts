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
  createIssue,
  deleteIssue,
  handlePatchIssue,
  handlePostIssue,
  IssuePatchError,
  moveAcrossDevices,
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

  it("rejects invalid type with 400", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { type: "Bogus" as never },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts a type flip (Feature → Epic) and lands on disk", async () => {
    writeFixture(makeIssue({ type: "Feature" }), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { type: "Epic" },
      "alice",
    );
    expect(issue.type).toBe("Epic");
    const onDisk = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    );
    expect(onDisk).toMatchObject({ type: "Epic" });
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

  it("rejects position with a non-number, non-null value (string)", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { position: "5" as unknown as number },
        "alice",
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "position must be a finite number or null" },
    });
  });

  it("rejects position with NaN", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { position: Number.NaN },
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects position with Infinity", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { position: Number.POSITIVE_INFINITY },
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

  it("DX-521 — rejects priority: 0 (must be > 0)", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { priority: 0 },
        "alice",
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "priority must be a finite number in (0, 6)" },
    });
  });

  it("DX-521 — rejects priority: 6 (must be < 6)", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { priority: 6 },
        "alice",
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "priority must be a finite number in (0, 6)" },
    });
  });

  it("DX-521 — rejects priority: -1 (negative, out of open interval)", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { priority: -1 },
        "alice",
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "priority must be a finite number in (0, 6)" },
    });
  });

  it("DX-521 — rejects priority: NaN", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { priority: Number.NaN },
        "alice",
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "priority must be a finite number in (0, 6)" },
    });
  });

  it("DX-521 — rejects priority: Infinity", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { priority: Number.POSITIVE_INFINITY },
        "alice",
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "priority must be a finite number in (0, 6)" },
    });
  });

  it('DX-521 — rejects priority: "high" (non-numeric — caught by the (0, 6) guard)', async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { priority: "high" as unknown as number },
        "alice",
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "priority must be a finite number in (0, 6)" },
    });
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

  it("position: finite number lands on disk + post-patch issue carries it", async () => {
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { position: 1.5 },
      "alice",
    );
    expect(issue.position).toBe(1.5);
    const onDisk = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    );
    expect(onDisk).toMatchObject({ position: 1.5 });
  });

  it("position: null clears the override", async () => {
    writeFixture(makeIssue({ position: 7.25 }), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { position: null },
      "alice",
    );
    expect(issue.position).toBeNull();
    const onDisk = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    );
    expect(onDisk).toMatchObject({ position: null });
  });

  it("DX-521 — priority: 4.2 lands on disk + publishes issue:updated SSE", async () => {
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { priority: 4.2 },
      "alice",
    );
    expect(issue.priority).toBe(4.2);
    const onDisk = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    );
    expect(onDisk).toMatchObject({ priority: 4.2 });
    expect(mockEventBusPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "issue:updated",
        data: expect.objectContaining({
          repoName: "danxbot",
          id: "DX-1",
          issue: expect.objectContaining({ priority: 4.2 }),
        }),
      }),
    );
  });

  it("DX-521 — priority: 0.01 (minimum allowed) round-trips", async () => {
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { priority: 0.01 },
      "alice",
    );
    expect(issue.priority).toBe(0.01);
  });

  it("DX-521 — priority: 5.99 (maximum allowed) round-trips", async () => {
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { priority: 5.99 },
      "alice",
    );
    expect(issue.priority).toBe(5.99);
  });

  it("DX-521 — validator-vs-clamp asymmetry: priority 0.001 passes PATCH then clamps to 0.01 on re-parse", async () => {
    // The PATCH validator accepts the open interval (0, 6) — `0.001`
    // passes. The applier writes the raw value to disk; the next
    // `parseIssue` clamps to `PRIORITY_MIN` (0.01). The two layers are
    // intentionally asymmetric (validator = open interval, clamp =
    // closed bounds) — this test pins the gap so a future "tighten the
    // validator to match the clamp" change is a conscious choice.
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { priority: 0.001 },
      "alice",
    );
    // PATCH layer returns the raw post-patch issue (clamp does not run
    // inside applyValidatedPatch).
    expect(issue.priority).toBe(0.001);
    // The on-disk YAML reflects the raw value too — clamp only runs
    // when a future reader calls parseIssue. Sanity-check the chokidar
    // mirror will see `0.001` and forward it; the clamp is the next
    // reader's safety net.
    const onDiskRaw = readFileSync(
      issuePath(repoLocalPath, "DX-1", "open"),
      "utf-8",
    );
    expect(onDiskRaw).toMatch(/priority:\s*0\.001/);
    // Re-parsing through the strict parser clamps to PRIORITY_MIN.
    const reParsed = parseYamlText(onDiskRaw);
    expect(reParsed).toMatchObject({ priority: 0.001 });
    // Confirm the clamp would fire by running parseIssue directly.
    // (Import inline so we don't add a top-level import for one test.)
    const { parseIssue } = await import("../issue-tracker/yaml.js");
    const clamped = parseIssue(onDiskRaw, { expectedPrefix: "DX" });
    expect(clamped.priority).toBe(0.01);
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
      expect(issue.blocked!.at).toBe(frozen.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("status away from Blocked auto-clears `blocked` (drag out of Blocked)", async () => {
    writeFixture(
      makeIssue({
        status: "Blocked",
        blocked: { reason: "old reason", at: "2026-04-20T00:00:00Z" },
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

  it("status away from ToDo preserves `waiting_on` (independent durable dep-chain record)", async () => {
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
    expect(issue.waiting_on).not.toBeNull();
    expect(issue.waiting_on?.by).toEqual(["DX-99"]);
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
    expect(call.data.repoName).toBe("danxbot");
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

describe("applyIssuePatch — conflict_on + blocked (DX-309)", () => {
  it("accepts conflict_on full-array replace and round-trips", async () => {
    writeFixture(makeIssue(), "open");
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      {
        conflict_on: [
          { id: "DX-9", reason: "scheduler.ts collision" },
          { id: "DX-11", reason: "shared header" },
        ],
      },
      "alice",
    );
    expect(issue.conflict_on).toHaveLength(2);
    expect(issue.conflict_on[0]).toEqual({
      id: "DX-9",
      reason: "scheduler.ts collision",
    });
    const onDisk = parseYamlText(
      readFileSync(issuePath(repoLocalPath, "DX-1", "open"), "utf-8"),
    ) as { conflict_on: unknown[] };
    expect(onDisk.conflict_on).toHaveLength(2);
  });

  it("clears all conflict entries with []", async () => {
    writeFixture(
      makeIssue({
        conflict_on: [{ id: "DX-9", reason: "old" }],
      }),
      "open",
    );
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { conflict_on: [] },
      "alice",
    );
    expect(issue.conflict_on).toHaveLength(0);
  });

  it("rejects conflict_on with invalid id shape (not <PREFIX>-N)", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { conflict_on: [{ id: "not-an-id", reason: "x" }] } as IssuePatch,
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects conflict_on entry with empty reason", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { conflict_on: [{ id: "DX-9", reason: "" }] } as IssuePatch,
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects duplicate ids in conflict_on", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        {
          conflict_on: [
            { id: "DX-9", reason: "a" },
            { id: "DX-9", reason: "b" },
          ],
        } as IssuePatch,
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocked: null + status: ToDo clears self-block (dashboard Clear button)", async () => {
    writeFixture(
      makeIssue({
        status: "Blocked",
        blocked: { reason: "x", at: "2026-05-12T00:00:00Z" },
      }),
      "open",
    );
    const issue = await applyIssuePatch(
      "danxbot",
      repoLocalPath,
      "DX-1",
      { blocked: null, status: "ToDo" } as IssuePatch,
      "alice",
    );
    expect(issue.blocked).toBeNull();
    expect(issue.status).toBe("ToDo");
  });

  it("rejects blocked patch with a non-null value (agent-only territory)", async () => {
    writeFixture(makeIssue(), "open");
    await expect(
      applyIssuePatch(
        "danxbot",
        repoLocalPath,
        "DX-1",
        { blocked: { reason: "fake", at: "2026-05-12T00:00:00Z" } } as unknown as IssuePatch,
        "alice",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DX-350 — POST /api/issues (dashboard Create Card surface)
// ─────────────────────────────────────────────────────────────────────────

describe("createIssue — body validation", () => {
  it("rejects non-object body with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, "nope"),
    ).rejects.toMatchObject({ status: 400, body: { error: "Body must be a JSON object" } });
  });

  it("rejects array body with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, []),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects missing title with 400 naming the field", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        description: "x",
        status: "Review",
        type: "Feature",
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "title must be a non-empty string" },
    });
  });

  it("rejects whitespace-only title with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "   ",
        description: "x",
        status: "Review",
        type: "Feature",
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "title must be a non-empty string" },
    });
  });

  it("rejects missing description with 400 naming the field", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Test",
        status: "Review",
        type: "Feature",
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "description must be a non-empty string" },
    });
  });

  it("rejects whitespace-only description with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Test",
        description: "\n\t  ",
        status: "Review",
        type: "Feature",
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "description must be a non-empty string" },
    });
  });

  it("rejects status outside the create allowlist (In Progress) with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Test",
        description: "x",
        status: "In Progress",
        type: "Feature",
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "status must be one of [Review, ToDo]" },
    });
  });

  it("rejects status outside the create allowlist (Done) with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Test",
        description: "x",
        status: "Done",
        type: "Feature",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects status not in the enum at all with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Test",
        description: "x",
        status: "Bogus",
        type: "Feature",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects type not in the enum with 400 naming the allowlist", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Test",
        description: "x",
        status: "Review",
        type: "Story",
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "type must be one of [Epic, Bug, Feature, Chore]" },
    });
  });

  it("rejects type that is not a string with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Test",
        description: "x",
        status: "Review",
        type: 7,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does NOT publish issue:updated when validation rejects", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "",
        description: "x",
        status: "Review",
        type: "Feature",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });
});

describe("createIssue — happy path", () => {
  it("allocates DX-1 in an empty repo, writes YAML, publishes SSE", async () => {
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "First card",
      description: "Body",
      status: "Review",
      type: "Feature",
    });
    expect(issue.id).toBe("DX-1");
    expect(issue.title).toBe("First card");
    expect(issue.description).toBe("Body");
    // DX-544 — every new card lands in the flesh-out sentinel-block state;
    // the operator's chosen starting status (Review) is encoded into the
    // sentinel `blocked.reason` so the flesh-out agent can restore it.
    expect(issue.status).toBe("Blocked");
    expect(issue.blocked).toEqual({
      reason: "Awaiting flesh-out — start as Review",
      at: expect.any(String),
    });
    expect(issue.type).toBe("Feature");
    // YAML landed in open/ at the expected path
    const onDiskPath = issuePath(repoLocalPath, "DX-1", "open");
    expect(existsSync(onDiskPath)).toBe(true);
    const onDisk = parseYamlText(readFileSync(onDiskPath, "utf-8")) as {
      id: string;
      title: string;
      status: string;
    };
    expect(onDisk.id).toBe("DX-1");
    expect(onDisk.title).toBe("First card");
    // SSE event with the post-create issue
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const call = mockEventBusPublish.mock.calls[0][0];
    expect(call.topic).toBe("issue:updated");
    expect(call.data.repoName).toBe("danxbot");
    expect(call.data.id).toBe("DX-1");
    expect(call.data.issue.title).toBe("First card");
  });

  it("monotonically increments id when prior cards exist", async () => {
    writeFixture(makeIssue({ id: "DX-1" }), "open");
    writeFixture(makeIssue({ id: "DX-5" }), "closed");
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "Next",
      description: "Body",
      status: "ToDo",
      type: "Bug",
    });
    expect(issue.id).toBe("DX-6");
  });

  it("creates open/ + closed/ dirs when missing", async () => {
    // Fresh repo path has nothing under .danxbot/issues yet (writeConfig
    // only seeds .danxbot/config/config.yml).
    await createIssue("danxbot", repoLocalPath, {
      title: "Test",
      description: "Body",
      status: "ToDo",
      type: "Chore",
    });
    expect(existsSync(issuePath(repoLocalPath, "DX-1", "open"))).toBe(true);
  });

  it("starts cards in Blocked + sentinel encoding Review when Review was requested", async () => {
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "Triage me",
      description: "Body",
      status: "Review",
      type: "Feature",
    });
    // DX-544 — sentinel-block ride-along: status is Blocked, reason encodes
    // the operator's chosen start (Review). The flesh-out agent parses the
    // reason back out and restores `status: "Review"` on completion.
    expect(issue.status).toBe("Blocked");
    expect(issue.blocked?.reason).toBe("Awaiting flesh-out — start as Review");
  });

  it("starts cards in Blocked + sentinel encoding ToDo when ToDo was requested", async () => {
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "Ready",
      description: "Body",
      status: "ToDo",
      type: "Feature",
    });
    expect(issue.status).toBe("Blocked");
    expect(issue.blocked?.reason).toBe("Awaiting flesh-out — start as ToDo");
  });

  it("respects all four valid types", async () => {
    const types = ["Bug", "Feature", "Epic", "Chore"] as const;
    for (const t of types) {
      const issue = await createIssue("danxbot", repoLocalPath, {
        title: `Card ${t}`,
        description: "Body",
        status: "ToDo",
        type: t,
      });
      expect(issue.type).toBe(t);
    }
  });

  it("created card has empty ac[], empty children[], null waiting_on/requires_human, sentinel blocked", async () => {
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "Defaults",
      description: "Body",
      status: "Review",
      type: "Feature",
    });
    expect(issue.ac).toEqual([]);
    expect(issue.children).toEqual([]);
    expect(issue.waiting_on).toBeNull();
    // DX-544 — sentinel-block ride-along (blocked is non-null on create).
    expect(issue.blocked).toEqual({
      reason: "Awaiting flesh-out — start as Review",
      at: expect.any(String),
    });
    expect(issue.requires_human).toBeNull();
  });

  it("DX-544 — optional priority round-trips into Issue.priority", async () => {
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "Prio",
      description: "Body",
      status: "ToDo",
      type: "Feature",
      priority: 4.5,
    });
    expect(issue.priority).toBe(4.5);
  });

  it("DX-544 — omitted priority falls back to PRIORITY_DEFAULT (3.0)", async () => {
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "Prio",
      description: "Body",
      status: "ToDo",
      type: "Feature",
    });
    expect(issue.priority).toBe(3.0);
  });

  it("DX-544 — non-finite priority is rejected with 400", async () => {
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "Prio",
        description: "Body",
        status: "ToDo",
        type: "Feature",
        priority: Number.NaN,
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "priority must be a finite number" },
    });
  });
});

describe("createIssue — concurrency + disk fault paths (review C1/T1/T2)", () => {
  it("two concurrent creates allocate distinct ids (per-repo mutex)", async () => {
    // Without the per-repo create mutex both `nextIssueId` reads see
    // `max(N) = 0`, both writers race for DX-1, and the second rename
    // clobbers the first card. The mutex serializes the read-then-write,
    // so the two ids must be DX-1 and DX-2 with both YAMLs on disk.
    const [a, b] = await Promise.all([
      createIssue("danxbot", repoLocalPath, {
        title: "First",
        description: "Body",
        status: "Review",
        type: "Feature",
      }),
      createIssue("danxbot", repoLocalPath, {
        title: "Second",
        description: "Body",
        status: "ToDo",
        type: "Bug",
      }),
    ]);
    const ids = new Set<string>([a.id, b.id]);
    expect(ids.size).toBe(2);
    expect(ids).toEqual(new Set<string>(["DX-1", "DX-2"]));
    // Both YAML files exist on disk (no clobber)
    expect(existsSync(issuePath(repoLocalPath, "DX-1", "open"))).toBe(true);
    expect(existsSync(issuePath(repoLocalPath, "DX-2", "open"))).toBe(true);
  });

  it("a prior create's rejection does NOT poison subsequent creates on the same repo", async () => {
    // First create rejects (whitespace title); the per-repo mutex MUST
    // swallow the rejection so the next queued create runs cleanly.
    // Mirrors the M1 regression test for the PATCH mutex.
    await expect(
      createIssue("danxbot", repoLocalPath, {
        title: "   ",
        description: "y",
        status: "Review",
        type: "Feature",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const issue = await createIssue("danxbot", repoLocalPath, {
      title: "Recovered",
      description: "Body",
      status: "Review",
      type: "Feature",
    });
    expect(issue.id).toBe("DX-1");
  });

  it("leaves no .tmp residue after a successful create", async () => {
    await createIssue("danxbot", repoLocalPath, {
      title: "Tidy",
      description: "Body",
      status: "Review",
      type: "Feature",
    });
    const openDir = resolve(repoLocalPath, ".danxbot/issues/open");
    const files = readdirSync(openDir);
    expect(files.filter((f: string) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(files).toContain("DX-1.yml");
  });

  it("does NOT publish issue:updated when the write fails after validation", async () => {
    // Make the open/ dir read-only AFTER the create dirs are seeded so
    // ensureIssuesDirs succeeds but writeFileSync throws.
    const { chmodSync, mkdirSync } = await import("node:fs");
    mkdirSync(resolve(repoLocalPath, ".danxbot/issues/open"), { recursive: true });
    const openDir = resolve(repoLocalPath, ".danxbot/issues/open");
    const originalMode = 0o755;
    chmodSync(openDir, 0o555);
    try {
      await expect(
        createIssue("danxbot", repoLocalPath, {
          title: "Doomed",
          description: "Body",
          status: "Review",
          type: "Feature",
        }),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      chmodSync(openDir, originalMode);
    }
    expect(mockEventBusPublish).not.toHaveBeenCalled();
    // No .tmp residue
    const files = readdirSync(openDir);
    expect(files.filter((f: string) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("handlePostIssue — HTTP route", () => {
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
    const req = createMockReqWithBody("POST", {
      title: "x",
      description: "y",
      status: "Review",
      type: "Feature",
    });
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("401 when the bearer is the dispatch token shape (not a user)", async () => {
    const req = createMockReqWithBody("POST", {
      title: "x",
      description: "y",
      status: "Review",
      type: "Feature",
    });
    req.headers = { authorization: "Bearer test-token" };
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(401);
  });

  it("400 when repo query is missing", async () => {
    const req = createMockReqWithBody("POST", {
      title: "x",
      description: "y",
      status: "Review",
      type: "Feature",
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePostIssue(req, res, null, makeDeps());
    expect(res._getStatusCode()).toBe(400);
  });

  it("404 when the repo is not configured", async () => {
    const req = createMockReqWithBody("POST", {
      title: "x",
      description: "y",
      status: "Review",
      type: "Feature",
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePostIssue(req, res, "unknown-repo", makeDeps());
    expect(res._getStatusCode()).toBe(404);
  });

  it("200 on success, returns the parsed issue", async () => {
    const req = createMockReqWithBody("POST", {
      title: "Test card",
      description: "Body",
      status: "Review",
      type: "Feature",
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.issue.id).toBe("DX-1");
    expect(body.issue.title).toBe("Test card");
    // DX-544 — sentinel-block ride-along: the HTTP echo reflects the
    // Blocked status with the encoded starting status in `blocked.reason`.
    expect(body.issue.status).toBe("Blocked");
    expect(body.issue.blocked.reason).toBe("Awaiting flesh-out — start as Review");
    expect(body.issue.type).toBe("Feature");
  });

  it("400 on a missing field", async () => {
    const req = createMockReqWithBody("POST", {
      description: "Body",
      status: "Review",
      type: "Feature",
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/title/);
  });

  it("400 on invalid status (In Progress not allowed on create)", async () => {
    const req = createMockReqWithBody("POST", {
      title: "x",
      description: "y",
      status: "In Progress",
      type: "Feature",
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(400);
  });

  it("400 on invalid type", async () => {
    const req = createMockReqWithBody("POST", {
      title: "x",
      description: "y",
      status: "ToDo",
      type: "NotAType",
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    const http = await import("http");
    const req = new http.IncomingMessage(null as never);
    req.method = "POST";
    req.headers = { authorization: "Bearer user-alice" };
    process.nextTick(() => {
      req.emit("data", Buffer.from("not-json{"));
      req.emit("end");
    });
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Invalid JSON body" });
  });

  it("500 when createIssue throws a non-IssuePatchError (missing config)", async () => {
    // Remove the config dir so loadIssuePrefix throws.
    rmSync(resolve(repoLocalPath, ".danxbot/config"), {
      recursive: true,
      force: true,
    });
    const req = createMockReqWithBody("POST", {
      title: "x",
      description: "y",
      status: "ToDo",
      type: "Feature",
    });
    req.headers = { authorization: "Bearer user-alice" };
    const res = createMockRes();
    await handlePostIssue(req, res, "danxbot", makeDeps());
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/issue_prefix|config\.yml/);
  });
});

describe("deleteIssue — soft-delete via <repo>/.danxbot/trash/", () => {
  function trashPath(id: string): string {
    return resolve(repoLocalPath, ".danxbot", "trash", `${id}.yml`);
  }

  it("moves the YAML out of open/ into <repoLocalPath>/.danxbot/trash/<id>.yml", async () => {
    const source = writeFixture(makeIssue(), "open");
    expect(existsSync(source)).toBe(true);

    const result = await deleteIssue("danxbot", repoLocalPath, "DX-1", false);

    expect(result.removed).toEqual(["DX-1"]);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(trashPath("DX-1"))).toBe(true);
  });

  it("moveAcrossDevices falls back to copy+unlink when rename raises EXDEV", () => {
    const source = resolve(tmpRoot, "exdev-src.yml");
    const dest = resolve(tmpRoot, "exdev-dest.yml");
    writeFileSync(source, "payload: hello\n");

    let attempted = false;
    moveAcrossDevices(source, dest, () => {
      attempted = true;
      const err = new Error(
        "EXDEV: cross-device link not permitted, rename",
      ) as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    });

    expect(attempted).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("payload: hello\n");
  });

  it("moveAcrossDevices propagates non-EXDEV errors verbatim", () => {
    const source = resolve(tmpRoot, "eacces-src.yml");
    const dest = resolve(tmpRoot, "eacces-dest.yml");
    writeFileSync(source, "x: 1\n");
    expect(() =>
      moveAcrossDevices(source, dest, () => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }),
    ).toThrowError(/EACCES/);
    // Source still present — fallback was NOT engaged.
    expect(existsSync(source)).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });

  it("returns 404 IssuePatchError when the id has no YAML on disk", async () => {
    await expect(
      deleteIssue("danxbot", repoLocalPath, "DX-9", false),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("publishes one removed:true SSE event per deleted card", async () => {
    writeFixture(makeIssue(), "open");
    mockEventBusPublish.mockClear();
    await deleteIssue("danxbot", repoLocalPath, "DX-1", false);
    expect(mockEventBusPublish).toHaveBeenCalledWith({
      topic: "issue:updated",
      data: { repoName: "danxbot", id: "DX-1", removed: true },
    });
  });

  it("cascade=true walks children[] recursively and trashes every descendant", async () => {
    // Epic DX-1 with phase children DX-2 + DX-3; DX-2 has a sub-child DX-4.
    writeFixture(
      makeIssue({ id: "DX-1", type: "Epic", children: ["DX-2", "DX-3"] }),
      "open",
    );
    writeFixture(
      makeIssue({ id: "DX-2", parent_id: "DX-1", children: ["DX-4"] }),
      "open",
    );
    writeFixture(makeIssue({ id: "DX-3", parent_id: "DX-1" }), "open");
    writeFixture(makeIssue({ id: "DX-4", parent_id: "DX-2" }), "open");

    const result = await deleteIssue("danxbot", repoLocalPath, "DX-1", true);

    expect(new Set(result.removed)).toEqual(
      new Set(["DX-1", "DX-2", "DX-3", "DX-4"]),
    );
    for (const id of ["DX-1", "DX-2", "DX-3", "DX-4"]) {
      expect(existsSync(issuePath(repoLocalPath, id, "open"))).toBe(false);
      expect(existsSync(trashPath(id))).toBe(true);
    }
  });

  it("cascade=false leaves descendants in place when the root has children", async () => {
    writeFixture(
      makeIssue({ id: "DX-1", type: "Epic", children: ["DX-2"] }),
      "open",
    );
    writeFixture(makeIssue({ id: "DX-2", parent_id: "DX-1" }), "open");

    await deleteIssue("danxbot", repoLocalPath, "DX-1", false);

    expect(existsSync(issuePath(repoLocalPath, "DX-1", "open"))).toBe(false);
    expect(existsSync(issuePath(repoLocalPath, "DX-2", "open"))).toBe(true);
    expect(existsSync(trashPath("DX-2"))).toBe(false);
  });

  it("appends a timestamp suffix when the trash dir already holds a YAML for the same id (recreate → re-delete cycle)", async () => {
    writeFixture(makeIssue(), "open");
    await deleteIssue("danxbot", repoLocalPath, "DX-1", false);
    expect(existsSync(trashPath("DX-1"))).toBe(true);

    // Recreate + re-delete — second pass must NOT clobber the first.
    writeFixture(makeIssue({ title: "second" }), "open");
    await deleteIssue("danxbot", repoLocalPath, "DX-1", false);

    expect(existsSync(trashPath("DX-1"))).toBe(true);
    const trashDir = resolve(repoLocalPath, ".danxbot", "trash");
    const entries = readdirSync(trashDir);
    const suffixed = entries.filter((n) => n.startsWith("DX-1.yml."));
    expect(suffixed.length).toBe(1);
  });
});
