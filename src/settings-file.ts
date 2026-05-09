/**
 * Per-repo settings file at `<repo>/.danxbot/settings.json`.
 *
 * Source of truth for runtime feature toggles (Slack / issue poller /
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

export type Feature =
  | "slack"
  | "issuePoller"
  | "dispatchApi"
  | "ideator"
  | "autoTriage";

export const FEATURES: readonly Feature[] = [
  "slack",
  "issuePoller",
  "dispatchApi",
  "ideator",
  "autoTriage",
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
 * Issue-poller-specific override carrying both the standard `enabled`
 * toggle and the optional `pickupNamePrefix` filter. When the prefix is
 * a non-empty string, the poller only picks up ToDo cards whose name
 * starts with it — used for system-test isolation so a fixture card
 * doesn't race real ToDo cards. `null`/missing means "no filter".
 *
 * Lives on the `issuePoller` slot of `SettingsOverrides` so the rest
 * of the override surface stays a flat enabled-toggle. See
 * `.claude/rules/settings-file.md` for the full schema contract.
 */
export interface IssuePollerOverride extends FeatureOverride {
  pickupNamePrefix?: string | null;
}

export interface SettingsOverrides {
  slack: FeatureOverride;
  issuePoller: IssuePollerOverride;
  dispatchApi: FeatureOverride;
  ideator: FeatureOverride;
  autoTriage: FeatureOverride;
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

/**
 * Multi-worker agent — DX-159 / DX-158 epic.
 *
 * Each entry is keyed by the agent's name in the agents map. Names are
 * URL/branch/path-safe (`^[a-z][a-z0-9_-]{0,31}$`) because they're used as
 * git branch names, worktree directory names, and container hostnames.
 *
 * Validation lives in `normalize()`; invalid records are dropped from the
 * in-memory shape with a log warning rather than throwing — the file
 * remains source of truth and operators fix via the dashboard or a
 * hand-edit. Phase 1 only ships the schema + per-repo Settings/Agents
 * UI restructure; the CRUD UI + dispatch wiring lands in DX-160+.
 */
export type AgentCapability = "issue-worker" | "slack" | "api";

export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "issue-worker",
  "slack",
  "api",
] as const;

export interface AgentSchedule {
  tz: string;
  mon: string[];
  tue: string[];
  wed: string[];
  thu: string[];
  fri: string[];
  sat: string[];
  sun: string[];
}

export interface AgentRecord {
  type: "agent";
  bio: string;
  avatar_path?: string;
  capabilities: AgentCapability[];
  schedule: AgentSchedule;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentDefaults {
  conflictCheckEnabled: boolean;
}

/**
 * `readAgents` shape: `AgentRecord` enriched with the map key as `name`,
 * suitable for direct iteration by callers that need both pieces.
 */
export interface AgentRecordWithName extends AgentRecord {
  name: string;
}

/** Max agents per repo. Hard cap — entries beyond this are dropped on read. */
export const AGENTS_MAX = 5;

/** URL/branch/path-safe agent name shape. */
export const AGENT_NAME_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

/** HH:MM-HH:MM, 24-hour, both ends optional minute leading zero handled. */
export const SCHEDULE_WINDOW_SHAPE =
  /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export interface Settings {
  overrides: SettingsOverrides;
  display: SettingsDisplay;
  /**
   * Map of agent records keyed by agent name. Optional in the type so
   * test fixtures and pre-Phase-1 file shapes type-check without the
   * field, but `readSettings` / `normalize` ALWAYS materialize an empty
   * `{}` so production reads can rely on the field being present.
   * Treat the `?` as a structural-typing accommodation, not a
   * "sometimes missing in memory" signal.
   */
  agents?: Record<string, AgentRecord>;
  agentDefaults?: AgentDefaults;
  meta: SettingsMeta;
}

export interface WriteSettingsPatchOverrides {
  slack?: FeatureOverride;
  issuePoller?: IssuePollerOverride;
  dispatchApi?: FeatureOverride;
  ideator?: FeatureOverride;
  autoTriage?: FeatureOverride;
}

export interface WriteSettingsPatch {
  overrides?: WriteSettingsPatchOverrides;
  display?: SettingsDisplay;
  /**
   * Replace the entire agents map. Pass an empty object to clear all
   * agents. Pass `undefined` (or omit the field) to leave the existing
   * map untouched. Per-record patching lives in DX-160's CRUD routes;
   * the schema-level write is a wholesale replace by design.
   */
  agents?: Record<string, AgentRecord>;
  /** Patch a subset of agentDefaults; missing keys are preserved. */
  agentDefaults?: Partial<AgentDefaults>;
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
      issuePoller: { enabled: null, pickupNamePrefix: null },
      dispatchApi: { enabled: null },
      ideator: { enabled: null },
      autoTriage: { enabled: null },
    },
    display: {},
    agents: {},
    agentDefaults: { conflictCheckEnabled: true },
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

function normalizeIssuePollerOverride(raw: unknown): IssuePollerOverride {
  const base = normalizeOverride(raw);
  let pickupNamePrefix: string | null = null;
  if (raw && typeof raw === "object" && "pickupNamePrefix" in raw) {
    pickupNamePrefix = normalizePickupNamePrefix(
      (raw as { pickupNamePrefix?: unknown }).pickupNamePrefix,
    );
  }
  return { enabled: base.enabled, pickupNamePrefix };
}

/**
 * Validate an IANA time zone string. Falsy / non-string / unknown zones
 * return `false`. Uses `Intl.DateTimeFormat` which throws RangeError for
 * any value the platform does not recognize as an IANA name; on Node
 * 20+ this matches the system tzdata.
 */
function isValidIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Filter an unknown windows array to the subset that match
 * `SCHEDULE_WINDOW_SHAPE`. Non-array input returns `[]` so the caller
 * always receives a fresh array safe to mutate. Empty array is the
 * documented "off" state and is preserved.
 */
function normalizeScheduleDay(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (w): w is string => typeof w === "string" && SCHEDULE_WINDOW_SHAPE.test(w),
  );
}

