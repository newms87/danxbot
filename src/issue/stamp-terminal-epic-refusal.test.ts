/**
 * DX-654 — write-side guard. `stampIssueCompleted` / `stampIssueCancelled`
 * MUST refuse to mutate a candidate YAML when `issue.type === "Epic"`,
 * surface a `recordSystemError` event with `source:
 * "stamp-terminal-epic-refused"`, and leave the rest of the dispatch
 * teardown unaffected (caller treats it as a no-op stamp).
 *
 * Companion test to `stamp-terminal.test.ts` — the regression-guard
 * Feature path lives there; this file owns the new refusal path so the
 * guard's intent stays self-contained.
 *
 * Note on path: AC names `src/issue/__tests__/stamp-terminal-epic-refusal.test.ts`
 * but the project's existing test convention is sibling `*.test.ts`
 * files; following project convention here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  stampIssueCancelled,
  stampIssueCompleted,
} from "./stamp-terminal.js";
import {
  _clearSystemErrors,
  listSystemErrors,
} from "../dashboard/system-errors.js";
import {
  createEmptyIssue,
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import type { Issue } from "../issue-tracker/interface.js";

describe("stamp-terminal — epic refusal guard (DX-654)", () => {
  let root: string;
  let repoName: string;

  beforeEach(() => {
    _clearSystemErrors();
    root = mkdtempSync(resolve(tmpdir(), "stamp-terminal-epic-"));
    repoName = basename(root);
    mkdirSync(join(root, ".danxbot/issues/open"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _clearSystemErrors();
  });

  function seed(id: string, overrides: Partial<Issue> = {}): void {
    const base = createEmptyIssue({
      id,
      status: "In Progress",
      type: "Epic",
      title: `${id} title`,
      description: "fixture epic",
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
    const text = readFileSync(
      join(root, ".danxbot/issues/open", `${id}.yml`),
      "utf-8",
    );
    return JSON.parse(JSON.stringify(parseIssue(text, { expectedPrefix: "DX" })));
  }

  it("stampIssueCompleted on type:Epic — completed_at stays null + system error fired", async () => {
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
      dispatchId: "dispatch-epic-1",
    });

    // YAML untouched — no completed_at, dispatch block preserved.
    const raw = readRaw("DX-1");
    expect(raw.completed_at).toBeNull();
    expect(raw.cancelled_at).toBeNull();
    expect(raw.dispatch).toMatchObject({ id: "did-1" });

    // System error surfaced.
    const errors = listSystemErrors({ repo: repoName });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      source: "stamp-terminal-epic-refused",
      severity: "warn",
      repo: repoName,
    });
    expect(errors[0].message).toContain("DX-1");
    expect(errors[0].message).toContain("dispatch-epic-1");
    expect(errors[0].details).toMatchObject({
      candidateId: "DX-1",
      dispatchId: "dispatch-epic-1",
      attemptedTerminalKind: "Done",
    });
  });

  it("stampIssueCancelled on type:Epic — cancelled_at stays null + system error fired", async () => {
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
      dispatchId: "dispatch-epic-2",
    });

    const raw = readRaw("DX-2");
    expect(raw.cancelled_at).toBeNull();
    expect(raw.completed_at).toBeNull();
    expect(raw.dispatch).toMatchObject({ id: "did-2" });

    const errors = listSystemErrors({ repo: repoName });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      source: "stamp-terminal-epic-refused",
      severity: "warn",
    });
    expect(errors[0].details).toMatchObject({
      attemptedTerminalKind: "Cancelled",
    });
  });

  it("Feature candidate is stamped normally (regression guard — guard fires only on Epic)", async () => {
    const base = createEmptyIssue({
      id: "DX-3",
      status: "In Progress",
      type: "Feature",
      title: "DX-3 title",
      description: "fixture feature",
    });
    writeFileSync(
      join(root, ".danxbot/issues/open/DX-3.yml"),
      serializeIssue({
        ...base,
        ready_at: "2026-05-14T00:00:00.000Z",
        dispatch: {
          id: "did-3",
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
      candidateId: "DX-3",
      expectedPrefix: "DX",
      at: "2026-05-14T14:00:00.000Z",
      dispatchId: "dispatch-feature-3",
    });

    const raw = readRaw("DX-3");
    expect(raw.completed_at).toBe("2026-05-14T14:00:00.000Z");
    expect(raw.dispatch).toBeNull();
    expect(listSystemErrors({ repo: repoName })).toHaveLength(0);
  });
});
