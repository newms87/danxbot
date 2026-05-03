import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryTracker } from "../issue-tracker/memory.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import {
  ensureGitignoreEntry,
  ensureIssuesDirs,
  hydrateFromRemote,
  issuePath,
  loadLocal,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import type { CreateCardInput, Issue } from "../issue-tracker/interface.js";

function defaultCreate(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    schema_version: 1,
    tracker: "memory",
    parent_id: null,
    status: "ToDo",
    type: "Feature",
    title: "Card title",
    description: "Card description",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [{ title: "AC1", checked: false }],
    phases: [],
    comments: [],
    retro: { good: "", bad: "", action_items: [], commits: [] },
    ...overrides,
  };
}

describe("yaml-lifecycle", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-yaml-lifecycle-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  describe("issuePath", () => {
    it("returns absolute path under .danxbot/issues/<state>/<external_id>.yml", () => {
      const path = issuePath(repoRoot, "abc-123", "open");
      expect(path).toBe(resolve(repoRoot, ".danxbot/issues/open/abc-123.yml"));
    });

    it("returns closed path when state is closed", () => {
      const path = issuePath(repoRoot, "abc-123", "closed");
      expect(path).toBe(resolve(repoRoot, ".danxbot/issues/closed/abc-123.yml"));
    });
  });

  describe("ensureIssuesDirs", () => {
    it("creates open/ and closed/ dirs idempotently", () => {
      ensureIssuesDirs(repoRoot);
      expect(existsSync(resolve(repoRoot, ".danxbot/issues/open"))).toBe(true);
      expect(existsSync(resolve(repoRoot, ".danxbot/issues/closed"))).toBe(true);

      // Second call must not throw.
      ensureIssuesDirs(repoRoot);
      expect(existsSync(resolve(repoRoot, ".danxbot/issues/open"))).toBe(true);
    });
  });

  describe("hydrateFromRemote", () => {
    it("calls tracker.getCard + tracker.getComments exactly once each and writes valid YAML with stamped dispatch_id", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      tracker.clearRequestLog();

      const dispatchId = "dispatch-uuid-abc";
      const issue = await hydrateFromRemote(tracker, external_id, dispatchId);

      expect(issue.external_id).toBe(external_id);
      expect(issue.dispatch_id).toBe(dispatchId);
      expect(issue.title).toBe("Card title");

      const methods = tracker.getRequestLog().map((l) => l.method).sort();
      expect(methods).toEqual(["getCard", "getComments"]);
    });

    it("includes remote comments in the hydrated Issue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      await tracker.addComment(external_id, "first comment");
      await tracker.addComment(external_id, "second comment");

      const issue = await hydrateFromRemote(tracker, external_id, "did-1");
      expect(issue.comments).toHaveLength(2);
      expect(issue.comments[0].text).toContain("first comment");
      expect(issue.comments[1].text).toContain("second comment");
      expect(issue.comments[0].id).toBeDefined();
    });
  });

  describe("loadLocal", () => {
    it("returns null when no file exists in open/ or closed/", () => {
      ensureIssuesDirs(repoRoot);
      expect(loadLocal(repoRoot, "missing-id")).toBeNull();
    });

    it("returns the parsed Issue from open/ when present", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const issue = await hydrateFromRemote(tracker, external_id, "did-1");
      writeIssue(repoRoot, issue);

      const loaded = loadLocal(repoRoot, external_id);
      expect(loaded).not.toBeNull();
      expect(loaded?.external_id).toBe(external_id);
      expect(loaded?.dispatch_id).toBe("did-1");
    });

    it("returns the parsed Issue from closed/ when present and absent from open/", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const issue = await hydrateFromRemote(tracker, external_id, "did-1");
      ensureIssuesDirs(repoRoot);
      writeFileSync(
        issuePath(repoRoot, external_id, "closed"),
        serializeIssue(issue),
      );

      const loaded = loadLocal(repoRoot, external_id);
      expect(loaded?.external_id).toBe(external_id);
    });

    it("throws on corrupt YAML", () => {
      ensureIssuesDirs(repoRoot);
      writeFileSync(issuePath(repoRoot, "bad-id", "open"), "not: valid: yaml: at: all\n  - broken");
      expect(() => loadLocal(repoRoot, "bad-id")).toThrow();
    });
  });

  describe("writeIssue", () => {
    it("serializes and writes to open/<external_id>.yml; round-trips through parseIssue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const issue = await hydrateFromRemote(tracker, external_id, "did-1");

      writeIssue(repoRoot, issue);

      const path = issuePath(repoRoot, external_id, "open");
      expect(existsSync(path)).toBe(true);
      const roundTripped = parseIssue(readFileSync(path, "utf-8"));
      expect(roundTripped.external_id).toBe(external_id);
      expect(roundTripped.dispatch_id).toBe("did-1");
    });
  });

  describe("stampDispatchAndWrite", () => {
    it("overwrites dispatch_id and writes back, returning the updated Issue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const original = await hydrateFromRemote(tracker, external_id, "did-1");
      writeIssue(repoRoot, original);

      const updated = stampDispatchAndWrite(repoRoot, original, "did-2");
      expect(updated.dispatch_id).toBe("did-2");

      const reloaded = loadLocal(repoRoot, external_id);
      expect(reloaded?.dispatch_id).toBe("did-2");
    });
  });

  describe("ensureGitignoreEntry", () => {
    it("creates the gitignore with the line when file does not exist", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "utf-8");
      expect(content.split("\n")).toContain("issues/");
    });

    it("appends the line if missing, preserving existing entries", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      writeFileSync(
        resolve(repoRoot, ".danxbot/.gitignore"),
        "features.md\n.env\nsettings.json\n",
      );
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "utf-8");
      const lines = content.split("\n");
      expect(lines).toContain("features.md");
      expect(lines).toContain(".env");
      expect(lines).toContain("settings.json");
      expect(lines).toContain("issues/");
    });

    it("is idempotent — calling twice does not duplicate the line", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      writeFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "features.md\n");
      ensureGitignoreEntry(repoRoot, "issues/");
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "utf-8");
      const occurrences = content.split("\n").filter((l) => l === "issues/");
      expect(occurrences).toHaveLength(1);
    });

    it("does not match a partial line containing the entry as a substring", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      writeFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "old-issues/\n");
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "utf-8");
      const lines = content.split("\n");
      expect(lines).toContain("old-issues/");
      expect(lines).toContain("issues/");
    });
  });
});
