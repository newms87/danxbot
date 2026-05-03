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
 * - Worker self-seeds `display` via `syncSettingsFileOnBoot` on every boot
 *   (creates the file when missing; refreshes `display` while preserving
 *   `overrides`).
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

export type Feature = "slack" | "trelloPoller" | "dispatchApi" | "ideator";

export const FEATURES: readonly Feature[] = [
  "slack",
  "trelloPoller",
  "dispatchApi",
  "ideator",
] as const;

/**
 * Who last wrote `settings.json`. Dashboard writes carry the operator's
 * username (`dashboard:<username>`) so toggles are attributable; machine
 * writers (`deploy`, `setup`, `worker`) have no identity to record.
 * See `.claude/rules/settings-file.md`.
 */
export type SettingsWriter = `${typeof DASHBOARD_PREFIX}${string}` | "deploy" | "setup" | "worker";

/**
 * Literal prefix for dashboard writers. Kept as a constant so the
 * runtime validator (`normalizeUpdatedBy`) and the route handler that
 * stamps the field both reference the same source of truth.
 */
export const DASHBOARD_PREFIX = "dashboard:" as const;

export interface FeatureOverride {
  enabled: boolean | null;
}

/**
 * Trello-poller-specific override carrying both the standard `enabled`
 * toggle and the optional `pickupNamePrefix` filter. When the prefix is
 * a non-empty string, the poller only picks up ToDo cards whose name
 * starts with it — used for system-test isolation so a fixture card
 * doesn't race real ToDo cards. `null`/missing means "no filter".
 *
 * Lives on the `trelloPoller` slot of `SettingsOverrides` so the rest
 * of the override surface stays a flat enabled-toggle. See
 * `.claude/rules/settings-file.md` for the full schema contract.
 */
export interface TrelloPollerOverride extends FeatureOverride {
  pickupNamePrefix?: string | null;
}

export interface SettingsOverrides {
  slack: FeatureOverride;
  trelloPoller: TrelloPollerOverride;
  dispatchApi: FeatureOverride;
  ideator: FeatureOverride;
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

export interface WriteSettingsPatchOverrides {
  slack?: FeatureOverride;
  trelloPoller?: TrelloPollerOverride;
  dispatchApi?: FeatureOverride;
  ideator?: FeatureOverride;
}

export interface WriteSettingsPatch {
  overrides?: WriteSettingsPatchOverrides;
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
      trelloPoller: { enabled: null, pickupNamePrefix: null },
      dispatchApi: { enabled: null },
      ideator: { enabled: null },
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

/**
 * Accept `<DASHBOARD_PREFIX><username>` or one of the machine-writer
 * literals. Anything else (including a bare `"dashboard"` or a prefix
 * with an empty username) returns null so `normalize()` falls back to
 * the default writer — the next write stamps the canonical shape.
 */
function normalizeUpdatedBy(raw: unknown): SettingsWriter | null {
  if (typeof raw !== "string") return null;
  if (raw === "deploy" || raw === "setup" || raw === "worker") return raw;
  if (raw.startsWith(DASHBOARD_PREFIX) && raw.length > DASHBOARD_PREFIX.length) {
    return raw as `${typeof DASHBOARD_PREFIX}${string}`;
  }
  return null;
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

/** Validate a `pickupNamePrefix`. Anything that isn't a string normalizes
 * to null; an empty string also normalizes to null so consumers can use
 * `if (prefix)` as the "filter active" check without a separate
 * length-zero special case. */
function normalizePickupNamePrefix(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

function normalizeTrelloPollerOverride(raw: unknown): TrelloPollerOverride {
  const base = normalizeOverride(raw);
  let pickupNamePrefix: string | null = null;
  if (raw && typeof raw === "object" && "pickupNamePrefix" in raw) {
    pickupNamePrefix = normalizePickupNamePrefix(
      (raw as { pickupNamePrefix?: unknown }).pickupNamePrefix,
    );
  }
  return { enabled: base.enabled, pickupNamePrefix };
}

function normalize(partial: Partial<Settings> | null | undefined): Settings {
  const d = defaultSettings();
  if (!partial || typeof partial !== "object") return d;

  const meta: SettingsMeta = {
    updatedAt:
      typeof partial.meta?.updatedAt === "string"
        ? partial.meta.updatedAt
        : d.meta.updatedAt,
    updatedBy: normalizeUpdatedBy(partial.meta?.updatedBy) ?? d.meta.updatedBy,
  };

  return {
    overrides: {
      slack: normalizeOverride(partial.overrides?.slack),
      trelloPoller: normalizeTrelloPollerOverride(
        partial.overrides?.trelloPoller,
      ),
      dispatchApi: normalizeOverride(partial.overrides?.dispatchApi),
      ideator: normalizeOverride(partial.overrides?.ideator),
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
        ideator: patch.overrides?.ideator ?? existing.overrides.ideator,
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
    case "ideator":
      // Explicit opt-in: the ideator dispatches `/danx-ideate` whenever
      // the Review list runs short and is therefore the most expensive
      // recurring spawn the poller can produce. Operators turn it on
      // per-repo from the Agents tab when they want feature generation.
      return false;
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
 * The optional "only pick up cards whose name starts with this prefix"
 * filter for the Trello poller. Reads `overrides.trelloPoller.pickupNamePrefix`
 * from the per-repo settings file. Returns the prefix when set as a
 * non-empty string; returns `null` when the file is missing, the prefix
 * is unset / null / empty / non-string, or any read error occurs.
 *
 * The poller calls this on every tick (`src/poller/index.ts#_poll`) so
 * the test harness can write the prefix, run a fixture card through the
 * dispatch path in isolation, and clear the prefix on cleanup — all
 * without needing to drain or cancel pre-existing ToDo cards. Without
 * this filter the system test races real cards and times out (Trello
 * card `IleofrBj`).
 *
 * Never throws — on any failure returns `null` so the poller's
 * "no filter" path runs instead of breaking the tick.
 */
export function getTrelloPollerPickupPrefix(
  localPath: string,
): string | null {
  try {
    const settings = readSettings(localPath);
    return settings.overrides.trelloPoller.pickupNamePrefix ?? null;
  } catch (err) {
    log.error(
      `getTrelloPollerPickupPrefix threw — returning null for ${localPath}`,
      err,
    );
    return null;
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

/** Reset module state for testing. Do not call in production. */
export function _resetForTesting(): void {
  lastParseErrorLogTs.clear();
  inProcessQueues.clear();
}
