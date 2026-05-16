/**
 * DX-226 Phase 1 — chokidar-backed `issue:updated` SSE feed.
 *
 * The watcher's job: notice every YAML state change under
 * `<repo>/.danxbot/issues/{open,closed}/*.yml` and publish an
 * `issue:updated` event via the in-process EventBus. The dashboard SPA's
 * `useIssues` composable subscribes through the SSE stream, so the
 * `<1s edit-to-UI` goal hinges on this module's debounce + publish
 * timing.
 *
 * Tests drive the watcher via the injected `disableWatcher: true` mode +
 * `simulate(...)` helper — chokidar itself is not constructed in unit
 * tests because it taps into the host's inotify which produces flaky
 * timing under vitest's default 5s budget (DX-223 burned us last quarter
 * on the issues-mirror integration suite when chokidar's awaitWriteFinish
 * race fired exactly at the test boundary).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eventBus, type BusEvent } from "./event-bus.js";
import { startIssuesWatcher } from "./issues-watcher.js";
import { serializeIssue } from "../issue-tracker/yaml.js";
import { writeFileSync as fsWriteSync, mkdirSync as fsMkdirSync } from "node:fs";

interface IssueOverrides {
  id?: string;
  title?: string;
  status?: string;
}

function buildIssueYaml(overrides: IssueOverrides = {}): string {
  const id = overrides.id ?? "DX-1";
  // Use serializeIssue so the YAML round-trips through the validator the
  // watcher invokes — keeps the fixture byte-identical to production
  // writes.
  return serializeIssue({
    schema_version: 10,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: (overrides.status as "ToDo" | "Done") ?? "ToDo",
    type: "Feature",
    title: overrides.title ?? `Card ${id}`,
    description: "",
    priority: 3,
    position: null,
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
    history: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    assigned_agent: null,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  })
;
}

function setupRepo(repoName: string): string {
  const root = resolve(
    tmpdir(),
    `dx226-watcher-${repoName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fsMkdirSync(resolve(root, ".danxbot", "config"), { recursive: true });
  fsMkdirSync(resolve(root, ".danxbot", "issues", "open"), { recursive: true });
  fsMkdirSync(resolve(root, ".danxbot", "issues", "closed"), {
    recursive: true,
  });
  fsWriteSync(
    resolve(root, ".danxbot", "config", "config.yml"),
    `name: ${repoName}\nurl: example\nissue_prefix: DX\n`,
  );
  return root;
}

function writeIssue(repoRoot: string, dir: "open" | "closed", overrides: IssueOverrides): string {
  const id = overrides.id ?? "DX-1";
  const path = resolve(repoRoot, ".danxbot", "issues", dir, `${id}.yml`);
  writeFileSync(path, buildIssueYaml(overrides), "utf-8");
  return path;
}

function collectPublished(): { events: BusEvent[]; restore: () => void } {
  const events: BusEvent[] = [];
  const spy = vi
    .spyOn(eventBus, "publish")
    .mockImplementation((event: BusEvent) => {
      events.push(event);
    });
  return {
    events,
    restore: () => spy.mockRestore(),
  };
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("startIssuesWatcher — single repo", () => {
  let repoRoot: string;
  let restorePublish: () => void;
  let events: BusEvent[];

  beforeEach(() => {
    repoRoot = setupRepo("danxbot");
    cleanupPaths.push(repoRoot);
    const collected = collectPublished();
    events = collected.events;
    restorePublish = collected.restore;
  });

  afterEach(() => restorePublish());

  it("publishes issue:updated with the parsed Issue + repoName on add", async () => {
    const path = writeIssue(repoRoot, "open", { id: "DX-1", title: "Hello" });
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 0 },
    );
    try {
      await watcher.simulate("danxbot", "add", path);

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.topic).toBe("issue:updated");
      if (evt.topic !== "issue:updated") throw new Error("topic guard");
      if ("removed" in evt.data && evt.data.removed)
        throw new Error("expected upsert variant");
      expect(evt.data.repoName).toBe("danxbot");
      expect(evt.data.id).toBe("DX-1");
      expect(evt.data.issue.id).toBe("DX-1");
      expect(evt.data.issue.title).toBe("Hello");
    } finally {
      await watcher.stop();
    }
  });

  it("debounces close add/change pairs for the same path into ONE publish", async () => {
    const path = writeIssue(repoRoot, "open", { id: "DX-2", title: "v1" });
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 50 },
    );
    try {
      void watcher.simulate("danxbot", "add", path);
      // Rewrite mid-debounce — only the latest content publishes.
      writeIssue(repoRoot, "open", { id: "DX-2", title: "v2" });
      await watcher.simulate("danxbot", "change", path);

      // Wait past the debounce window so the trailing timer fires.
      await new Promise((r) => setTimeout(r, 80));

      expect(events).toHaveLength(1);
      const evt = events[0];
      if (evt.topic !== "issue:updated") throw new Error("topic guard");
      if ("removed" in evt.data && evt.data.removed)
        throw new Error("expected upsert variant");
      expect(evt.data.issue.title).toBe("v2");
    } finally {
      await watcher.stop();
    }
  });

  it("on unlink publishes removed:true with just { repoName, id } — does NOT read the YAML", async () => {
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 0 },
    );
    try {
      // The path is intentionally NOT created — the watcher must not
      // try to read it. The card spec explicitly forbids a read on
      // unlink (the file is gone by definition).
      const ghostPath = resolve(
        repoRoot,
        ".danxbot",
        "issues",
        "open",
        "DX-GHOST.yml",
      );
      await watcher.simulate("danxbot", "unlink", ghostPath);

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.topic).toBe("issue:updated");
      if (evt.topic !== "issue:updated") throw new Error("topic guard");
      expect("removed" in evt.data && evt.data.removed).toBe(true);
      expect(evt.data.repoName).toBe("danxbot");
      expect(evt.data.id).toBe("DX-GHOST");
    } finally {
      await watcher.stop();
    }
  });

  it("on open↔closed move (unlink+add) does NOT publish removed when the sibling exists", async () => {
    // Move-aware behavior mirrors issues-mirror.ts#processUnlink: when an
    // agent flips a card to Done, chokidar emits add(closed) + unlink(open)
    // in unspecified order. A blind `removed: true` here would drop the
    // row from the SPA milliseconds after the add event upserts it.
    writeIssue(repoRoot, "closed", { id: "DX-MOVED", status: "Done" });
    const openPath = resolve(
      repoRoot,
      ".danxbot",
      "issues",
      "open",
      "DX-MOVED.yml",
    );

    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 0 },
    );
    try {
      await watcher.simulate("danxbot", "unlink", openPath);

      // Sibling existed → no removed publish (the closed/'s add will
      // own the SPA state).
      const removedEvents = events.filter(
        (e) => e.topic === "issue:updated" && "removed" in (e.data as object),
      );
      expect(removedEvents).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  });

  it("after stop() further simulate() calls do not publish", async () => {
    const path = writeIssue(repoRoot, "open", { id: "DX-3", title: "x" });
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 0 },
    );
    await watcher.stop();
    await watcher.simulate("danxbot", "add", path);
    expect(events).toHaveLength(0);
  });

  it("simulate() with an unknown repoName rejects with /Unknown repo/", async () => {
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 0 },
    );
    try {
      await expect(
        watcher.simulate(
          "never-configured",
          "add",
          resolve(repoRoot, ".danxbot", "issues", "open", "DX-1.yml"),
        ),
      ).rejects.toThrow(/Unknown repo/);
    } finally {
      await watcher.stop();
    }
  });

  it("stop() cancels pending debounce timers (no publish lands after stop)", async () => {
    const path = writeIssue(repoRoot, "open", { id: "DX-D", title: "x" });
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 50 },
    );
    void watcher.simulate("danxbot", "add", path);
    await watcher.stop();
    // Wait well past the debounce window — a leaked timer would fire
    // and publish even though stop() has run.
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(0);
  });

  it("ENOENT during the debounce window logs nothing + publishes nothing", async () => {
    const path = writeIssue(repoRoot, "open", { id: "DX-E", title: "vanish" });
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 50 },
    );
    try {
      void watcher.simulate("danxbot", "add", path);
      // Delete the file before the trailing timer fires — the read in
      // publishUpsert hits ENOENT and short-circuits without throwing.
      rmSync(path, { force: true });
      await new Promise((r) => setTimeout(r, 80));
      expect(events).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  });

  it("skips malformed YAML without publishing or throwing", async () => {
    const path = resolve(
      repoRoot,
      ".danxbot",
      "issues",
      "open",
      "DX-BROKEN.yml",
    );
    writeFileSync(path, "{not yaml: : :", "utf-8");
    const watcher = await startIssuesWatcher(
      [{ name: "danxbot", localPath: repoRoot }],
      eventBus,
      { disableWatcher: true, debounceMs: 0 },
    );
    try {
      await watcher.simulate("danxbot", "add", path);
      expect(events).toHaveLength(0);
    } finally {
      await watcher.stop();
    }
  });
});

describe("startIssuesWatcher — multiple repos", () => {
  it("a repo without `.danxbot/config/config.yml` is skipped; healthy siblings still publish", async () => {
    // Repo A has no config.yml → `loadIssuePrefix` throws → bootstrap
    // logs a warning and silently `continue`s past that repo. Healthy
    // repo B keeps working.
    const repoA = resolve(
      tmpdir(),
      `dx226-watcher-broken-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fsMkdirSync(resolve(repoA, ".danxbot", "issues", "open"), {
      recursive: true,
    });
    // intentionally omit config/config.yml
    const repoB = setupRepo("repo-healthy");
    cleanupPaths.push(repoA, repoB);
    const pathB = writeIssue(repoB, "open", { id: "DX-200", title: "B" });

    const { events, restore } = collectPublished();
    try {
      const watcher = await startIssuesWatcher(
        [
          { name: "repo-broken", localPath: repoA },
          { name: "repo-healthy", localPath: repoB },
        ],
        eventBus,
        { disableWatcher: true, debounceMs: 0 },
      );
      try {
        // Broken repo is silently absent from the registry.
        await expect(
          watcher.simulate(
            "repo-broken",
            "add",
            resolve(repoA, ".danxbot", "issues", "open", "X.yml"),
          ),
        ).rejects.toThrow(/Unknown repo/);
        // Healthy repo still publishes normally.
        await watcher.simulate("repo-healthy", "add", pathB);
        expect(
          events.filter((e) => e.topic === "issue:updated"),
        ).toHaveLength(1);
      } finally {
        await watcher.stop();
      }
    } finally {
      restore();
    }
  });

  it("publishes events scoped to the repo whose tree the event came from", async () => {
    const repoA = setupRepo("repo-a");
    const repoB = setupRepo("repo-b");
    cleanupPaths.push(repoA, repoB);
    const pathA = writeIssue(repoA, "open", { id: "DX-100", title: "A" });
    const pathB = writeIssue(repoB, "open", { id: "DX-100", title: "B" });

    const { events, restore } = collectPublished();
    try {
      const watcher = await startIssuesWatcher(
        [
          { name: "repo-a", localPath: repoA },
          { name: "repo-b", localPath: repoB },
        ],
        eventBus,
        { disableWatcher: true, debounceMs: 0 },
      );
      try {
        await watcher.simulate("repo-a", "add", pathA);
        await watcher.simulate("repo-b", "add", pathB);

        expect(events).toHaveLength(2);
        const titles = new Map<string, string>();
        for (const evt of events) {
          if (evt.topic !== "issue:updated") continue;
          if ("removed" in evt.data && evt.data.removed) continue;
          titles.set(evt.data.repoName, evt.data.issue.title);
        }
        expect(titles.get("repo-a")).toBe("A");
        expect(titles.get("repo-b")).toBe("B");
      } finally {
        await watcher.stop();
      }
    } finally {
      restore();
    }
  });
});
