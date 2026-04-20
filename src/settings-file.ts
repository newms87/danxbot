/**
 * Per-repo settings file at `<repo>/.danxbot/settings.json`.
 *
 * Source of truth for runtime feature toggles (Slack / Trello poller /
 * dispatch API) and masked-config mirrors the dashboard displays. Full
 * design in `docs/superpowers/specs/2026-04-20-agents-tab-design.md` and
 * `.claude/rules/settings-file.md`.
 *
 * Ownership:
 * - Workers READ on every event via `isFeatureEnabled(ctx, feature)`.
 * - Dashboard, deploy, and setup WRITE via `writeSettings`. Dashboard only
 *   ever writes `overrides`; deploy and setup only ever write `display`.
 * - Worker self-seeds `display` via `ensureSettingsFile` on first boot when
 *   the file is missing.
 *
 * Contracts:
 * - `overrides.<feature>.enabled` is three-valued: `true`/`false` is an
 *   explicit override, `null` defers to the env default carried on
 *   `RepoContext`. No secrets land in this file — only masked mirrors.
 * - `readSettings` never throws: missing file or corrupt JSON fall back to
 *   defaults, with one log per minute per path on parse errors.
 * - `writeSettings` is atomic (tmp + rename) and serialized by a per-file
 *   lock at `<repo>/.danxbot/.settings.lock`, plus an in-process promise
 *   chain keyed by path so multiple concurrent writes from the same
 *   process don't race each other on the filesystem.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createLogger } from "./logger.js";
import type { RepoContext } from "./types.js";

const log = createLogger("settings-file");

export type Feature = "slack" | "trelloPoller" | "dispatchApi";

export const FEATURES: readonly Feature[] = [
  "slack",
  "trelloPoller",
  "dispatchApi",
] as const;

export type SettingsWriter = "dashboard" | "deploy" | "setup" | "worker";

export interface FeatureOverride {
  enabled: boolean | null;
}

export interface SettingsOverrides {
  slack: FeatureOverride;
  trelloPoller: FeatureOverride;
  dispatchApi: FeatureOverride;
}

export interface SettingsDisplayWorker {
  port?: number;
  runtime?: "docker" | "host";
}

export interface SettingsDisplaySection {
  configured?: boolean;
  [key: string]: unknown;
}

export interface SettingsDisplay {
  worker?: SettingsDisplayWorker;
  slack?: SettingsDisplaySection;
  trello?: SettingsDisplaySection;
  github?: SettingsDisplaySection;
  db?: SettingsDisplaySection;
  links?: Record<string, string>;
}

export interface SettingsMeta {
  updatedAt: string;
  updatedBy: SettingsWriter;
}

export interface Settings {
  overrides: SettingsOverrides;
  display: SettingsDisplay;
  meta: SettingsMeta;
}

export interface WriteSettingsPatch {
  overrides?: Partial<SettingsOverrides>;
  display?: SettingsDisplay;
  writtenBy: SettingsWriter;
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const PARSE_ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Default settings for a repo that has never been seeded. All overrides
 * null (defer to env defaults) and empty display (dashboard will render
 * "not configured" pills until setup/deploy populates it).
 */
export function defaultSettings(): Settings {
  return {
    overrides: {
      slack: { enabled: null },
      trelloPoller: { enabled: null },
      dispatchApi: { enabled: null },
    },
    display: {},
    meta: { updatedAt: new Date(0).toISOString(), updatedBy: "worker" },
  };
}

export function settingsFilePath(localPath: string): string {
  return resolve(localPath, ".danxbot/settings.json");
}

export function settingsLockPath(localPath: string): string {
  return resolve(localPath, ".danxbot/.settings.lock");
}

/** One log entry per file per PARSE_ERROR_LOG_INTERVAL_MS. */
const lastParseErrorLogTs = new Map<string, number>();

function logParseErrorOnce(filePath: string, err: unknown): void {
  const now = Date.now();
  const last = lastParseErrorLogTs.get(filePath) ?? 0;
  if (now - last < PARSE_ERROR_LOG_INTERVAL_MS) return;
  lastParseErrorLogTs.set(filePath, now);
  log.warn(
    `Failed to parse ${filePath} — falling back to defaults. Fix or delete to reset.`,
    err,
  );
}

function normalizeOverride(raw: unknown): FeatureOverride {
  if (raw && typeof raw === "object" && "enabled" in raw) {
    const enabled = (raw as FeatureOverride).enabled;
    if (enabled === true || enabled === false || enabled === null) {
      return { enabled };
    }
  }
  return { enabled: null };
}

