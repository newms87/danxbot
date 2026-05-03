import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryTracker } from "../issue-tracker/memory.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import {
  ensureGitignoreEntry,
  ensureIssuesDirs,
  findByExternalId,
  hydrateFromRemote,
  issuePath,
  loadLocal,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import type { CreateCardInput } from "../issue-tracker/interface.js";

function defaultCreate(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    schema_version: 2,
    tracker: "memory",
    id: "ISS-1",
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
    it("returns absolute path under .danxbot/issues/<state>/<id>.yml", () => {
      const path = issuePath(repoRoot, "ISS-7", "open");
      expect(path).toBe(resolve(repoRoot, ".danxbot/issues/open/ISS-7.yml"));
    });

    it("returns closed path when state is closed", () => {
      const path = issuePath(repoRoot, "ISS-7", "closed");
      expect(path).toBe(resolve(repoRoot, ".danxbot/issues/closed/ISS-7.yml"));
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
    it("calls tracker.getCard + tracker.getComments and writes valid YAML with stamped dispatch_id", async () => {
      const tracker = new MemoryTracker();
      // Seed a memory card carrying an internal id (the memory tracker
      // round-trips it; getCard returns it as `Issue.id` so hydrate
      // doesn't have to allocate a new ISS-N).
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-77" }),
      );
      tracker.clearRequestLog();

      const dispatchId = "dispatch-uuid-abc";
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        dispatchId,
        repoRoot,
      );

      expect(issue.id).toBe("ISS-77");
      expect(issue.external_id).toBe(external_id);
      expect(issue.dispatch_id).toBe(dispatchId);
      expect(issue.title).toBe("Card title");

      const methods = tracker.getRequestLog().map((l) => l.method).sort();
      expect(methods).toEqual(["getCard", "getComments"]);
    });

    it("allocates a new ISS-N when the remote card has no id (legacy / human-created)", async () => {
      const tracker = new MemoryTracker();
      // Memory tracker preserves whatever id we seed — empty here means
      // the equivalent of "remote card created without a `#ISS-N: ` prefix".
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "" }),
      );

      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
      );
      expect(issue.id).toMatch(/^ISS-\d+$/);
    });

    it("includes remote comments in the hydrated Issue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-3" }),
      );
      await tracker.addComment(external_id, "first comment");
      await tracker.addComment(external_id, "second comment");

      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
      );
      expect(issue.comments).toHaveLength(2);
      expect(issue.comments[0].text).toContain("first comment");
      expect(issue.comments[1].text).toContain("second comment");
      expect(issue.comments[0].id).toBeDefined();
    });
  });

  describe("loadLocal", () => {
    it("returns null when no file exists in open/ or closed/", () => {
      ensureIssuesDirs(repoRoot);
      expect(loadLocal(repoRoot, "ISS-9999")).toBeNull();
    });

    it("returns the parsed Issue from open/ when present", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-10" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
      );
      writeIssue(repoRoot, issue);

      const loaded = loadLocal(repoRoot, "ISS-10");
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe("ISS-10");
      expect(loaded?.external_id).toBe(external_id);
      expect(loaded?.dispatch_id).toBe("did-1");
    });

    it("returns the parsed Issue from closed/ when present and absent from open/", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-11" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
      );
      ensureIssuesDirs(repoRoot);
      writeFileSync(
        issuePath(repoRoot, "ISS-11", "closed"),
        serializeIssue(issue),
      );

      const loaded = loadLocal(repoRoot, "ISS-11");
      expect(loaded?.id).toBe("ISS-11");
    });

    it("throws on corrupt YAML", () => {
      ensureIssuesDirs(repoRoot);
      writeFileSync(
        issuePath(repoRoot, "ISS-99", "open"),
        "not: valid: yaml: at: all\n  - broken",
      );
      expect(() => loadLocal(repoRoot, "ISS-99")).toThrow();
    });
  });

  describe("findByExternalId", () => {
    it("returns the issue whose external_id matches by scanning open + closed", async () => {
      const tracker = new MemoryTracker();
      const { external_id: ext } = await tracker.createCard(
        defaultCreate({ id: "ISS-50" }),
      );
      const issue = await hydrateFromRemote(tracker, ext, "did-1", repoRoot);
      writeIssue(repoRoot, issue);

      const found = findByExternalId(repoRoot, ext);
      expect(found?.id).toBe("ISS-50");
    });

    it("returns null when no YAML carries the external_id", () => {
      ensureIssuesDirs(repoRoot);
      expect(findByExternalId(repoRoot, "ghost-card")).toBeNull();
    });
  });

  describe("writeIssue", () => {
    it("serializes and writes to open/<id>.yml; round-trips through parseIssue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-12" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
      );

      writeIssue(repoRoot, issue);

      const path = issuePath(repoRoot, "ISS-12", "open");
      expect(existsSync(path)).toBe(true);
      const roundTripped = parseIssue(readFileSync(path, "utf-8"));
      expect(roundTripped.id).toBe("ISS-12");
      expect(roundTripped.external_id).toBe(external_id);
      expect(roundTripped.dispatch_id).toBe("did-1");
    });
  });

  describe("stampDispatchAndWrite", () => {
    it("overwrites dispatch_id and writes back, returning the updated Issue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-13" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
      );
      writeIssue(repoRoot, original);

      const updated = stampDispatchAndWrite(repoRoot, original, "did-2");
      expect(updated.dispatch_id).toBe("did-2");

      const reloaded = loadLocal(repoRoot, "ISS-13");
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