function normalizeSchedule(raw: unknown): AgentSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isValidIanaTimeZone(r.tz)) return null;
  return {
    tz: r.tz,
    mon: normalizeScheduleDay(r.mon),
    tue: normalizeScheduleDay(r.tue),
    wed: normalizeScheduleDay(r.wed),
    thu: normalizeScheduleDay(r.thu),
    fri: normalizeScheduleDay(r.fri),
    sat: normalizeScheduleDay(r.sat),
    sun: normalizeScheduleDay(r.sun),
  };
}

function normalizeCapabilities(raw: unknown): AgentCapability[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(AGENT_CAPABILITIES);
  return raw.filter((c): c is AgentCapability => typeof c === "string" && known.has(c));
}

function normalizeOneAgent(raw: unknown): AgentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // Discriminator — keep forward-compat with future entry shapes the file
  // might host (e.g. service accounts) by rejecting anything that isn't
  // explicitly tagged as an agent record.
  if (r.type !== "agent") return null;
  if (typeof r.bio !== "string") return null;
  if (typeof r.enabled !== "boolean") return null;
  if (typeof r.created_at !== "string") return null;
  if (typeof r.updated_at !== "string") return null;

  const capabilities = normalizeCapabilities(r.capabilities);
  if (capabilities.length === 0) return null;

  const schedule = normalizeSchedule(r.schedule);
  if (!schedule) return null;

  const out: AgentRecord = {
    type: "agent",
    bio: r.bio,
    capabilities,
    schedule,
    enabled: r.enabled,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (typeof r.avatar_path === "string" && r.avatar_path.length > 0) {
    out.avatar_path = r.avatar_path;
  }
  return out;
}

function normalizeAgents(raw: unknown): Record<string, AgentRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AgentRecord> = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= AGENTS_MAX) {
      log.warn(
        `agents map exceeds ${AGENTS_MAX}-entry cap — dropping "${name}" and remaining entries`,
      );
      break;
    }
    if (!AGENT_NAME_SHAPE.test(name)) {
      log.warn(
        `agents.${name} dropped — name must match ${AGENT_NAME_SHAPE} (URL/branch/path-safe)`,
      );
      continue;
    }
    const record = normalizeOneAgent(value);
    if (!record) {
      log.warn(`agents.${name} dropped — invalid record shape (capabilities/schedule/required-fields)`);
      continue;
    }
    out[name] = record;
    count += 1;
  }
  return out;
}

