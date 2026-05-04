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
  getTrelloPollerPickupPrefix,
  isFeatureEnabled,
  mask,
  readSettings,
  settingsFilePath,
  settingsLockPath,
  syncSettingsFileOnBoot,
  writeSettings,
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
      expect(s.overrides.trelloPoller.enabled).toBeNull();
      expect(s.overrides.dispatchApi.enabled).toBeNull();
    });

    it("parses a well-formed file", () => {
      const body: Settings = {
        overrides: {
          slack: { enabled: false },
          trelloPoller: { enabled: true },
          dispatchApi: { enabled: null },
          ideator: { enabled: null },
        },
        display: { worker: { port: 1234, runtime: "host" } },
        meta: { updatedAt: "2026-04-20T00:00:00Z", updatedBy: "dashboard:alice" },
      };
      writeFileSync(settingsFilePath(localPath), JSON.stringify(body));

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.overrides.trelloPoller.enabled).toBe(true);
      expect(s.overrides.dispatchApi.enabled).toBeNull();
      expect(s.display.worker).toEqual({ port: 1234, runtime: "host" });
      expect(s.meta.updatedBy).toBe("dashboard:alice");
    });

    it("returns defaults on corrupt JSON without throwing", () => {
      writeFileSync(settingsFilePath(localPath), "{not json");
      const s = readSettings(localPath);
      expect(s).toEqual(defaultSettings());
    });

    it("normalizes unknown override shapes to null", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: "yes" }, // not a boolean/null
            trelloPoller: null,
            dispatchApi: 42,
          },
        }),
      );
      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBeNull();
      expect(s.overrides.trelloPoller.enabled).toBeNull();
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
      expect(s.overrides.trelloPoller.enabled).toBeNull();
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
          trelloPoller: { enabled: true },
        },
        writtenBy: "setup",
      });

      await writeSettings(localPath, {
        overrides: { dispatchApi: { enabled: false } },
        writtenBy: "dashboard:test",
      });

      const s = readSettings(localPath);
      expect(s.overrides.slack.enabled).toBe(false);
      expect(s.overrides.trelloPoller.enabled).toBe(true);
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
            trelloPoller: { enabled: null },
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
      expect(isFeatureEnabled(ctxOn, "trelloPoller")).toBe(false);
      // dispatchApi env default is always true
      expect(isFeatureEnabled(ctxOn, "dispatchApi")).toBe(true);
    });

    it("returns override value when override is true", async () => {
      await writeSettings(localPath, {
        overrides: { trelloPoller: { enabled: true } },
        writtenBy: "dashboard:test",
      });
      const ctx = makeRepoContext({ localPath, trelloEnabled: false });
      expect(isFeatureEnabled(ctx, "trelloPoller")).toBe(true);
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
      expect(isFeatureEnabled(ctx, "trelloPoller")).toBe(true);
    });

    it("covers all four features via the FEATURES constant", () => {
      expect(FEATURES).toEqual([
        "slack",
        "trelloPoller",
        "dispatchApi",
        "ideator",
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
  // getTrelloPollerPickupPrefix() — test isolation hook
  // ============================================================

  describe("getTrelloPollerPickupPrefix", () => {
    it("returns null when settings file is missing", () => {
      expect(getTrelloPollerPickupPrefix(localPath)).toBeNull();
    });

    it("returns null when prefix is unset", async () => {
      await writeSettings(localPath, {
        overrides: { trelloPoller: { enabled: true } },
        writtenBy: "setup",
      });
      expect(getTrelloPollerPickupPrefix(localPath)).toBeNull();
    });

    it("returns the prefix when set as a non-empty string", async () => {
      await writeSettings(localPath, {
        overrides: {
          trelloPoller: { enabled: null, pickupNamePrefix: "[System Test]" },
        },
        writtenBy: "setup",
      });
      expect(getTrelloPollerPickupPrefix(localPath)).toBe("[System Test]");
    });

    it("returns null when prefix is empty string", async () => {
      await writeSettings(localPath, {
        overrides: {
          trelloPoller: { enabled: null, pickupNamePrefix: "" },
        },
        writtenBy: "setup",
      });
      expect(getTrelloPollerPickupPrefix(localPath)).toBeNull();
    });

    it("returns null on corrupt JSON without throwing", () => {
      writeFileSync(settingsFilePath(localPath), "not json");
      expect(getTrelloPollerPickupPrefix(localPath)).toBeNull();
    });

    it("preserves pickupNamePrefix across an unrelated override patch", async () => {
      await writeSettings(localPath, {
        overrides: {
          trelloPoller: { enabled: null, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      // Operator toggles slack — must not clobber the trelloPoller prefix.
      await writeSettings(localPath, {
        overrides: { slack: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      expect(getTrelloPollerPickupPrefix(localPath)).toBe("[X]");
    });

    it("preserves pickupNamePrefix across a display-only patch", async () => {
      await writeSettings(localPath, {
        overrides: {
          trelloPoller: { enabled: null, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      await writeSettings(localPath, {
        display: { worker: { port: 1234, runtime: "host" } },
        writtenBy: "deploy",
      });
      expect(getTrelloPollerPickupPrefix(localPath)).toBe("[X]");
    });

    it("normalizes non-string prefix to null without throwing", () => {
      writeFileSync(
        settingsFilePath(localPath),
        JSON.stringify({
          overrides: {
            slack: { enabled: null },
            trelloPoller: { enabled: null, pickupNamePrefix: 42 },
            dispatchApi: { enabled: null },
          },
        }),
      );
      expect(getTrelloPollerPickupPrefix(localPath)).toBeNull();
    });

    it("clears pickupNamePrefix when patch sets it to null", async () => {
      await writeSettings(localPath, {
        overrides: {
          trelloPoller: { enabled: null, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      await writeSettings(localPath, {
        overrides: {
          trelloPoller: { enabled: null, pickupNamePrefix: null },
        },
        writtenBy: "setup",
      });
      expect(getTrelloPollerPickupPrefix(localPath)).toBeNull();
    });

    it("preserves the enabled toggle when only the prefix is patched", async () => {
      await writeSettings(localPath, {
        overrides: { trelloPoller: { enabled: false } },
        writtenBy: "dashboard:test",
      });
      await writeSettings(localPath, {
        overrides: {
          trelloPoller: { enabled: false, pickupNamePrefix: "[X]" },
        },
        writtenBy: "setup",
      });
      const s = readSettings(localPath);
      expect(s.overrides.trelloPoller.enabled).toBe(false);
      expect(getTrelloPollerPickupPrefix(localPath)).toBe("[X]");
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
          trelloPoller: { enabled: false },
          dispatchApi: { enabled: null },
        },
        writtenBy: "setup",
      });
      const raw = JSON.parse(
        readFileSync(settingsFilePath(localPath), "utf-8"),
      );
      expect(raw.overrides.slack).toEqual({ enabled: true });
      expect(raw.overrides.trelloPoller).toEqual({ enabled: false });
      expect(raw.overrides.dispatchApi).toEqual({ enabled: null });
    });
  });
});
