import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { makeRepoContext } from "./__tests__/helpers/fixtures.js";
import {
  FEATURES,
  _resetForTesting,
  buildDisplayFromContext,
  defaultSettings,
  getIssuePollerPickupPrefix,
  getPrepMode,
  isAgentBroken,
  isFeatureEnabled,
  isTrelloSyncOverrideDisabled,
  isValidIanaTimeZone,
  mask,
  mutateAgents,
  readAgents,
  readSettings,
  setAgentBroken,
  settingsFilePath,
  settingsLockPath,
  syncSettingsFileOnBoot,
  validateStrikes,
  watchSettingsFile,
  writeSettings,
  type AgentBrokenState,
  type AgentRecord,
  type AgentStrikeEntry,
  type AgentStrikes,
  type Settings,
} from "./settings-file.js";

/**
 * Shared test scaffolding — every test gets an isolated temp dir that
 * acts as the "repo localPath". The `.danxbot/` subdir is created so
 * writeSettings can land the file without a prior `syncSettingsFileOnBoot`
 * call.
 */
function setupRepoDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-settings-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

describe("settings-file", () => {
  let localPath: string;

  beforeEach(() => {
    _resetForTesting();
    localPath = setupRepoDir();
  });

  afterEach(() => {
    rmSync(localPath, { recursive: true, force: true });
  });

  // ============================================================
  // mask()
  // ============================================================

  describe("mask", () => {
    it("returns '' for null/undefined/empty", () => {
      expect(mask(null)).toBe("");
      expect(mask(undefined)).toBe("");
      expect(mask("")).toBe("");
    });

    it("shows 'abcd****wxyz' for long values", () => {
      expect(mask("abcdef1234567890wxyz")).toBe("abcd****wxyz");
    });

    it("shows '****xyz' for short values", () => {
      expect(mask("short", 4)).toBe("****hort");
      expect(mask("abc", 4)).toBe("****abc");
    });

    it("coerces non-string inputs", () => {
      expect(mask(1234567890123)).toBe("1234****0123");
    });

    it("respects visible=0 as 'fully masked'", () => {
      expect(mask("anything", 0)).toBe("****");
    });
  });

  // ============================================================
  // readSettings()
  // ============================================================

  describe("readSettings", () => {
    it("returns defaults when file is missing", () => {
      const s = readSettings(localPath);
      expect(s).toEqual(defaultSettings());
      expect(s.overrides.slack.enabled).toBeNull();
      expect(s.overrides.issuePoller.enabled).toBeNull();
      expect(s.overrides.dispatchApi.enabled).toBeNull();
    });

    it("parses a well-formed file", () => {
      const body: Settings = {
        overrides: {
          slack: { enabled: false },
          issuePoller: { enabled: true },
          dispatchApi: { enabled: null },
          ideator: { enabled: null },
          autoTriage: { enabled: null },
          trelloSync: { enabled: null },
        },
        display: { worker: { port: 1234, runtime: "host" } },
        meta: { updatedAt: "2026-04-20T00:00:00Z", updatedBy: "dashboard:alice" },
      };
      writeFileSync(settingsFilePath(localPath), JSON.stringify(body));

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.overrides.issuePoller.enabled).toBe(true);
      expect(s.overrides.dispatchApi.enabled).toBeNull();
      expect(s.display.worker).toEqual({ port: 1234, runtime: "host" });
      expect(s.meta.updatedBy).toBe("dashboard:alice");
    });

    it("returns defaults on corrupt JSON without throwing", () => {
      writeFileSync(settingsFilePath(localPath), "{not json");
      const s = readSettings(localPath);
      expect(s).toEqual(defaultSettings());
    });

    it("migrates legacy `trelloPoller` key into the `issuePoller` slot on read", () => {
      // Pre-rename settings.json files (deployed boxes that haven't been
      // re-written yet) carry `overrides.trelloPoller` with both
      // `enabled` and `pickupNamePrefix`. The read path migrates that
      // value into the new `issuePoller` slot so operator toggles +
      // prefix survive the rename without a forced rewrite.
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            trelloPoller: { enabled: false, pickupNamePrefix: "[Legacy]" },
            dispatchApi: { enabled: null },
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.overrides.issuePoller.enabled).toBe(false);
      expect(s.overrides.issuePoller.pickupNamePrefix).toBe("[Legacy]");
    });

    it("migrates legacy `trelloPoller` carrying only `enabled` (no prefix) without leaking enabled", () => {
      // Regression guard: the migration shape must not depend on the
      // legacy payload also having `pickupNamePrefix`. Bare
      // `{ enabled: true }` must surface the boolean cleanly.
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            trelloPoller: { enabled: true },
            dispatchApi: { enabled: null },
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.overrides.issuePoller.enabled).toBe(true);
      expect(s.overrides.issuePoller.pickupNamePrefix).toBeNull();
    });

    it("prefers the new `issuePoller` slot when both legacy and new keys are present", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            issuePoller: { enabled: true, pickupNamePrefix: "[New]" },
            trelloPoller: { enabled: false, pickupNamePrefix: "[Legacy]" },
            dispatchApi: { enabled: null },
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.overrides.issuePoller.enabled).toBe(true);
      expect(s.overrides.issuePoller.pickupNamePrefix).toBe("[New]");
    });

    it("normalizes unknown override shapes to null", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: "yes" }, // not a boolean/null
            issuePoller: null,
            dispatchApi: 42,
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBeNull();
      expect(s.overrides.issuePoller.enabled).toBeNull();
      expect(s.overrides.dispatchApi.enabled).toBeNull();
    });

    it("rate-limits parse-error logs to once per minute per path", () => {
      const warn = vi.fn();
      vi.spyOn(console, "error").mockImplementation(warn);
      writeFileSync(settingsFilePath(localPath), "nope");

      readSettings(localPath);
      readSettings(localPath);
      readSettings(localPath);

      // Each readSettings call goes through the rate limiter; only one
      // log fires within the first minute.
      const parseLogCount = warn.mock.calls.filter((c) =>
        String(c[0]).includes("Failed to parse"),
      ).length;
      expect(parseLogCount).toBe(1);
    });
  });

  // ============================================================
  // writeSettings()
  // ============================================================

  describe("writeSettings", () => {
    it("creates the file if missing, stamps meta", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.overrides.issuePoller.enabled).toBeNull();
      expect(s.meta.updatedBy).toBe("dashboard:test");
      expect(s.meta.updatedAt).not.toBe(defaultSettings().meta.updatedAt);
    });

    it("writes atomically (tmp + rename — no intermediate partial file)", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      // No lingering .tmp.* files
      const danxbotDir = resolve(localPath, ".danxbot");
      const { readdirSync } = await import("node:fs");
      const entries = readdirSync(danxbotDir);
      const tmpFiles = entries.filter((e) => e.includes(".tmp."));
      expect(tmpFiles).toEqual([]);
    });

    it("preserves other overrides when patching one feature", async () => {
      await writeSettings(localPath, {
        overrides: {
          slack: { enabled: false },
          issuePoller: { enabled: true },
        },
        writtenBy: "setup",
      });

      await writeSettings(localPath, {
        overrides: { dispatchApi: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.overrides.issuePoller.enabled).toBe(true);
      expect(s.overrides.dispatchApi.enabled).toBe(false);
      expect(s.meta.updatedBy).toBe("dashboard:test");
    });

    // DX-302 — patching `trelloSync` alone must not clobber the existing
    // four-feature override surface, and patching another feature later
    // must preserve a prior `trelloSync` patch. Same writer-merge
    // invariant as every other override, pinned per-feature.
    it("preserves other overrides when patching trelloSync alone", async () => {
      await writeSettings(localPath, {
        overrides: {
          slack: { enabled: false },
          ideator: { enabled: true },
        },
        writtenBy: "setup",
      });

      await writeSettings(localPath, {
        overrides: { trelloSync: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.overrides.ideator.enabled).toBe(true);
      expect(s.overrides.trelloSync.enabled).toBe(false);
    });

    it("trelloSync default is `{enabled: null}` on a freshly-seeded file", () => {
      const d = defaultSettings();
      expect(d.overrides.trelloSync).toEqual({ enabled: null });
    });

    it("preserves display when patch only touches overrides", async () => {
      await writeSettings(localPath, {
        display: { worker: { port: 9001, runtime: "docker" } },
        writtenBy: "deploy",
      });

      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.display.worker).toEqual({ port: 9001, runtime: "docker" });
      expect(s.overrides.slack.enabled).toBe(false);
    });

    it("merges display sections without clobbering unrelated keys", async () => {
      await writeSettings(localPath, {
        display: {
          worker: { port: 1, runtime: "docker" },
          slack: { configured: true },
        },
        writtenBy: "setup",
      });

      await writeSettings(localPath, {
        display: { trello: { configured: false } },
        writtenBy: "deploy",
      });

      const s = readSettings(localPath);
      expect(s.display.worker).toEqual({ port: 1, runtime: "docker" });
      expect(s.display.slack).toEqual({ configured: true });
      expect(s.display.trello).toEqual({ configured: false });
    });

    it("serializes concurrent writes (no lost updates)", async () => {
      // Fire 10 concurrent toggles of dispatchApi, each flipping it based on
      // the prior state. With serialization, the final value deterministically
      // reflects all 10 alternations — odd iterations land false, even true.
      await writeSettings(localPath, {
        overrides: { dispatchApi: { enabled: true } },
        writtenBy: "setup",
      });

      const writes = Array.from({ length: 10 }, (_, i) =>
        writeSettings(localPath, {
          overrides: { dispatchApi: { enabled: i % 2 === 0 } },
          writtenBy: "dashboard:test",
        }),
      );
      await Promise.all(writes);

      const s = readSettings(localPath);
      // Last scheduled write in FIFO order is i=9 → 9 % 2 === 0 → false
      expect(s.overrides.dispatchApi.enabled).toBe(false);
    });

    it("does not poison the in-process queue when a write rejects", async () => {
      // Force the first write to reject by pointing `localPath` at a
      // non-directory (renameSync's parent). A subsequent write at the
      // real path must still succeed — rejection must not stall or
      // deadlock the in-process chain for future writes.
      const badPath = resolve(localPath, "does-not-exist-as-dir");
      // Drop a file where the .danxbot directory would go so mkdirSync fails.
      writeFileSync(badPath, "blocker");

      await expect(
        writeSettings(badPath, {
          overrides: { slack: { enabled: true } },
          writtenBy: "dashboard:test",
        }),
      ).rejects.toThrow();

      // Real path still works — queue is not stuck.
      await writeSettings(localPath, {
        overrides: { slack: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      expect(readSettings(localPath).overrides.slack.enabled).toBe(true);
    });

    it("creates the .danxbot directory if missing", async () => {
      // Fresh repo path with no .danxbot at all.
      rmSync(resolve(localPath, ".danxbot"), { recursive: true, force: true });

      await writeSettings(localPath, {
        overrides: { slack: { enabled: true } },
        writtenBy: "setup",
      });

      expect(existsSync(settingsFilePath(localPath))).toBe(true);
      expect(readSettings(localPath).overrides.slack.enabled).toBe(true);
    });

    it("records the writer in meta.updatedBy", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "deploy",
      });
      expect(readSettings(localPath).meta.updatedBy).toBe("deploy");

      await writeSettings(localPath, {
        overrides: { slack: { enabled: true } },
        writtenBy: "setup",
      });
      expect(readSettings(localPath).meta.updatedBy).toBe("setup");
    });

    it("accepts dashboard:<username> as the writer (Phase 4+)", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:newms87",
      });
      expect(readSettings(localPath).meta.updatedBy).toBe("dashboard:newms87");
    });

    it("rejects bare 'dashboard' on disk (Phase 2/3 legacy) and falls back to default", () => {
      // A settings file written by the old Phase 2/3 code carries a bare
      // `updatedBy: "dashboard"`. Phase 4 tightens the shape so normalize
      // rejects it and falls back to the default writer — the next write
      // stamps the new `dashboard:<username>` form.
      writeFileOnDisk({ updatedBy: "dashboard" });
      expect(readSettings(localPath).meta.updatedBy).toBe("worker");
    });

    it("rejects 'dashboard:' with an empty username (prefix only)", () => {
      writeFileOnDisk({ updatedBy: "dashboard:" });
      expect(readSettings(localPath).meta.updatedBy).toBe("worker");
    });

    it("rejects arbitrary unknown writer strings", () => {
      // Defense-in-depth: anything outside the four canonical forms
      // (`dashboard:<name>`, `deploy`, `setup`, `worker`) is dropped.
      writeFileOnDisk({ updatedBy: "hacker" });
      expect(readSettings(localPath).meta.updatedBy).toBe("worker");
    });

    /** Stamp a settings file on disk with the given writer string. */
    function writeFileOnDisk(meta: { updatedBy: unknown }): void {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            issuePoller: { enabled: null },
            dispatchApi: { enabled: null },
          },
          display: {},
          meta: { updatedAt: "2026-04-19T12:00:00Z", ...meta },
        }),
      );
    }
  });

  // ============================================================
  // isFeatureEnabled()
  // ============================================================

  describe("isFeatureEnabled", () => {
    it("returns env default when override is null (no file)", () => {
      const ctxOn = makeRepoContext({
        localPath,
        slack: {
          enabled: true,
          botToken: "x",
          appToken: "y",
          channelId: "C",
        },
        trelloEnabled: false,
      });
      expect(isFeatureEnabled(ctxOn, "slack")).toBe(true);
      expect(isFeatureEnabled(ctxOn, "issuePoller")).toBe(false);
      // dispatchApi env default is always true
      expect(isFeatureEnabled(ctxOn, "dispatchApi")).toBe(true);
    });

    it("returns override value when override is true", async () => {
      await writeSettings(localPath, {
        overrides: { issuePoller: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath, trelloEnabled: false });
      expect(isFeatureEnabled(ctx, "issuePoller")).toBe(true);
    });

    it("returns override value when override is false", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({
        localPath,
        slack: {
          enabled: true,
          botToken: "x",
          appToken: "y",
          channelId: "C",
        },
      });
      expect(isFeatureEnabled(ctx, "slack")).toBe(false);
    });

    it("falls back to env default when settings file is corrupt", () => {
      writeFileSync(settingsFilePath(localPath), "broken json");
      const ctx = makeRepoContext({ localPath, trelloEnabled: true });
      expect(isFeatureEnabled(ctx, "issuePoller")).toBe(true);
    });

    it("covers all six features via the FEATURES constant", () => {
      expect(FEATURES).toEqual([
        "slack",
        "issuePoller",
        "dispatchApi",
        "ideator",
        "autoTriage",
        "trelloSync",
      ]);
    });

    // DX-302 — trelloSync defers to env (RepoContext.trelloEnabled) when
    // override is null; explicit override wins. Distinct from
    // issuePoller, which gates the whole poll tick — trelloSync gates
    // only the Trello legs.
    it("trelloSync env default is `RepoContext.trelloEnabled` when override is null", () => {
      const ctxOn = makeRepoContext({ localPath, trelloEnabled: true });
      expect(isFeatureEnabled(ctxOn, "trelloSync")).toBe(true);
      const ctxOff = makeRepoContext({ localPath, trelloEnabled: false });
      expect(isFeatureEnabled(ctxOff, "trelloSync")).toBe(false);
    });

    it("trelloSync override=true forces on even when env is false", async () => {
      await writeSettings(localPath, {
        overrides: { trelloSync: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath, trelloEnabled: false });
      expect(isFeatureEnabled(ctx, "trelloSync")).toBe(true);
    });

    it("trelloSync override=false forces off even when env is true", async () => {
      await writeSettings(localPath, {
        overrides: { trelloSync: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath, trelloEnabled: true });
      expect(isFeatureEnabled(ctx, "trelloSync")).toBe(false);
    });
  });

  // ============================================================
  // isTrelloSyncOverrideDisabled — DX-302 override-only helper
  // ============================================================

  describe("isTrelloSyncOverrideDisabled", () => {
    it("returns false when settings file is missing", () => {
      expect(isTrelloSyncOverrideDisabled(localPath)).toBe(false);
    });

    it("returns false when override is null (defer to env)", async () => {
      await writeSettings(localPath, {
        overrides: { trelloSync: { enabled: null } },
        writtenBy: "dashboard:test",
      });
      expect(isTrelloSyncOverrideDisabled(localPath)).toBe(false);
    });

    it("returns false when override is true (explicit on)", async () => {
      await writeSettings(localPath, {
        overrides: { trelloSync: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      expect(isTrelloSyncOverrideDisabled(localPath)).toBe(false);
    });

    it("returns true ONLY when override is explicitly false", async () => {
      await writeSettings(localPath, {
        overrides: { trelloSync: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      expect(isTrelloSyncOverrideDisabled(localPath)).toBe(true);
    });

    it("returns false when settings file is corrupt (fail-safe)", () => {
      writeFileSync(settingsFilePath(localPath), "broken json");
      expect(isTrelloSyncOverrideDisabled(localPath)).toBe(false);
    });
  });

  describe("isFeatureEnabled — feature-specific defaults", () => {
    it("ideator env default is false (explicit opt-in)", () => {
      const ctx = makeRepoContext({ localPath });
      expect(isFeatureEnabled(ctx, "ideator")).toBe(false);
    });

    it("ideator returns true when override is true", async () => {
      await writeSettings(localPath, {
        overrides: { ideator: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath });
      expect(isFeatureEnabled(ctx, "ideator")).toBe(true);
    });

    it("ideator returns false when override explicitly false", async () => {
      await writeSettings(localPath, {
        overrides: { ideator: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath });
      expect(isFeatureEnabled(ctx, "ideator")).toBe(false);
    });

    it("autoTriage env default is false (explicit opt-in)", () => {
      const ctx = makeRepoContext({ localPath });
      expect(isFeatureEnabled(ctx, "autoTriage")).toBe(false);
    });

    it("autoTriage returns true when override is true", async () => {
      await writeSettings(localPath, {
        overrides: { autoTriage: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath });
      expect(isFeatureEnabled(ctx, "autoTriage")).toBe(true);
    });

    it("autoTriage returns false when override explicitly false", async () => {
      await writeSettings(localPath, {
        overrides: { autoTriage: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath });
      expect(isFeatureEnabled(ctx, "autoTriage")).toBe(false);
    });

    it("autoTriage default settings include slot initialized to enabled: null", () => {
      const s = readSettings(localPath);
      expect(s.overrides.autoTriage).toEqual({ enabled: null });
    });

    it("preserves autoTriage override across an unrelated patch", async () => {
      await writeSettings(localPath, {
        overrides: { autoTriage: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      const s = readSettings(localPath);
      expect(s.overrides.autoTriage.enabled).toBe(true);
      expect(s.overrides.slack.enabled).toBe(false);
    });
  });

  // ============================================================
  // buildDisplayFromContext + syncSettingsFileOnBoot
  // ============================================================

  describe("buildDisplayFromContext", () => {
    it("masks secrets and echoes non-secret identifiers", () => {
      const ctx = makeRepoContext({
        localPath,
        trello: {
          apiKey: "1234567890abcdef",
          apiToken: "token-abcdefghij",
          boardId: "board123",
          reviewListId: "",
          todoListId: "",
          inProgressListId: "",
          needsHelpListId: "",
          doneListId: "",
          cancelledListId: "",
          actionItemsListId: "",
          bugLabelId: "",
          featureLabelId: "",
          epicLabelId: "",
          needsHelpLabelId: "",
          blockedLabelId: "",
          requiresHumanLabelId: "",
        },
        githubToken: "ghp_1234567890abcdef",
      });
      const display = buildDisplayFromContext(ctx, "host");

      expect(display.worker).toEqual({ port: 5562, runtime: "host" });
      expect(display.trello?.apiKey).toMatch(/\*\*\*\*/);
      expect(display.trello?.apiKey).not.toBe("1234567890abcdef");
      expect(display.trello?.boardId).toBe("board123");
      expect(display.github?.token).toMatch(/\*\*\*\*/);
      expect(display.github?.token).not.toBe("ghp_1234567890abcdef");
      expect(display.links?.trelloBoardUrl).toBe("https://trello.com/b/board123");
    });

    // DX-304 — TrelloConfigPanel renders the ToDo list id read-only, so the
    // panel's data source (`display.trello.todoListId`) must round-trip the
    // value from RepoContext. The other workflow list ids are surfaced
    // alongside it so the dashboard can grow them into the panel without a
    // second schema bump.
    it("surfaces trello list ids (todo/inProgress/done) for the dashboard panel", () => {
      const ctx = makeRepoContext({
        localPath,
        trello: {
          apiKey: "k",
          apiToken: "t",
          boardId: "board-1",
          reviewListId: "r-list",
          todoListId: "todo-list",
          inProgressListId: "ip-list",
          needsHelpListId: "nh-list",
          doneListId: "done-list",
          cancelledListId: "cx-list",
          actionItemsListId: "ai-list",
          bugLabelId: "",
          featureLabelId: "",
          epicLabelId: "",
          needsHelpLabelId: "",
          blockedLabelId: "",
          requiresHumanLabelId: "",
        },
      });
      const display = buildDisplayFromContext(ctx, "host");
      expect(display.trello?.todoListId).toBe("todo-list");
      expect(display.trello?.inProgressListId).toBe("ip-list");
      expect(display.trello?.doneListId).toBe("done-list");
    });

    // DX-304 AC #3 — TrelloConfigPanel renders BOTH the api key and api
    // token as masked rows. Pre-DX-304 the display only masked apiKey;
    // the panel needs both to render its initial state without exposing
    // the raw value.
    it("masks BOTH apiKey and apiToken for the dashboard panel", () => {
      const ctx = makeRepoContext({
        localPath,
        trello: {
          apiKey: "1234567890abcdef",
          apiToken: "token-abcdefghij",
          boardId: "b",
          reviewListId: "",
          todoListId: "",
          inProgressListId: "",
          needsHelpListId: "",
          doneListId: "",
          cancelledListId: "",
          actionItemsListId: "",
          bugLabelId: "",
          featureLabelId: "",
          epicLabelId: "",
          needsHelpLabelId: "",
          blockedLabelId: "",
          requiresHumanLabelId: "",
        },
      });
      const display = buildDisplayFromContext(ctx, "host");
      // Mask shape: `<first4>****<last4>` for tokens longer than 8 chars.
      // Asserting the shape pins behavior — `.not.toBe(raw)` alone would
      // also pass for an empty string.
      expect(display.trello?.apiToken).toMatch(/^toke\*\*\*\*ghij$/);
    });
  });

  describe("syncSettingsFileOnBoot", () => {
    it("creates the file with display populated when missing", async () => {
      const ctx = makeRepoContext({ localPath });
      await syncSettingsFileOnBoot(ctx, "docker");

      expect(existsSync(settingsFilePath(localPath))).toBe(true);
      const s = readSettings(localPath);
      expect(s.display.worker?.runtime).toBe("docker");
      expect(s.display.worker?.port).toBe(5562);
      expect(s.overrides.slack.enabled).toBeNull();
    });

    it("refreshes display on every call while preserving overrides", async () => {
      // First: operator sets an override (imagine via the dashboard).
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      // Then: worker boots with a new runtime (e.g. a deploy moves from
      // host to docker). Display must refresh, override must survive.
      const ctx = makeRepoContext({ localPath });
      await syncSettingsFileOnBoot(ctx, "docker");

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.display.worker?.runtime).toBe("docker");
      expect(s.display.worker?.port).toBe(5562);
    });

    it("overwrites a stale display.worker on subsequent boots", async () => {
      const ctx = makeRepoContext({ localPath, workerPort: 5562 });
      await syncSettingsFileOnBoot(ctx, "host");
      expect(readSettings(localPath).display.worker?.runtime).toBe("host");

      // Next boot is in docker runtime on a different port.
      const ctx2 = makeRepoContext({ localPath, workerPort: 5999 });
      await syncSettingsFileOnBoot(ctx2, "docker");
      const s = readSettings(localPath);
      expect(s.display.worker?.runtime).toBe("docker");
      expect(s.display.worker?.port).toBe(5999);
    });
  });

  // ============================================================
  // Lock file behavior
  // ============================================================

  describe("settingsLockPath", () => {
    it("resolves to .danxbot/.settings.lock under the repo path", () => {
      expect(settingsLockPath("/repo")).toBe("/repo/.danxbot/.settings.lock");
    });
  });

  describe("file lock", () => {
    it("removes the lock file after a successful write", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      expect(existsSync(settingsLockPath(localPath))).toBe(false);
    });

    it("steals a stale lock older than 30s and still writes", async () => {
      // Simulate a crashed holder by dropping a stale lock file.
      const lockPath = settingsLockPath(localPath);
      writeFileSync(lockPath, `99999\n2020-01-01T00:00:00Z\n`);
      // Backdate mtime well past the stale threshold.
      const thirtyOneSecondsAgo = new Date(Date.now() - 31_000);
      const { utimesSync } = await import("node:fs");
      utimesSync(lockPath, thirtyOneSecondsAgo, thirtyOneSecondsAgo);

      await writeSettings(localPath, {
        overrides: { slack: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      expect(readSettings(localPath).overrides.slack.enabled).toBe(true);
      // The lock was stolen and then released cleanly.
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  // ============================================================
  // getIssuePollerPickupPrefix() — test isolation hook
  // ============================================================

  describe("getIssuePollerPickupPrefix", () => {
    it("returns null when settings file is missing", () => {
      expect(getIssuePollerPickupPrefix(localPath)).toBeNull();
    });

    it("returns null when prefix is unset", async () => {
      await writeSettings(localPath, {
        overrides: { issuePoller: { enabled: true } },
        writtenBy: "setup",
      });
      expect(getIssuePollerPickupPrefix(localPath)).toBeNull();
    });

    it("returns the prefix when set as a non-empty string", async () => {
      await writeSettings(localPath, {
        overrides: {
          issuePoller: { enabled: null, pickupNamePrefix: "[System Test]" },
        },
        writtenBy: "setup",
      });
      expect(getIssuePollerPickupPrefix(localPath)).toBe("[System Test]");
    });

    it("returns null when prefix is empty string", async () => {
      await writeSettings(localPath, {
        overrides: {
          issuePoller: { enabled: null, pickupNamePrefix: "" },
        },
        writtenBy: "setup",
      });
      expect(getIssuePollerPickupPrefix(localPath)).toBeNull();
    });

    it("returns null on corrupt JSON without throwing", () => {
      writeFileSync(settingsFilePath(localPath), "not json");
      expect(getIssuePollerPickupPrefix(localPath)).toBeNull();
    });

    it("preserves pickupNamePrefix across an unrelated override patch", async () => {
      await writeSettings(localPath, {
        overrides: {
          issuePoller: { enabled: null, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      // Operator toggles slack — must not clobber the issuePoller prefix.
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      expect(getIssuePollerPickupPrefix(localPath)).toBe("[X]");
    });

    it("preserves pickupNamePrefix across a display-only patch", async () => {
      await writeSettings(localPath, {
        overrides: {
          issuePoller: { enabled: null, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      await writeSettings(localPath, {
        display: { worker: { port: 1234, runtime: "host" } },
        writtenBy: "deploy",
      });
      expect(getIssuePollerPickupPrefix(localPath)).toBe("[X]");
    });

    it("normalizes non-string prefix to null without throwing", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            issuePoller: { enabled: null, pickupNamePrefix: 42 },
            dispatchApi: { enabled: null },
          },
        }),
      );
      expect(getIssuePollerPickupPrefix(localPath)).toBeNull();
    });

    it("clears pickupNamePrefix when patch sets it to null", async () => {
      await writeSettings(localPath, {
        overrides: {
          issuePoller: { enabled: null, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      await writeSettings(localPath, {
        overrides: {
          issuePoller: { enabled: null, pickupNamePrefix: null },
        },
        writtenBy: "setup",
      });
      expect(getIssuePollerPickupPrefix(localPath)).toBeNull();
    });

    it("preserves the enabled toggle when only the prefix is patched", async () => {
      await writeSettings(localPath, {
        overrides: { issuePoller: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      await writeSettings(localPath, {
        overrides: {
          issuePoller: { enabled: false, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      const s = readSettings(localPath);
      expect(s.overrides.issuePoller.enabled).toBe(false);
      expect(getIssuePollerPickupPrefix(localPath)).toBe("[X]");
    });
  });

  // ============================================================
  // JSON shape integrity (extended for trello-poller prefix)
  // ============================================================

  describe("file contents on disk", () => {
    it("is valid JSON with trailing newline", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      const raw = readFileSync(settingsFilePath(localPath), "utf-8");
      expect(raw.endsWith("\n")).toBe(true);
      // parse round-trip
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("stores overrides in the documented three-valued shape", async () => {
      await writeSettings(localPath, {
        overrides: {
          slack: { enabled: true },
          issuePoller: { enabled: false },
          dispatchApi: { enabled: null },
        },
        writtenBy: "setup",
      });
      const raw = JSON.parse(
        readFileSync(settingsFilePath(localPath), "utf-8"),
      );
      expect(raw.overrides.slack).toEqual({ enabled: true });
      expect(raw.overrides.issuePoller).toEqual({ enabled: false });
      expect(raw.overrides.dispatchApi).toEqual({ enabled: null });
    });

    it("write-side never emits the legacy `trelloPoller` key — even after migrating from one", async () => {
      // Plant a legacy file on disk.
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            trelloPoller: { enabled: true, pickupNamePrefix: "[X]" },
            dispatchApi: { enabled: null },
          },
          display: {},
          meta: { updatedAt: "2026-04-19T12:00:00Z", updatedBy: "worker" },
        }),
      );

      // An unrelated patch (operator toggles slack) — the merge runs
      // through `safeParse` → `normalize`, which migrates the legacy
      // `trelloPoller` slot. The rewritten file must carry only the
      // canonical `issuePoller` key.
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      const raw = JSON.parse(
        readFileSync(settingsFilePath(localPath), "utf-8"),
      );
      expect(raw.overrides.issuePoller).toEqual({
        enabled: true,
        pickupNamePrefix: "[X]",
      });
      expect(raw.overrides.trelloPoller).toBeUndefined();
    });
  });

  // ============================================================
  // agents{} + agentDefaults — DX-159 Phase 1
  //
  // Schema additions: AgentRecord-typed entries keyed by agent name plus
  // an optional `agentDefaults` block carrying the prepMode toggle.
  // Validation rules (drop-on-fail unless noted as filter):
  //   - Max 5 entries; excess dropped + warned.
  //   - Name regex: ^[a-z][a-z0-9_-]{0,31}$ (URL/branch/path-safe).
  //   - capabilities: non-empty subset of {issue-worker,slack,api}.
  //     Unknown values are filtered per-element; an empty result drops
  //     the entire record.
  //   - schedule.tz: parseable by Intl.DateTimeFormat (else drop).
  //   - Per-day windows: HH:MM-HH:MM regex; bad windows filtered per
  //     element; empty array allowed.
  //
  // Helpers: readAgents(ctx) returns a stable-ordered array of valid
  // records.
  // ============================================================

  describe("agents schema", () => {
    function validAgent(over?: Partial<AgentRecord>): AgentRecord {
      return {
        type: "agent",
        bio: "Default test bio.",
        capabilities: ["issue-worker"],
        schedule: {
          tz: "America/Chicago",
          always_on: false,
          mon: ["09:00-17:00"],
          tue: ["09:00-17:00"],
          wed: ["09:00-17:00"],
          thu: ["09:00-17:00"],
          fri: ["09:00-12:00"],
          sat: [],
          sun: [],
        },
        enabled: true,
        broken: null,
        strikes: { count: 0, history: [] },
        created_at: "2026-05-08T12:00:00Z",
        updated_at: "2026-05-08T12:00:00Z",
        ...over,
      };
    }

    it("drops the 6th-and-beyond entry from a 6-agent file (cap = 5)", () => {
      const agents: Record<string, AgentRecord> = {};
      for (let i = 0; i < 6; i++) agents[`a${i}`] = validAgent();
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({ overrides: {}, agents }),
      );

      const s = readSettings(localPath);
      const names = Object.keys(s.agents ?? {});
      expect(names).toHaveLength(5);
      // Insertion order — first 5 keep, 6th drops.
      expect(names).toEqual(["a0", "a1", "a2", "a3", "a4"]);
    });

    it("drops agents with names that don't match ^[a-z][a-z0-9_-]{0,31}$", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            // bad — uppercase
            Alice: validAgent(),
            // bad — leading digit
            "1abc": validAgent(),
            // bad — too long (> 32 chars total)
            "a-very-long-name-that-exceeds-thirty-two-chars": validAgent(),
            // bad — empty name (would never serialize this way but proves the regex catches it)
            // good
            alice: validAgent(),
            // good
            bob_x: validAgent(),
          },
        }),
      );

      const s = readSettings(localPath);
      const names = Object.keys(s.agents ?? {}).sort();
      expect(names).toEqual(["alice", "bob_x"]);
    });

    it("drops agents with empty capabilities array", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: validAgent({ capabilities: [] }),
            bob: validAgent({ capabilities: ["slack"] }),
          },
        }),
      );

      const s = readSettings(localPath);
      expect(Object.keys(s.agents ?? {})).toEqual(["bob"]);
    });

    it("strips unknown capability values, keeps valid ones", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: validAgent({
              capabilities: ["issue-worker", "wat", "api", "nope"] as never,
            }),
          },
        }),
      );

      const s = readSettings(localPath);
      expect(s.agents?.alice.capabilities).toEqual(["issue-worker", "api"]);
    });

    it("drops agents with non-IANA schedule.tz", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: validAgent({
              schedule: {
                ...validAgent().schedule,
                tz: "Bogus/Place",
              },
            }),
            bob: validAgent(),
          },
        }),
      );

      const s = readSettings(localPath);
      expect(Object.keys(s.agents ?? {})).toEqual(["bob"]);
    });

    it("strips per-day windows that don't match HH:MM-HH:MM", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: validAgent({
              schedule: {
                ...validAgent().schedule,
                mon: ["09:00-25:00", "12:00-13:00", "ohai"],
                tue: ["09:00-17:00"],
              },
            }),
          },
        }),
      );

      const s = readSettings(localPath);
      // Only the in-range window survives on mon; tue is unchanged.
      expect(s.agents?.alice.schedule.mon).toEqual(["12:00-13:00"]);
      expect(s.agents?.alice.schedule.tue).toEqual(["09:00-17:00"]);
    });

    it("round-trips a valid agents map across write+read", async () => {
      await writeSettings(localPath, {
        agents: {
          alice: validAgent({ bio: "Alice's bio." }),
          bob: validAgent({ bio: "Bob's bio.", capabilities: ["slack"] }),
        },
        writtenBy: "dashboard:test",
      });
      const s = readSettings(localPath);
      expect(Object.keys(s.agents ?? {}).sort()).toEqual(["alice", "bob"]);
      expect(s.agents?.alice.bio).toBe("Alice's bio.");
      expect(s.agents?.bob.capabilities).toEqual(["slack"]);
    });

    it("readAgents() returns the agents as an array in insertion order", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            charlie: validAgent({ bio: "C" }),
            alice: validAgent({ bio: "A" }),
            bob: validAgent({ bio: "B" }),
          },
        }),
      );
      const arr = readAgents(localPath);
      expect(arr.map((a) => a.name)).toEqual(["charlie", "alice", "bob"]);
      expect(arr.map((a) => a.bio)).toEqual(["C", "A", "B"]);
    });

    it("preserves agents + agentDefaults across an unrelated overrides patch", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent({ bio: "A" }) },
        agentDefaults: { prepMode: "separate" },
        writtenBy: "dashboard:test",
      });

      // An unrelated toggle patch must not clobber agents or agentDefaults.
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.agents?.alice.bio).toBe("A");
      expect(s.agentDefaults?.prepMode).toBe("separate");
    });

    it("missing agents/agentDefaults in stored file load as empty/defaults (backwards-compat)", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            issuePoller: { enabled: null },
            dispatchApi: { enabled: null },
          },
          display: {},
          meta: { updatedAt: "2026-05-08T12:00:00Z", updatedBy: "worker" },
        }),
      );
      const s = readSettings(localPath);
      expect(s.agents).toEqual({});
      expect(s.agentDefaults?.prepMode).toBe("combined");
    });

    it("drops records missing required fields (bio, enabled, timestamps)", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            // missing bio
            no_bio: { ...validAgent(), bio: undefined },
            // non-boolean enabled
            bad_enabled: { ...validAgent(), enabled: "yes" },
            // missing timestamps
            no_created_at: { ...validAgent(), created_at: undefined },
            no_updated_at: { ...validAgent(), updated_at: undefined },
            // good baseline
            ok: validAgent(),
          },
        }),
      );
      const s = readSettings(localPath);
      expect(Object.keys(s.agents ?? {})).toEqual(["ok"]);
    });

    it("drops records missing the type:'agent' discriminator", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            no_type: { ...validAgent(), type: undefined },
            wrong_type: { ...validAgent(), type: "service" },
            ok: validAgent(),
          },
        }),
      );
      const s = readSettings(localPath);
      expect(Object.keys(s.agents ?? {})).toEqual(["ok"]);
    });

    // DX-281 — writer-merge invariant for agents{} map. Pre-DX-281 the
    // writer wholesale-replaced agents on any `patch.agents` write; a
    // second caller passing {alice} silently clobbered operator-added
    // entries on disk (phil disappeared mid-`make test-system` runs).
    // Post-DX-281, `patch.agents` merges per-key into the locked on-disk
    // read; on-disk-only keys (operator additions) ALWAYS survive. The
    // "clear all" semantic moves to `mutateAgents(p, () => ({}), w)` —
    // the only API that can intentionally drop operator state, and only
    // by explicitly returning an empty map from inside the lock.
    describe("DX-281 agents merge invariant", () => {
      it("writeSettings({agents}) merges per-key into on-disk agents — never clobbers operator additions", async () => {
        // Operator state: phil exists on disk (added via mutateAgents,
        // mirroring the dashboard POST /api/agents path).
        await mutateAgents(
          localPath,
          (current) => {
            current.phil = validAgent({ bio: "Phil's bio." });
            return current;
          },
          "dashboard:operator",
        );
        expect(Object.keys(readSettings(localPath).agents ?? {})).toEqual([
          "phil",
        ]);

        // Separate caller passes patch.agents = {alice}. Pre-fix this
        // wholesale-replaced — phil was wiped. Post-fix the writer merges.
        await writeSettings(localPath, {
          agents: { alice: validAgent({ bio: "Alice's bio." }) },
          writtenBy: "setup",
        });

        const s = readSettings(localPath);
        expect(Object.keys(s.agents ?? {}).sort()).toEqual(["alice", "phil"]);
        expect(s.agents?.phil.bio).toBe("Phil's bio.");
        expect(s.agents?.alice.bio).toBe("Alice's bio.");
      });

      it("writeSettings({agents}) overwrites entries when keys collide (patch wins per-key)", async () => {
        await mutateAgents(
          localPath,
          (c) => {
            c.alice = validAgent({ bio: "v1" });
            return c;
          },
          "dashboard:operator",
        );

        await writeSettings(localPath, {
          agents: { alice: validAgent({ bio: "v2" }) },
          writtenBy: "setup",
        });

        expect(readSettings(localPath).agents?.alice.bio).toBe("v2");
      });

      it("test-seed pattern (writeSettings({agents: {alice, bob, charlie}})) preserves operator additions", async () => {
        // Mirror of the actual `_multi_worker_seed_agents` shell test
        // seed path that bit us. Operator's phil is on disk; the test
        // seed writes alice/bob/charlie via patch.agents. With the
        // wholesale-replace bug, phil was wiped silently. With merge
        // semantics, phil survives.
        await mutateAgents(
          localPath,
          (c) => {
            c.phil = validAgent({ bio: "phil" });
            return c;
          },
          "dashboard:operator",
        );

        await writeSettings(localPath, {
          agents: {
            alice: validAgent({ bio: "alice" }),
            bob: validAgent({ bio: "bob" }),
            charlie: validAgent({ bio: "charlie" }),
          },
          writtenBy: "setup",
        });

        expect(Object.keys(readSettings(localPath).agents ?? {}).sort()).toEqual([
          "alice",
          "bob",
          "charlie",
          "phil",
        ]);
      });

      it("concurrent display-only + agents-only writes both preserve pre-existing operator agents", async () => {
        // Two concurrent writes simulate the reported race: worker's
        // syncSettingsFileOnBoot (display-only) firing while a parallel
        // setup-shaped agents-only write lands. The in-process queue
        // (enqueueWrite) serializes them; the merge invariant keeps phil.
        await mutateAgents(
          localPath,
          (c) => {
            c.phil = validAgent({ bio: "phil" });
            return c;
          },
          "dashboard:operator",
        );

        await Promise.all([
          writeSettings(localPath, {
            display: { worker: { port: 9999, runtime: "host" } },
            writtenBy: "worker",
          }),
          writeSettings(localPath, {
            agents: { alice: validAgent({ bio: "alice" }) },
            writtenBy: "setup",
          }),
        ]);

        const s = readSettings(localPath);
        expect(Object.keys(s.agents ?? {}).sort()).toEqual(["alice", "phil"]);
        expect(s.display.worker?.port).toBe(9999);
      });

      it("5 sequential agents-bearing writes (AC5 stand-in) all preserve the operator-added agent", async () => {
        // AC5 calls for "phil added → 5 consecutive dispatches → phil
        // still present". The agents-bearing writes are the worst case
        // (a display-only write never touches `agents`), so the
        // stand-in fires 5 writes that each pass a fresh `patch.agents`
        // and asserts phil survives every one.
        await mutateAgents(
          localPath,
          (c) => {
            c.phil = validAgent({ bio: "phil" });
            return c;
          },
          "dashboard:operator",
        );

        for (let i = 0; i < 5; i++) {
          await writeSettings(localPath, {
            agents: { alice: validAgent({ bio: `alice-v${i}` }) },
            writtenBy: "setup",
          });
          const s = readSettings(localPath);
          expect(s.agents?.phil?.bio).toBe("phil");
          expect(s.agents?.alice?.bio).toBe(`alice-v${i}`);
        }
      });

      it("writeSettings({agents: {}}) is a no-op for agents (merge of empty); use mutateAgents to clear", async () => {
        await mutateAgents(
          localPath,
          (c) => {
            c.alice = validAgent({ bio: "A" });
            c.bob = validAgent({ bio: "B" });
            return c;
          },
          "dashboard:test",
        );
        await writeSettings(localPath, {
          agentDefaults: { prepMode: "separate" },
          writtenBy: "dashboard:test",
        });

        // Empty patch.agents merges into on-disk agents → no-op for agents.
        await writeSettings(localPath, {
          agents: {},
          writtenBy: "dashboard:test",
        });
        expect(Object.keys(readSettings(localPath).agents ?? {}).sort()).toEqual([
          "alice",
          "bob",
        ]);

        // To clear, callers must use mutateAgents — the only API that
        // can intentionally drop on-disk entries (return value replaces
        // the map inside the lock).
        await mutateAgents(localPath, () => ({}), "dashboard:test");
        const s = readSettings(localPath);
        expect(s.agents).toEqual({});
        expect(s.agentDefaults?.prepMode).toBe("separate");
      });

      it("merge respects AGENTS_MAX cap — patch entries dropped (operator-first insertion order) when combined exceed cap", async () => {
        // AGENTS_MAX is 5. Seed 5 operator agents first; a patch
        // adding a 6th entry should drop the new entry (insertion
        // order preserves operator agents). This pins the safety net
        // the shell-helper comment names: "exceeded cap drops trailing
        // entries via normalizeAgents on the next read — surfaces as
        // a visible failure rather than silent operator data loss."
        await mutateAgents(
          localPath,
          (c) => {
            for (let i = 0; i < 5; i++) {
              c[`op${i}`] = validAgent({ bio: `operator-${i}` });
            }
            return c;
          },
          "dashboard:operator",
        );
        expect(Object.keys(readSettings(localPath).agents ?? {})).toHaveLength(5);

        await writeSettings(localPath, {
          agents: { newcomer: validAgent({ bio: "newcomer" }) },
          writtenBy: "setup",
        });

        const s = readSettings(localPath);
        const names = Object.keys(s.agents ?? {}).sort();
        expect(names).toEqual(["op0", "op1", "op2", "op3", "op4"]);
        expect(s.agents?.newcomer).toBeUndefined();
      });

      it("merge stamps meta.updatedBy from the latest patch (not the prior writer)", async () => {
        // Diagnostic invariant from the original bug — `meta.updatedBy`
        // was the smoking gun that pinned the wipe to the worker.
        // After the merge fix, the LATEST writer still wins the stamp;
        // the merge doesn't accidentally inherit the prior writer.
        await mutateAgents(
          localPath,
          (c) => {
            c.phil = validAgent({ bio: "phil" });
            return c;
          },
          "dashboard:operator",
        );
        expect(readSettings(localPath).meta.updatedBy).toBe("dashboard:operator");

        await writeSettings(localPath, {
          agents: { alice: validAgent({ bio: "alice" }) },
          writtenBy: "setup",
        });

        const s = readSettings(localPath);
        expect(s.meta.updatedBy).toBe("setup");
        // phil still present — the writer stamp changed, the data didn't.
        expect(s.agents?.phil?.bio).toBe("phil");
      });
    });

    it("does not throw on totally bogus agents shape — degrades to empty map", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({ overrides: {}, agents: 42, agentDefaults: "wat" }),
      );
      const s = readSettings(localPath);
      expect(s.agents).toEqual({});
      expect(s.agentDefaults?.prepMode).toBe("combined");
    });
  });

  // ============================================================
  // DX-292 Phase 1 — agentDefaults.prepMode + agents.<name>.broken
  // ============================================================

  describe("DX-292: agentDefaults.prepMode", () => {
    it("defaults to 'combined' when the field is missing from disk", () => {
      // No file at all → defaultSettings()
      expect(getPrepMode(localPath)).toBe("combined");

      // agentDefaults block present but prepMode missing → still combined.
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agentDefaults: {},
          meta: { updatedAt: "2026-05-08T12:00:00Z", updatedBy: "worker" },
        }),
      );
      expect(getPrepMode(localPath)).toBe("combined");
    });

    it("round-trips 'separate' through writeSettings", async () => {
      await writeSettings(localPath, {
        agentDefaults: { prepMode: "separate" },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.agentDefaults?.prepMode).toBe("separate");
      // Reader observes the round-tripped value.
      expect(getPrepMode(localPath)).toBe("separate");
    });

    it("normalizes unknown prepMode values back to 'combined' (drop-on-fail)", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agentDefaults: { prepMode: "wat" },
          meta: { updatedAt: "2026-05-08T12:00:00Z", updatedBy: "worker" },
        }),
      );
      const s = readSettings(localPath);
      expect(s.agentDefaults?.prepMode).toBe("combined");
      expect(getPrepMode(localPath)).toBe("combined");
    });

    it("getPrepMode degrades to 'combined' on corrupt JSON (never throws)", () => {
      writeFileSync(settingsFilePath(localPath), "not json");
      expect(getPrepMode(localPath)).toBe("combined");
    });

    it("defaultSettings().agentDefaults.prepMode === 'combined' (direct invariant pin)", () => {
      // Direct schema-default pin so a future bump (e.g. flipping to
      // "separate" by mistake) fails loudly here instead of changing
      // production behavior silently.
      expect(defaultSettings().agentDefaults?.prepMode).toBe("combined");
    });

    it("setting prepMode then mutateAgents preserves it across the mutation", async () => {
      await writeSettings(localPath, {
        agentDefaults: { prepMode: "separate" },
        writtenBy: "dashboard:test",
      });

      // A mutateAgents call (agents-only patch) must not stomp the
      // agentDefaults block.
      await mutateAgents(
        localPath,
        (current) => current,
        "dashboard:test",
      );

      expect(getPrepMode(localPath)).toBe("separate");
    });
  });

  describe("DX-292: agents.<name>.broken field", () => {
    function validAgent(over?: Partial<AgentRecord>): AgentRecord {
      return {
        type: "agent",
        bio: "Default test bio.",
        capabilities: ["issue-worker"],
        schedule: {
          tz: "America/Chicago",
          always_on: false,
          mon: ["09:00-17:00"],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
          sun: [],
        },
        enabled: true,
        broken: null,
        strikes: { count: 0, history: [] },
        created_at: "2026-05-08T12:00:00Z",
        updated_at: "2026-05-08T12:00:00Z",
        ...over,
      };
    }

    function brokenValue(): AgentBrokenState {
      return {
        reason: "Worktree rebase aborted on conflict.",
        suggested_steps: [
          "cd <worktree>",
          "git rebase --abort",
          "git fetch origin",
        ],
        set_at: "2026-05-12T03:00:00Z",
        evaluator_status: "completed",
        evaluator_dispatch_id: null,
      };
    }

    it("agent records read from a file with no broken field default to broken: null", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: {
              type: "agent",
              bio: "x",
              capabilities: ["issue-worker"],
              schedule: {
                tz: "America/Chicago",
                always_on: false,
                mon: [],
                tue: [],
                wed: [],
                thu: [],
                fri: [],
                sat: [],
                sun: [],
              },
              enabled: true,
              created_at: "2026-05-08T12:00:00Z",
              updated_at: "2026-05-08T12:00:00Z",
            },
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.agents?.alice.broken).toBeNull();
    });

    it("round-trips a broken {reason, suggested_steps, set_at} record on disk", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:test",
      });
      await setAgentBroken(localPath, "alice", brokenValue(), "dashboard:test");

      const s = readSettings(localPath);
      expect(s.agents?.alice.broken).toEqual(brokenValue());

      const arr = readAgents(localPath);
      expect(arr).toHaveLength(1);
      expect(arr[0].broken).toEqual(brokenValue());
      expect(isAgentBroken(arr[0])).toBe(true);
    });

    it("clearing broken (setAgentBroken(..., null)) returns the agent to broken: null", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent({ broken: brokenValue() }) },
        writtenBy: "dashboard:test",
      });
      // Pre-condition: stored on disk.
      expect(readSettings(localPath).agents?.alice.broken).toEqual(brokenValue());

      await setAgentBroken(localPath, "alice", null, "dashboard:test");
      const s = readSettings(localPath);
      expect(s.agents?.alice.broken).toBeNull();
      expect(isAgentBroken(s.agents!.alice)).toBe(false);
    });

    it("isAgentBroken returns true only when broken !== null", () => {
      expect(isAgentBroken({ broken: null })).toBe(false);
      expect(isAgentBroken({ broken: brokenValue() })).toBe(true);
    });

    it("setAgentBroken rejects malformed shapes fail-loud (TypeError, no write)", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:test",
      });

      // Non-object scalars (string / number) — exercises the
      // `typeof broken !== "object"` branch in validateBrokenInput.
      await expect(
        setAgentBroken(localPath, "alice", "abc" as never, "dashboard:test"),
      ).rejects.toThrow(TypeError);
      await expect(
        setAgentBroken(localPath, "alice", 42 as never, "dashboard:test"),
      ).rejects.toThrow(TypeError);

      // Missing reason
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          { suggested_steps: [], set_at: "2026-05-12T00:00:00Z" } as never,
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);

      // Empty reason
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "",
            suggested_steps: [],
            set_at: "2026-05-12T00:00:00Z",
            evaluator_status: "completed",
            evaluator_dispatch_id: null,
          },
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);

      // Missing set_at
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "x",
            suggested_steps: [],
            evaluator_status: "completed",
            evaluator_dispatch_id: null,
          } as never,
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);

      // suggested_steps not an array
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "x",
            suggested_steps: "step" as never,
            set_at: "2026-05-12T00:00:00Z",
            evaluator_status: "completed",
            evaluator_dispatch_id: null,
          },
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);

      // suggested_steps contains a non-string
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "x",
            suggested_steps: ["ok", 42 as never],
            set_at: "2026-05-12T00:00:00Z",
            evaluator_status: "completed",
            evaluator_dispatch_id: null,
          },
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);

      // None of the failed writes mutated disk.
      const s = readSettings(localPath);
      expect(s.agents?.alice.broken).toBeNull();
    });

    it("setAgentBroken throws when the agent name is unknown (no silent no-op)", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:test",
      });
      await expect(
        setAgentBroken(localPath, "ghost", brokenValue(), "dashboard:test"),
      ).rejects.toThrow(/not found/);
    });

    it("setAgentBroken bumps the agent's updated_at on each call", async () => {
      const seeded = "2026-01-01T00:00:00.000Z";
      await writeSettings(localPath, {
        agents: {
          alice: validAgent({ created_at: seeded, updated_at: seeded }),
        },
        writtenBy: "dashboard:test",
      });
      expect(readSettings(localPath).agents?.alice.updated_at).toBe(seeded);

      await setAgentBroken(localPath, "alice", brokenValue(), "dashboard:test");
      const after = readSettings(localPath).agents?.alice.updated_at;
      expect(after).not.toBe(seeded);
      // Cheap sanity: post-write stamp must parse + sort strictly after
      // the seeded one.
      expect(new Date(after ?? "").getTime()).toBeGreaterThan(
        new Date(seeded).getTime(),
      );
    });

    it("malformed broken on disk normalizes to null on read (fail-soft) without dropping the whole agent", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: {
              type: "agent",
              bio: "x",
              capabilities: ["issue-worker"],
              schedule: {
                tz: "America/Chicago",
                always_on: false,
                mon: [],
                tue: [],
                wed: [],
                thu: [],
                fri: [],
                sat: [],
                sun: [],
              },
              enabled: true,
              broken: { reason: "", suggested_steps: [], set_at: "x" },
              created_at: "2026-05-08T12:00:00Z",
              updated_at: "2026-05-08T12:00:00Z",
            },
          },
        }),
      );
      const s = readSettings(localPath);
      // Whole agent record kept; broken degraded to null.
      expect(Object.keys(s.agents ?? {})).toEqual(["alice"]);
      expect(s.agents?.alice.broken).toBeNull();
    });

    it("broken survives an unrelated overrides patch (writer-merge invariant)", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent({ broken: brokenValue() }) },
        writtenBy: "dashboard:test",
      });

      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.agents?.alice.broken).toEqual(brokenValue());
    });
  });

  // ============================================================
  // DX-364 — Phase 1 of the Strict 3-Strike Broken epic (DX-363).
  //
  // Adds two persistent fields to every `AgentRecord`:
  //
  //   - `strikes: {count, history[]}` — durable strike counter the
  //     picker reads to decide eligibility once the 3-strike policy
  //     lands in Phase 2. `count` is the source of truth; `history`
  //     is the audit trail (last 3 strikes, append-only).
  //   - `broken` gains `evaluator_status` + `evaluator_dispatch_id`
  //     so the Phase 6 banner can render the "[Re-run evaluator]"
  //     button. Legacy `broken: {reason, suggested_steps, set_at}`
  //     records (set under DX-292) back-fill to
  //     `evaluator_status: "completed"` + `evaluator_dispatch_id: null`
  //     on first read.
  //
  // Loader contract: `validateStrikes` is FAIL-LOUD (throws on
  // malformed input). The hot-path `readSettings` wraps the call in
  // `try/catch` + `log.error` so a corrupt file does not take down
  // the worker, but the named loader still throws — bugs surface fast
  // when callers exercise it directly. Mirror of the existing
  // `validateBrokenInput` / `normalizeBroken` split.
  // ============================================================

  describe("DX-364: agent.strikes field + expanded broken evaluator", () => {
    function validAgent(over?: Partial<AgentRecord>): AgentRecord {
      return {
        type: "agent",
        bio: "Default test bio.",
        capabilities: ["issue-worker"],
        schedule: {
          tz: "America/Chicago",
          always_on: false,
          mon: ["09:00-17:00"],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
          sun: [],
        },
        enabled: true,
        broken: null,
        strikes: { count: 0, history: [] },
        created_at: "2026-05-08T12:00:00Z",
        updated_at: "2026-05-08T12:00:00Z",
        ...over,
      };
    }

    function strikeEntry(over?: Partial<AgentStrikeEntry>): AgentStrikeEntry {
      return {
        dispatch_id: "11111111-2222-3333-4444-555555555555",
        issue_id: "DX-1",
        terminal_status: "failed",
        timestamp: "2026-05-12T03:00:00Z",
        raw_error: "synthetic test failure",
        ...over,
      };
    }

    // ---- strikes back-fill on read ----

    it("agent records read from a file with no strikes field default to {count: 0, history: []}", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: {
              type: "agent",
              bio: "x",
              capabilities: ["issue-worker"],
              schedule: {
                tz: "America/Chicago",
                always_on: false,
                mon: [],
                tue: [],
                wed: [],
                thu: [],
                fri: [],
                sat: [],
                sun: [],
              },
              enabled: true,
              created_at: "2026-05-08T12:00:00Z",
              updated_at: "2026-05-08T12:00:00Z",
            },
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.agents?.alice.strikes).toEqual({ count: 0, history: [] });
    });

    it("round-trips a strikes block with non-empty history through writeSettings + readSettings", async () => {
      const strikes: AgentStrikes = {
        count: 2,
        history: [strikeEntry({ issue_id: "DX-10" }), strikeEntry({ issue_id: "DX-11" })],
      };
      await writeSettings(localPath, {
        agents: { alice: validAgent({ strikes }) },
        writtenBy: "dashboard:test",
      });
      const s = readSettings(localPath);
      expect(s.agents?.alice.strikes).toEqual(strikes);
    });

    // ---- validateStrikes — fail-loud loader (AC #3) ----

    it("validateStrikes throws on non-object input (fail-loud loader)", () => {
      expect(() => validateStrikes("abc" as never)).toThrow(TypeError);
      expect(() => validateStrikes(42 as never)).toThrow(TypeError);
      expect(() => validateStrikes([] as never)).toThrow(TypeError);
    });

    it("validateStrikes throws when count is not an integer in [0, 3]", () => {
      expect(() => validateStrikes({ count: -1, history: [] })).toThrow(TypeError);
      expect(() => validateStrikes({ count: 4, history: [] })).toThrow(TypeError);
      expect(() => validateStrikes({ count: 1.5, history: [] })).toThrow(TypeError);
      expect(() => validateStrikes({ count: "1" as never, history: [] })).toThrow(TypeError);
    });

    it("validateStrikes throws when history is not an array", () => {
      expect(() => validateStrikes({ count: 0, history: "nope" as never })).toThrow(TypeError);
      expect(() => validateStrikes({ count: 0, history: {} as never })).toThrow(TypeError);
    });

    it("validateStrikes throws when history exceeds the 3-entry cap", () => {
      const entries = [strikeEntry(), strikeEntry(), strikeEntry(), strikeEntry()];
      expect(() => validateStrikes({ count: 3, history: entries })).toThrow(TypeError);
    });

    it("validateStrikes throws when a history entry is missing required fields", () => {
      // missing dispatch_id
      expect(() =>
        validateStrikes({
          count: 1,
          history: [{ issue_id: "DX-1", terminal_status: "failed", timestamp: "2026-05-12T00:00:00Z", raw_error: "" }],
        }),
      ).toThrow(TypeError);
      // unknown terminal_status
      expect(() =>
        validateStrikes({
          count: 1,
          history: [strikeEntry({ terminal_status: "weird" as never })],
        }),
      ).toThrow(TypeError);
    });

    it("validateStrikes accepts the default + a populated value (round-trip identity)", () => {
      const def = { count: 0, history: [] } as const;
      expect(validateStrikes(def)).toEqual(def);
      const populated: AgentStrikes = {
        count: 1,
        history: [strikeEntry()],
      };
      expect(validateStrikes(populated)).toEqual(populated);
    });

    it("validateStrikes(null) and validateStrikes(undefined) return defaultStrikes() (legacy back-fill window)", () => {
      // Direct invocation of the documented one-time back-fill branch.
      // Read-side already exercises this transitively via the missing-
      // strikes-on-disk test; this assertion pins the branch directly
      // so a Phase 2 caller (`recordStrike(read)`) on a legacy record
      // does not throw before the increment.
      expect(validateStrikes(null)).toEqual({ count: 0, history: [] });
      expect(validateStrikes(undefined)).toEqual({ count: 0, history: [] });
    });

    it("malformed strikes on disk normalizes to default on read (fail-soft) without dropping the whole agent", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: {
              type: "agent",
              bio: "x",
              capabilities: ["issue-worker"],
              schedule: {
                tz: "America/Chicago",
                always_on: false,
                mon: [],
                tue: [],
                wed: [],
                thu: [],
                fri: [],
                sat: [],
                sun: [],
              },
              enabled: true,
              strikes: { count: 99, history: [] },
              created_at: "2026-05-08T12:00:00Z",
              updated_at: "2026-05-08T12:00:00Z",
            },
          },
        }),
      );
      const s = readSettings(localPath);
      // Whole agent record kept; strikes degraded to the default.
      expect(Object.keys(s.agents ?? {})).toEqual(["alice"]);
      expect(s.agents?.alice.strikes).toEqual({ count: 0, history: [] });
    });

    // ---- broken evaluator back-fill (AC #2 — legacy back-fill on first read) ----

    it("legacy broken {reason, suggested_steps, set_at} back-fills evaluator_status='completed' + evaluator_dispatch_id=null on read", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: {
              type: "agent",
              bio: "x",
              capabilities: ["issue-worker"],
              schedule: {
                tz: "America/Chicago",
                always_on: false,
                mon: [],
                tue: [],
                wed: [],
                thu: [],
                fri: [],
                sat: [],
                sun: [],
              },
              enabled: true,
              broken: {
                reason: "Worktree rebase aborted.",
                suggested_steps: ["ssh worker", "git rebase --continue"],
                set_at: "2026-05-12T03:00:00Z",
              },
              created_at: "2026-05-08T12:00:00Z",
              updated_at: "2026-05-08T12:00:00Z",
            },
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.agents?.alice.broken).toEqual({
        reason: "Worktree rebase aborted.",
        suggested_steps: ["ssh worker", "git rebase --continue"],
        set_at: "2026-05-12T03:00:00Z",
        evaluator_status: "completed",
        evaluator_dispatch_id: null,
      });
    });

    it("preserves explicit evaluator_status + evaluator_dispatch_id when present on disk", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {},
          agents: {
            alice: {
              type: "agent",
              bio: "x",
              capabilities: ["issue-worker"],
              schedule: {
                tz: "America/Chicago",
                always_on: false,
                mon: [],
                tue: [],
                wed: [],
                thu: [],
                fri: [],
                sat: [],
                sun: [],
              },
              enabled: true,
              broken: {
                reason: "Triggered by 3rd strike.",
                suggested_steps: [],
                set_at: "2026-05-12T03:00:00Z",
                evaluator_status: "running",
                evaluator_dispatch_id: "abcd-efgh-1234-5678",
              },
              created_at: "2026-05-08T12:00:00Z",
              updated_at: "2026-05-08T12:00:00Z",
            },
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.agents?.alice.broken?.evaluator_status).toBe("running");
      expect(s.agents?.alice.broken?.evaluator_dispatch_id).toBe(
        "abcd-efgh-1234-5678",
      );
    });

    // ---- broken validateBrokenInput rejects malformed evaluator fields ----

    it("setAgentBroken rejects an unknown evaluator_status fail-loud", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:test",
      });
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "x",
            suggested_steps: [],
            set_at: "2026-05-12T00:00:00Z",
            evaluator_status: "weird" as never,
            evaluator_dispatch_id: null,
          },
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);
    });

    it("setAgentBroken rejects a broken payload with evaluator_status field entirely missing", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:test",
      });
      // Legacy DX-292-shaped payload (no evaluator block) hitting the
      // write surface — `validateBrokenInput` MUST reject so a Phase
      // 2/4 caller passing a stale shape gets a usable error instead
      // of a record with `evaluator_status: undefined` on disk.
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "x",
            suggested_steps: [],
            set_at: "2026-05-12T00:00:00Z",
          } as never,
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);
    });

    it("setAgentBroken rejects a non-null evaluator_dispatch_id that is not a non-empty string", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:test",
      });
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "x",
            suggested_steps: [],
            set_at: "2026-05-12T00:00:00Z",
            evaluator_status: "pending",
            evaluator_dispatch_id: "" as never,
          },
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        setAgentBroken(
          localPath,
          "alice",
          {
            reason: "x",
            suggested_steps: [],
            set_at: "2026-05-12T00:00:00Z",
            evaluator_status: "pending",
            evaluator_dispatch_id: 42 as never,
          },
          "dashboard:test",
        ),
      ).rejects.toThrow(TypeError);
    });

    it("setAgentBroken round-trips a populated broken record with evaluator fields", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:test",
      });
      const populated = {
        reason: "Triggered by 3rd strike.",
        suggested_steps: [],
        set_at: "2026-05-12T03:00:00Z",
        evaluator_status: "pending" as const,
        evaluator_dispatch_id: null,
      };
      await setAgentBroken(localPath, "alice", populated, "dashboard:test");
      const s = readSettings(localPath);
      expect(s.agents?.alice.broken).toEqual(populated);
    });

    // ---- AC #4: dashboard agents endpoint surfaces the new fields ----
    //
    // The dashboard's `GET /api/agents` and `GET /api/agents/:repo` both
    // build their response off `readSettings`, so the type-level changes
    // here automatically surface the new fields in the JSON payload. The
    // assertion below pins that contract — anyone refactoring the
    // snapshot builder must keep the new fields present on every agent
    // entry the API returns.

    it("readSettings (the snapshot source for /api/agents) surfaces strikes + evaluator fields on every agent entry", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent({ strikes: { count: 1, history: [strikeEntry()] } }) },
        writtenBy: "dashboard:test",
      });
      const s = readSettings(localPath);
      const alice = s.agents?.alice;
      expect(alice).toBeDefined();
      expect(alice?.strikes).toEqual({
        count: 1,
        history: [strikeEntry()],
      });
      // broken still null but the type carries the new evaluator fields;
      // an explicit non-null round-trip is covered above.
      expect(alice?.broken).toBeNull();
    });
  });

  // ============================================================
  // mutateAgents — DX-160 Phase 2
  //
  // Atomic per-agent mutator. Acquires the per-file lock before reading
  // so concurrent CRUD calls can't interleave their read+write phases
  // and silently lose data.
  // ============================================================

  describe("mutateAgents", () => {
    function validAgent(over?: Partial<AgentRecord>): AgentRecord {
      return {
        type: "agent",
        bio: "x",
        capabilities: ["issue-worker"],
        schedule: {
          tz: "America/Chicago",
          always_on: false,
          mon: ["09:00-17:00"],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
          sun: [],
        },
        enabled: true,
        broken: null,
        strikes: { count: 0, history: [] },
        created_at: "2026-05-08T12:00:00Z",
        updated_at: "2026-05-08T12:00:00Z",
        ...over,
      };
    }

    it("read+mutate+write inside the lock — concurrent creates do not race", async () => {
      // Two concurrent createAgent-style calls. Without the lock-protected
      // read this would lose one entry (each reads {} → adds its own → second
      // write clobbers first).
      const [a, b] = await Promise.all([
        mutateAgents(
          localPath,
          (current) => {
            current.alice = validAgent({ bio: "A" });
            return current;
          },
          "dashboard:tester",
        ),
        mutateAgents(
          localPath,
          (current) => {
            current.bob = validAgent({ bio: "B" });
            return current;
          },
          "dashboard:tester",
        ),
      ]);

      const s = readSettings(localPath);
      expect(Object.keys(s.agents ?? {}).sort()).toEqual(["alice", "bob"]);
      expect(s.agents?.alice.bio).toBe("A");
      expect(s.agents?.bob.bio).toBe("B");
      // Both `mutateAgents` resolves see the merged state once their slot
      // in the queue runs — the second writer's return reflects both.
      expect(a.agents).toBeDefined();
      expect(b.agents).toBeDefined();
    });

    it("propagates an error from the mutator without writing", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent() },
        writtenBy: "dashboard:tester",
      });
      const before = readSettings(localPath);

      await expect(
        mutateAgents(
          localPath,
          () => {
            throw new Error("conflict");
          },
          "dashboard:tester",
        ),
      ).rejects.toThrow("conflict");

      const after = readSettings(localPath);
      expect(after.agents).toEqual(before.agents);
      expect(after.meta.updatedAt).toBe(before.meta.updatedAt);
    });

    it("normalizes garbage returned by the mutator (drops bad records, keeps good ones)", async () => {
      await mutateAgents(
        localPath,
        () => ({
          // `Bad` capitalization fails the name regex → dropped on normalize.
          Bad: validAgent(),
          good: validAgent(),
        }),
        "dashboard:tester",
      );
      const s = readSettings(localPath);
      expect(Object.keys(s.agents ?? {})).toEqual(["good"]);
    });

    it("preserves overrides + display + agentDefaults across a mutation", async () => {
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        display: { worker: { port: 5562, runtime: "docker" } },
        agentDefaults: { prepMode: "separate" },
        writtenBy: "dashboard:tester",
      });

      await mutateAgents(
        localPath,
        (current) => {
          current.alice = validAgent();
          return current;
        },
        "dashboard:tester",
      );

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.display.worker?.port).toBe(5562);
      expect(s.agentDefaults?.prepMode).toBe("separate");
      expect(Object.keys(s.agents ?? {})).toEqual(["alice"]);
    });
  });

  // ============================================================
  // isValidIanaTimeZone — exported for shared use in agent-validators
  // ============================================================

  describe("isValidIanaTimeZone", () => {
    it("accepts known IANA zones", () => {
      expect(isValidIanaTimeZone("America/Chicago")).toBe(true);
      expect(isValidIanaTimeZone("UTC")).toBe(true);
    });
    it("rejects unknown zones, empty strings, and non-strings", () => {
      expect(isValidIanaTimeZone("Bogus/Place")).toBe(false);
      expect(isValidIanaTimeZone("")).toBe(false);
      expect(isValidIanaTimeZone(null)).toBe(false);
      expect(isValidIanaTimeZone(123)).toBe(false);
    });
  });

  // ============================================================
  // watchSettingsFile — Phase 4b.2 (DX-289)
  // ============================================================

  describe("watchSettingsFile", () => {
    function waitForOnChange(
      calls: string[],
      target: number,
      timeoutMs = 2000,
    ): Promise<void> {
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const poll = setInterval(() => {
          if (calls.length >= target) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(poll);
            reject(
              new Error(
                `Timed out waiting for ${target} onChange call(s); observed ${calls.length}`,
              ),
            );
          }
        }, 30);
      });
    }

    it("invokes onChange when settings.json is written", async () => {
      const calls: string[] = [];
      // Seed with an initial write so chokidar has a file to watch.
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify(defaultSettings()),
      );

      const { unwatch } = watchSettingsFile({
        localPath,
        onChange: (p) => calls.push(p),
      });

      // chokidar needs a brief moment to attach the watcher.
      await new Promise((r) => setTimeout(r, 200));

      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({ ...defaultSettings(), changedAt: Date.now() }),
      );

      await waitForOnChange(calls, 1);
      expect(calls).toContain(localPath);

      await unwatch();
    });

    it("does NOT invoke onChange when .settings.lock is created/touched", async () => {
      const calls: string[] = [];
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify(defaultSettings()),
      );

      const { unwatch } = watchSettingsFile({
        localPath,
        onChange: (p) => calls.push(p),
      });

      await new Promise((r) => setTimeout(r, 200));

      // Touch the sibling lock file — chokidar's `ignored` glob must
      // filter it out.
      writeFileSync(settingsLockPath(localPath), "");
      writeFileSync(settingsLockPath(localPath), "x");
      writeFileSync(settingsLockPath(localPath), "xy");

      // Settle interval for the awaitWriteFinish stabilityThreshold +
      // chokidar's normal event delay.
      await new Promise((r) => setTimeout(r, 700));

      expect(calls).toHaveLength(0);

      await unwatch();
    });

    it("unwatch handle stops further onChange invocations", async () => {
      const calls: string[] = [];
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify(defaultSettings()),
      );

      const { unwatch } = watchSettingsFile({
        localPath,
        onChange: (p) => calls.push(p),
      });

      await new Promise((r) => setTimeout(r, 200));

      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({ ...defaultSettings(), v: 1 }),
      );
      await waitForOnChange(calls, 1);
      const baseline = calls.length;

      await unwatch();

      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({ ...defaultSettings(), v: 2 }),
      );
      await new Promise((r) => setTimeout(r, 600));

      expect(calls.length).toBe(baseline);
    });
  });
});