function normalizeAgentDefaults(raw: unknown): AgentDefaults {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.conflictCheckEnabled === "boolean") {
      return { conflictCheckEnabled: r.conflictCheckEnabled };
    }
  }
  return { conflictCheckEnabled: true };
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
      // Legacy-key migration: pre-rename settings.json files carry
      // `overrides.trelloPoller`. Read it as a fallback when the new
      // `issuePoller` slot is absent so deployed boxes keep their
      // operator toggles + pickupNamePrefix across the rename. Write-
      // side never emits the legacy key, so the next write
      // canonicalizes the file. Retire the fallback in a follow-up
      // card after one release.
      issuePoller: normalizeIssuePollerOverride(
        partial.overrides?.issuePoller ??
          (partial.overrides as { trelloPoller?: unknown } | undefined)
            ?.trelloPoller,
      ),
      dispatchApi: normalizeOverride(partial.overrides?.dispatchApi),
      ideator: normalizeOverride(partial.overrides?.ideator),
      autoTriage: normalizeOverride(partial.overrides?.autoTriage),
    },
    display:
      partial.display && typeof partial.display === "object"
        ? partial.display
        : {},
    agents: normalizeAgents(partial.agents),
    agentDefaults: normalizeAgentDefaults(partial.agentDefaults),
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
        issuePoller:
          patch.overrides?.issuePoller ?? existing.overrides.issuePoller,
        dispatchApi:
          patch.overrides?.dispatchApi ?? existing.overrides.dispatchApi,
        ideator: patch.overrides?.ideator ?? existing.overrides.ideator,
        autoTriage:
          patch.overrides?.autoTriage ?? existing.overrides.autoTriage,
      },
      display: patch.display
        ? { ...existing.display, ...patch.display }
        : existing.display,
      agents:
        patch.agents !== undefined
          ? normalizeAgents(patch.agents)
          : (existing.agents ?? {}),
      agentDefaults: patch.agentDefaults
        ? {
            ...(existing.agentDefaults ?? { conflictCheckEnabled: true }),
            ...patch.agentDefaults,
          }
        : (existing.agentDefaults ?? { conflictCheckEnabled: true }),
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
    case "issuePoller":
      return ctx.trelloEnabled;
    case "dispatchApi":
      return true;
    case "ideator":
      // Explicit opt-in: the ideator dispatches `/danx-ideate` whenever
      // the Review list runs short and is therefore the most expensive
      // recurring spawn the poller can produce. Operators turn it on
      // per-repo from the Agents tab when they want feature generation.
      return false;
    case "autoTriage":
      // Explicit opt-in: same rationale as ideator — the auto-triage
      // poller spawns `/danx-triage-card` per eligible Review /
      // Needs Help / Blocked card whose `triage.expires_at` is in the
      // past, a recurring agent dispatch that costs tokens. Operators
      // turn it on per-repo from the Agents tab.
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
 * filter for the issue poller. Reads `overrides.issuePoller.pickupNamePrefix`
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
export function getIssuePollerPickupPrefix(
  localPath: string,
): string | null {
  try {
    const settings = readSettings(localPath);
    return settings.overrides.issuePoller.pickupNamePrefix ?? null;
  } catch (err) {
    log.error(
      `getIssuePollerPickupPrefix threw — returning null for ${localPath}`,
      err,
    );
    return null;
  }
}

/**
 * Return the agents map as an array of records enriched with their map
 * key as `name`. Stable insertion order — matches the on-disk JSON
 * iteration. Empty array when no agents are configured. Never throws —
 * read failure / corrupt JSON / unknown shape all degrade to `[]` so a
 * misconfigured file can't take down dispatch wiring downstream.
 */
export function readAgents(localPath: string): AgentRecordWithName[] {
  try {
    const settings = readSettings(localPath);
    return Object.entries(settings.agents ?? {}).map(([name, record]) => ({
      name,
      ...record,
    }));
  } catch (err) {
    log.error(`readAgents threw — returning [] for ${localPath}`, err);
    return [];
  }
}

/**
 * Return whether triage-precursor conflict-check should run for this
 * repo. Defaults to `true` when the file is missing, the key is unset,
 * or the JSON is corrupt — the conservative "extra LLM call per
 * dispatch" branch keeps multi-worker safety on by default. Operators
 * opt OUT explicitly via the dashboard for cost-sensitive ops.
 */
export function isConflictCheckEnabled(localPath: string): boolean {
  try {
    const settings = readSettings(localPath);
    return settings.agentDefaults?.conflictCheckEnabled ?? true;
  } catch (err) {
    log.error(
      `isConflictCheckEnabled threw — returning true for ${localPath}`,
      err,
    );
    return true;
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
