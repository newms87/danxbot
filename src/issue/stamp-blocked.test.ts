import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stampIssueBlocked } from "./stamp-blocked.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import { createEmptyIssue } from "../issue-tracker/yaml.js";

describe("stampIssueBlocked", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "stamp-blocked-"));
    mkdirSync(join(root, ".danxbot/issues/open"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeFixture(id: string, status: "ToDo" | "In Progress" = "ToDo"): void {
    const issue = {
      ...createEmptyIssue({
        id,
        status,
        title: `${id} title`,
        description: "fixture",
      }),
    };
    writeFileSync(
      join(root, ".danxbot/issues/open", `${id}.yml`),
      serializeIssue(issue),
    );
  }

  it("stamps blocked.reason + blocked.at on the candidate YAML (DX-658: status untouched)", async () => {
    writeFixture("DX-1");
    const ts = "2026-05-14T00:00:00.000Z";
    await stampIssueBlocked({
      repoLocalPath: root,
      candidateId: "DX-1",
      expectedPrefix: "DX",
      reason: "agent cannot proceed",
      at: ts,
    });

    const parsed = parseIssue(
      readFileSync(join(root, ".danxbot/issues/open/DX-1.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    // DX-658: status is NOT touched by stamp — only the gate field changes.
    expect(parsed.status).toBe("ToDo");
    expect(parsed.blocked).toEqual({
      reason: "agent cannot proceed",
      at: ts,
    });
  });

  it("is idempotent — second stamp overwrites timestamp but leaves status + reason at the new values", async () => {
    writeFixture("DX-1");
    await stampIssueBlocked({
      repoLocalPath: root,
      candidateId: "DX-1",
      expectedPrefix: "DX",
      reason: "first reason",
      at: "2026-05-14T00:00:00.000Z",
    });
    await stampIssueBlocked({
      repoLocalPath: root,
      candidateId: "DX-1",
      expectedPrefix: "DX",
      reason: "second reason",
      at: "2026-05-14T01:00:00.000Z",
    });
    const parsed = parseIssue(
      readFileSync(join(root, ".danxbot/issues/open/DX-1.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(parsed.status).toBe("ToDo");
    expect(parsed.blocked?.reason).toBe("second reason");
    expect(parsed.blocked?.at).toBe("2026-05-14T01:00:00.000Z");
  });

  it("throws when the candidate YAML does not exist", async () => {
    await expect(
      stampIssueBlocked({
        repoLocalPath: root,
        candidateId: "DX-999",
        expectedPrefix: "DX",
        reason: "not gonna land",
        at: "2026-05-14T00:00:00.000Z",
      }),
    ).rejects.toThrow(/candidate YAML not found/);
  });

  it("DX-658: preserves ready_at, list_name, and dispatch byte-identical (gate-only write)", async () => {
    writeFixture("DX-3", "In Progress");
    // Seed ready_at + a live dispatch block before stamping blocked —
    // mirrors a card mid-dispatch when the agent self-blocks.
    const yamlPath = join(root, ".danxbot/issues/open/DX-3.yml");
    const seeded = parseIssue(readFileSync(yamlPath, "utf-8"), {
      expectedPrefix: "DX",
    });
    seeded.ready_at = "2026-05-14T00:00:00.000Z";
    seeded.dispatch = {
      id: "dispatch-3",
      pid: 4242,
      host: "host-a",
      kind: "work",
      started_at: "2026-05-14T00:00:01.000Z",
      ttl_seconds: 7200,
    };
    const preStampListName = seeded.list_name;
    writeFileSync(yamlPath, serializeIssue(seeded));

    await stampIssueBlocked({
      repoLocalPath: root,
      candidateId: "DX-3",
      expectedPrefix: "DX",
      reason: "agent self-block",
      at: "2026-05-14T12:00:00.000Z",
    });

    const parsed = parseIssue(readFileSync(yamlPath, "utf-8"), {
      expectedPrefix: "DX",
    });
    // DX-658 — the stamp is a pure gate write. status, list_name,
    // dispatch, and ready_at are byte-identical to pre-stamp values.
    expect(parsed.status).toBe("In Progress");
    expect(parsed.ready_at).toBe("2026-05-14T00:00:00.000Z");
    expect(parsed.list_name).toBe(preStampListName);
    expect(parsed.dispatch).toEqual(seeded.dispatch);
  });

  it("preserves an existing waiting_on record (independent of status)", async () => {
    writeFixture("DX-2");
    // Seed a waiting_on record on the YAML before stamping blocked.
    const yamlPath = join(root, ".danxbot/issues/open/DX-2.yml");
    const seeded = parseIssue(readFileSync(yamlPath, "utf-8"), {
      expectedPrefix: "DX",
    });
    seeded.waiting_on = {
      reason: "dep chain",
      timestamp: "2026-05-13T00:00:00.000Z",
      by: ["DX-99"],
    };
    writeFileSync(yamlPath, serializeIssue(seeded));

    await stampIssueBlocked({
      repoLocalPath: root,
      candidateId: "DX-2",
      expectedPrefix: "DX",
      reason: "agent self-block",
      at: "2026-05-14T00:00:00.000Z",
    });

    const parsed = parseIssue(readFileSync(yamlPath, "utf-8"), {
      expectedPrefix: "DX",
    });
    expect(parsed.status).toBe("ToDo");
    expect(parsed.waiting_on).toEqual({
      reason: "dep chain",
      timestamp: "2026-05-13T00:00:00.000Z",
      by: ["DX-99"],
    });
  });
});
