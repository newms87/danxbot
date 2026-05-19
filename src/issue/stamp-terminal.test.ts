/**
 * DX-584 (Phase 4 of DX-575 — Computed card state) — tests for the
 * `stampIssueCompleted` / `stampIssueCancelled` worker-driven terminal
 * stamping helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  stampIssueCancelled,
  stampIssueCompleted,
} from "./stamp-terminal.js";
import { createEmptyIssue, parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue } from "../issue-tracker/interface.js";
import { setWriteIssueReconcileHook } from "../poller/yaml-lifecycle.js";

describe("stampIssueCompleted / stampIssueCancelled", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "stamp-terminal-"));
    mkdirSync(join(root, ".danxbot/issues/open"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(id: string, overrides: Partial<Issue> = {}): void {
    const base = createEmptyIssue({
      id,
      status: "In Progress",
      title: `${id} title`,
      description: "fixture",
    });
    const issue: Issue = {
      ...base,
      ready_at: "2026-05-14T00:00:00.000Z",
      ...overrides,
    };
    writeFileSync(
      join(root, ".danxbot/issues/open", `${id}.yml`),
      serializeIssue(issue),
    );
  }

  function readRaw(id: string): Record<string, unknown> {
    // Bypass parseIssue's `deriveStatus` projection — we want to inspect
    // the literal on-disk fields the writer produced.
    const text = readFileSync(
      join(root, ".danxbot/issues/open", `${id}.yml`),
      "utf-8",
    );
    return JSON.parse(JSON.stringify(parseIssue(text, { expectedPrefix: "DX" })));
  }

  it("stampIssueCompleted writes completed_at + list_name='Done' + dispatch=null", async () => {
    seed("DX-1", {
      dispatch: {
        id: "did-1",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      },
    });

    await stampIssueCompleted({
      repoLocalPath: root,
      candidateId: "DX-1",
      expectedPrefix: "DX",
      at: "2026-05-14T12:00:00.000Z",
      dispatchId: "dispatch-1",
    });

    const raw = readRaw("DX-1");
    expect(raw.completed_at).toBe("2026-05-14T12:00:00.000Z");
    expect(raw.cancelled_at).toBeNull();
    expect(raw.list_name).toBe("Done");
    expect(raw.dispatch).toBeNull();
    // ready_at preserved across the terminal save.
    expect(raw.ready_at).toBe("2026-05-14T00:00:00.000Z");
  });

  it("stampIssueCancelled writes cancelled_at + list_name='Cancelled' + dispatch=null", async () => {
    seed("DX-2", {
      dispatch: {
        id: "did-2",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      },
    });

    await stampIssueCancelled({
      repoLocalPath: root,
      candidateId: "DX-2",
      expectedPrefix: "DX",
      at: "2026-05-14T13:00:00.000Z",
      dispatchId: "dispatch-2",
    });

    const raw = readRaw("DX-2");
    expect(raw.cancelled_at).toBe("2026-05-14T13:00:00.000Z");
    expect(raw.completed_at).toBeNull();
    expect(raw.list_name).toBe("Cancelled");
    expect(raw.dispatch).toBeNull();
    expect(raw.ready_at).toBe("2026-05-14T00:00:00.000Z");
  });

  it("is idempotent — pre-existing completed_at is preserved across duplicate signals", async () => {
    seed("DX-3", { completed_at: "2026-05-14T10:00:00.000Z" });

    await stampIssueCompleted({
      repoLocalPath: root,
      candidateId: "DX-3",
      expectedPrefix: "DX",
      at: "2026-05-14T11:00:00.000Z", // later signal
      dispatchId: "dispatch-3",
    });

    const raw = readRaw("DX-3");
    // Earlier timestamp survives — duplicate signals do not slide it.
    expect(raw.completed_at).toBe("2026-05-14T10:00:00.000Z");
  });

  it("no-op when YAML is missing from both open/ AND closed/", async () => {
    await expect(
      stampIssueCompleted({
        repoLocalPath: root,
        candidateId: "DX-99",
        expectedPrefix: "DX",
        at: "2026-05-14T12:00:00.000Z",
        dispatchId: "dispatch-99",
      }),
    ).resolves.toBeUndefined();
    expect(
      existsSync(join(root, ".danxbot/issues/open/DX-99.yml")),
    ).toBe(false);
  });

  describe("DX-703 — parent reconcile co-fire on terminal stamp", () => {
    afterEach(() => {
      setWriteIssueReconcileHook(null);
    });

    it("stampIssueCompleted enqueues reconcileIssue(parent_id, 'lifecycle') for an open-bucket child", async () => {
      const calls: Array<{ id: string; trigger: string }> = [];
      setWriteIssueReconcileHook(async (_repoLocalPath, id, trigger) => {
        calls.push({ id, trigger });
      });

      seed("DX-5", { parent_id: "DX-50" });
      await stampIssueCompleted({
        repoLocalPath: root,
        candidateId: "DX-5",
        expectedPrefix: "DX",
        at: "2026-05-14T12:00:00.000Z",
        dispatchId: "dispatch-5",
      });

      // First call comes from writeIssue's own reconcileAfter chain (if
      // invoked) — but in this test only the explicit co-fire is wired.
      // The parent id MUST appear in the calls list.
      const parentCalls = calls.filter((c) => c.id === "DX-50");
      expect(parentCalls.length).toBeGreaterThan(0);
      expect(parentCalls[0].trigger).toBe("lifecycle");
    });

    it("stampIssueCancelled enqueues reconcileIssue(parent_id, 'lifecycle')", async () => {
      const calls: Array<{ id: string; trigger: string }> = [];
      setWriteIssueReconcileHook(async (_repoLocalPath, id, trigger) => {
        calls.push({ id, trigger });
      });

      seed("DX-6", { parent_id: "DX-60" });
      await stampIssueCancelled({
        repoLocalPath: root,
        candidateId: "DX-6",
        expectedPrefix: "DX",
        at: "2026-05-14T12:00:00.000Z",
        dispatchId: "dispatch-6",
      });

      const parentCalls = calls.filter((c) => c.id === "DX-60");
      expect(parentCalls.length).toBeGreaterThan(0);
    });

    it("no parent_id on child → no co-fire", async () => {
      const calls: Array<{ id: string; trigger: string }> = [];
      setWriteIssueReconcileHook(async (_repoLocalPath, id, trigger) => {
        calls.push({ id, trigger });
      });

      seed("DX-7", { parent_id: null });
      await stampIssueCompleted({
        repoLocalPath: root,
        candidateId: "DX-7",
        expectedPrefix: "DX",
        at: "2026-05-14T12:00:00.000Z",
        dispatchId: "dispatch-7",
      });

      // The writeIssue path itself does NOT pass reconcileAfter: true
      // for stamp-terminal's call, so no spurious self-fires either.
      expect(calls.filter((c) => c.id === "DX-7")).toHaveLength(0);
    });

    it("co-fire reconcile rejection does NOT propagate out of stampIssueCompleted (handleStop robustness)", async () => {
      // A parent reconcile that throws mid-stop-handler MUST NOT
      // corrupt the terminal child stamp. The child YAML must still
      // carry completed_at + dispatch:null after stamp returns, AND
      // stamp must resolve normally — throwing here would poison the
      // worker's handleStop path + trigger an unwarranted strike.
      setWriteIssueReconcileHook(async () => {
        throw new Error("reconcile blew up");
      });

      seed("DX-9", { parent_id: "DX-99" });
      // Resolves cleanly despite hook throw.
      await expect(
        stampIssueCompleted({
          repoLocalPath: root,
          candidateId: "DX-9",
          expectedPrefix: "DX",
          at: "2026-05-14T12:00:00.000Z",
          dispatchId: "dispatch-9",
        }),
      ).resolves.toBeUndefined();
      const raw = readRaw("DX-9");
      expect(raw.completed_at).toBe("2026-05-14T12:00:00.000Z");
      expect(raw.dispatch).toBeNull();
    });

    it("closed-bucket stamp (agent's Edit moved the file first) also enqueues parent reconcile", async () => {
      const calls: Array<{ id: string; trigger: string }> = [];
      setWriteIssueReconcileHook(async (_repoLocalPath, id, trigger) => {
        calls.push({ id, trigger });
      });

      // Seed the file in closed/ to mirror the production race.
      mkdirSync(join(root, ".danxbot/issues/closed"), { recursive: true });
      const closedPath = join(root, ".danxbot/issues/closed/DX-8.yml");
      const base = createEmptyIssue({
        id: "DX-8",
        status: "Done",
        title: "DX-8 title",
        description: "fixture",
      });
      writeFileSync(
        closedPath,
        serializeIssue({
          ...base,
          parent_id: "DX-80",
          ready_at: "2026-05-14T00:00:00.000Z",
        } as Issue),
      );

      await stampIssueCompleted({
        repoLocalPath: root,
        candidateId: "DX-8",
        expectedPrefix: "DX",
        at: "2026-05-14T12:00:00.000Z",
        dispatchId: "dispatch-8",
      });

      const parentCalls = calls.filter((c) => c.id === "DX-80");
      expect(parentCalls.length).toBeGreaterThan(0);
    });
  });

  it("stamps the closed/ copy when the agent's prior status:Done write already moved the file", async () => {
    // Mirror the production race: agent writes status:Done; chokidar
    // fires reconcile which moves the file to closed/ before
    // handleStop reaches `maybeStampTerminalYaml`. The stamp must
    // land on the closed file, not re-create an open copy.
    mkdirSync(join(root, ".danxbot/issues/closed"), { recursive: true });
    const closedPath = join(root, ".danxbot/issues/closed/DX-4.yml");
    const base = createEmptyIssue({
      id: "DX-4",
      status: "Done",
      title: "DX-4 title",
      description: "fixture",
    });
    writeFileSync(
      closedPath,
      serializeIssue({
        ...base,
        ready_at: "2026-05-14T00:00:00.000Z",
        dispatch: {
          id: "did-4",
          pid: 0,
          host: "",
          kind: "work",
          started_at: "",
          ttl_seconds: 0,
        },
      } as Issue),
    );

    await stampIssueCompleted({
      repoLocalPath: root,
      candidateId: "DX-4",
      expectedPrefix: "DX",
      at: "2026-05-14T13:00:00.000Z",
      dispatchId: "dispatch-4",
    });

    // No open/ copy resurrected — the file move is not reverted.
    expect(
      existsSync(join(root, ".danxbot/issues/open/DX-4.yml")),
    ).toBe(false);
    // Closed file carries the stamped fields.
    const parsed = parseIssue(readFileSync(closedPath, "utf-8"), {
      expectedPrefix: "DX",
    });
    expect(parsed.completed_at).toBe("2026-05-14T13:00:00.000Z");
    expect(parsed.list_name).toBe("Done");
    expect(parsed.dispatch).toBeNull();
    expect(parsed.ready_at).toBe("2026-05-14T00:00:00.000Z");
  });
});