function normalize(partial: Partial<Settings> | null | undefined): Settings {
  const d = defaultSettings();
  if (!partial || typeof partial !== "object") return d;

  const meta: SettingsMeta = {
    updatedAt:
      typeof partial.meta?.updatedAt === "string"
        ? partial.meta.updatedAt
        : d.meta.updatedAt,
    updatedBy:
      partial.meta?.updatedBy === "dashboard" ||
      partial.meta?.updatedBy === "deploy" ||
      partial.meta?.updatedBy === "setup" ||
      partial.meta?.updatedBy === "worker"
        ? partial.meta.updatedBy
        : d.meta.updatedBy,
  };

  return {
    overrides: {
      slack: normalizeOverride(partial.overrides?.slack),
      trelloPoller: normalizeOverride(partial.overrides?.trelloPoller),
      dispatchApi: normalizeOverride(partial.overrides?.dispatchApi),
    },
    display:
      partial.display && typeof partial.display === "object"
        ? partial.display
        : {},
    meta,
  };
}

/**
 * Read settings from disk. Never throws — missing file returns defaults,
 * corrupt JSON logs once per minute and returns defaults.
 */
export function readSettings(localPath: string): Settings {
  const path = settingsFilePath(localPath);
  if (!existsSync(path)) return defaultSettings();
  try {
    const raw = readFileSync(path, "utf-8");
    return normalize(JSON.parse(raw) as Partial<Settings>);
  } catch (err) {
    logParseErrorOnce(path, err);
    return defaultSettings();
  }
}

/**
 * Write settings to disk. Merges `patch` on top of the current on-disk
 * state, stamps meta, writes atomically via tmp+rename, and serializes
 * concurrent writes via a per-file lock.
 *
 * `overrides` is shallowly merged per-feature (absent features keep their
 * current value). `display` is shallowly merged at the section level so
 * deploy's "refresh masks" pass and setup's initial seed both leave
 * unrelated sections alone.
 */
export async function writeSettings(
  localPath: string,
  patch: WriteSettingsPatch,
): Promise<Settings> {
  return enqueueWrite(localPath, () => runWrite(localPath, patch));
}

/** One promise chain per absolute file path, so concurrent writes from
 * the same process serialize before they even reach the file lock. */
const inProcessQueues = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(
  localPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = settingsFilePath(localPath);
  const prev = (inProcessQueues.get(key) ?? Promise.resolve()) as Promise<unknown>;
  // Chain on `prev` regardless of fate — we want the next write to run
  // even if the previous one rejected. The same `next` reference is both
  // stored in the map AND used by the tail-cleanup comparison below, so
  // a later writer that replaces us won't be erroneously evicted.
  const next = prev.then(run, run);
  inProcessQueues.set(key, next);
  next.finally(() => {
    if (inProcessQueues.get(key) === next) {
      inProcessQueues.delete(key);
    }
  }).catch(() => undefined);
  return next;
}

async function runWrite(
  localPath: string,
  patch: WriteSettingsPatch,
): Promise<Settings> {
  const path = settingsFilePath(localPath);
  const lockFile = settingsLockPath(localPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const release = await acquireFileLock(lockFile);
  try {
    const existing = existsSync(path)
      ? safeParse(path)
      : defaultSettings();

    const merged: Settings = {
      overrides: {
        slack: patch.overrides?.slack ?? existing.overrides.slack,
        trelloPoller:
          patch.overrides?.trelloPoller ?? existing.overrides.trelloPoller,
        dispatchApi:
          patch.overrides?.dispatchApi ?? existing.overrides.dispatchApi,
      },
      display: patch.display
        ? { ...existing.display, ...patch.display }
        : existing.display,
      meta: {
        updatedAt: new Date().toISOString(),
        updatedBy: patch.writtenBy,
      },
    };

    const body = JSON.stringify(merged, null, 2) + "\n";
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, path);
    return merged;
  } finally {
    await release();
  }
}

function safeParse(path: string): Settings {
  try {
    return normalize(JSON.parse(readFileSync(path, "utf-8")) as Partial<Settings>);
  } catch (err) {
    logParseErrorOnce(path, err);
    return defaultSettings();
  }
}

/**
 * Atomic per-file lock. `fs.open(path, "wx")` fails with EEXIST when the
 * file already exists; retry with exponential backoff up to LOCK_TIMEOUT_MS.
 * A lock file older than LOCK_STALE_MS is assumed to be a crashed holder
 * and is stolen.
 */
