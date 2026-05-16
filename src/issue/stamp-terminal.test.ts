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
      }),
    ).resolves.toBeUndefined();
    expect(
      existsSync(join(root, ".danxbot/issues/open/DX-99.yml")),
    ).toBe(false);
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
