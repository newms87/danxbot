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
  isConflictCheckEnabled,
  isFeatureEnabled,
  isValidIanaTimeZone,
  mask,
  mutateAgents,
  readAgents,
  readSettings,
  settingsFilePath,
  settingsLockPath,
  syncSettingsFileOnBoot,
  writeSettings,
  type AgentRecord,
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

    it("covers all five features via the FEATURES constant", () => {
      expect(FEATURES).toEqual([
        "slack",
        "issuePoller",
        "dispatchApi",
        "ideator",
        "autoTriage",
      ]);
    });

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
  // an optional `agentDefaults` block carrying the conflictCheckEnabled
  // toggle. Validation rules (drop-on-fail unless noted as filter):
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
  // records; isConflictCheckEnabled(ctx) returns true by default.
  // ============================================================

  describe("agents schema", () => {
    function validAgent(over?: Partial<AgentRecord>): AgentRecord {
      return {
        type: "agent",
        bio: "Default test bio.",
        capabilities: ["issue-worker"],
        schedule: {
          tz: "America/Chicago",
          mon: ["09:00-17:00"],
          tue: ["09:00-17:00"],
          wed: ["09:00-17:00"],
          thu: ["09:00-17:00"],
          fri: ["09:00-12:00"],
          sat: [],
          sun: [],
        },
        enabled: true,
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

    it("isConflictCheckEnabled() defaults true when undefined and reflects explicit values", async () => {
      // Default (no agentDefaults written) → true.
      expect(isConflictCheckEnabled(localPath)).toBe(true);

      // Explicit true.
      await writeSettings(localPath, {
        agentDefaults: { conflictCheckEnabled: true },
        writtenBy: "dashboard:test",
      });
      expect(isConflictCheckEnabled(localPath)).toBe(true);

      // Explicit false.
      await writeSettings(localPath, {
        agentDefaults: { conflictCheckEnabled: false },
        writtenBy: "dashboard:test",
      });
      expect(isConflictCheckEnabled(localPath)).toBe(false);

      // Returns true on a corrupt file (fail-safe — never throws).
      writeFileSync(settingsFilePath(localPath), "not json");
      expect(isConflictCheckEnabled(localPath)).toBe(true);
    });

    it("preserves agents + agentDefaults across an unrelated overrides patch", async () => {
      await writeSettings(localPath, {
        agents: { alice: validAgent({ bio: "A" }) },
        agentDefaults: { conflictCheckEnabled: false },
        writtenBy: "dashboard:test",
      });

      // An unrelated toggle patch must not clobber agents or agentDefaults.
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.agents?.alice.bio).toBe("A");
      expect(s.agentDefaults?.conflictCheckEnabled).toBe(false);
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
      expect(s.agentDefaults?.conflictCheckEnabled).toBe(true);
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

    it("writeSettings({agents: {}}) clears every agent without touching defaults", async () => {
      await writeSettings(localPath, {
        agents: {
          alice: validAgent({ bio: "A" }),
          bob: validAgent({ bio: "B" }),
        },
        agentDefaults: { conflictCheckEnabled: false },
        writtenBy: "dashboard:test",
      });
      // Confirm seeding worked.
      expect(Object.keys(readSettings(localPath).agents ?? {})).toEqual([
        "alice",
        "bob",
      ]);

      await writeSettings(localPath, {
        agents: {},
        writtenBy: "dashboard:test",
      });
      const s = readSettings(localPath);
      expect(s.agents).toEqual({});
      // agentDefaults should NOT have been touched by an agents-only patch.
      expect(s.agentDefaults?.conflictCheckEnabled).toBe(false);
    });

    it("does not throw on totally bogus agents shape — degrades to empty map", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({ overrides: {}, agents: 42, agentDefaults: "wat" }),
      );
      const s = readSettings(localPath);
      expect(s.agents).toEqual({});
      expect(s.agentDefaults?.conflictCheckEnabled).toBe(true);
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
          mon: ["09:00-17:00"],
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
        agentDefaults: { conflictCheckEnabled: false },
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
      expect(s.agentDefaults?.conflictCheckEnabled).toBe(false);
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
});