async function acquireFileLock(lockFile: string): Promise<() => Promise<void>> {
  const dir = dirname(lockFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  while (true) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.write(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      return async () => {
        try {
          unlinkSync(lockFile);
        } catch {
          /* best-effort — another steal may have unlinked first */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      try {
        const stat = statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          log.warn(
            `Stealing stale settings lock at ${lockFile} (age ${Math.round(
              (Date.now() - stat.mtimeMs) / 1000,
            )}s)`,
          );
          try {
            unlinkSync(lockFile);
          } catch {
            /* ignore */
          }
          continue;
        }
      } catch {
        /* stat failed — race with another holder; just retry */
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timeout acquiring settings lock at ${lockFile} after ${LOCK_TIMEOUT_MS}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/**
 * Env-default for a feature when the settings override is null. This is
 * the "what does RepoContext alone say" answer — used both when the
 * settings file is missing and when an override is explicitly `null`.
 */
function envDefault(ctx: RepoContext, feature: Feature): boolean {
  switch (feature) {
    case "slack":
      return ctx.slack.enabled;
    case "trelloPoller":
      return ctx.trelloEnabled;
    case "dispatchApi":
      return true;
  }
}

/**
 * The hot path. Called by Slack listener, poller tick, and /api/launch
 * handler on every event. Never throws — on any failure we log and return
 * the env default so a broken settings file can't take down a worker.
 */
export function isFeatureEnabled(ctx: RepoContext, feature: Feature): boolean {
  try {
    const settings = readSettings(ctx.localPath);
    const override = settings.overrides[feature].enabled;
    if (override === null) return envDefault(ctx, feature);
    return override;
  } catch (err) {
    log.error(
      `isFeatureEnabled(${feature}) threw — returning env default for ${ctx.name}`,
      err,
    );
    return envDefault(ctx, feature);
  }
}

/**
 * Mask a secret for display. Format: `"abcd****wxyz"` when long enough to
 * show both ends, otherwise `"****xyz"` with the trailing fragment. Empty
 * or non-string inputs return `""`.
 */
export function mask(value: unknown, visible = 4): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : String(value);
  if (str.length === 0) return "";
  if (visible <= 0) return "****";
  if (str.length <= visible * 2) {
    return `****${str.slice(-Math.min(visible, str.length))}`;
  }
  return `${str.slice(0, visible)}****${str.slice(-visible)}`;
}

/**
 * Build a `display` snapshot from a RepoContext. Used by the worker's
 * self-seed on first boot and by deploy/setup when they materialize
 * masked config. No raw secrets are included — only masked prefixes.
 */
export function buildDisplayFromContext(
  ctx: RepoContext,
  runtime: "docker" | "host",
): SettingsDisplay {
  return {
    worker: { port: ctx.workerPort, runtime },
    slack: {
      botToken: mask(ctx.slack.botToken),
      channelId: ctx.slack.channelId,
      configured: ctx.slack.enabled,
    },
    trello: {
      apiKey: mask(ctx.trello.apiKey),
      boardId: ctx.trello.boardId,
      configured: !!(ctx.trello.apiKey && ctx.trello.apiToken),
    },
    github: {
      token: mask(ctx.githubToken),
      configured: !!ctx.githubToken,
    },
    db: {
      host: ctx.db.host,
      database: ctx.db.database,
      configured: ctx.db.enabled,
    },
    links: {
      trelloBoardUrl: ctx.trello.boardId
        ? `https://trello.com/b/${ctx.trello.boardId}`
        : "",
      slackChannelUrl: "",
      githubUrl: ctx.url,
    },
  };
}

/**
 * Sync the `display` section from the current `RepoContext` on every
 * worker boot. Creates the file on first boot and refreshes `display`
 * on every subsequent boot so deploys (which always restart the
 * worker) automatically surface the latest masked config to the
 * dashboard — without a separate remote command that duplicates the
 * display-building logic.
 *
 * `overrides` is NEVER touched: operator toggles in
 * `.danxbot/settings.json` survive every deploy and every restart.
 * See `.claude/rules/settings-file.md` for the full contract.
 */
export async function syncSettingsFileOnBoot(
  ctx: RepoContext,
  runtime: "docker" | "host",
): Promise<void> {
  await writeSettings(ctx.localPath, {
    display: buildDisplayFromContext(ctx, runtime),
    writtenBy: "worker",
  });
}

/**
 * @deprecated Use `syncSettingsFileOnBoot` — first-boot-only semantics
 * were insufficient because display values drift after a redeploy with
 * a new worker port / runtime / mask. The new name signals that this
 * runs every boot, preserves overrides, and refreshes display.
 */
export async function ensureSettingsFile(
  ctx: RepoContext,
  runtime: "docker" | "host",
): Promise<void> {
  await syncSettingsFileOnBoot(ctx, runtime);
}

/** Reset module state for testing. Do not call in production. */
export function _resetForTesting(): void {
  lastParseErrorLogTs.clear();
  inProcessQueues.clear();
}
