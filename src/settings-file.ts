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
import chokidar from "chokidar";
import { createLogger } from "./logger.js";
import type { RepoContext } from "./types.js";

const log = createLogger("settings-file");

export type Feature =
  | "slack"
  | "issuePoller"
  | "dispatchApi"
  | "ideator"
  | "autoTriage"
  | "trelloSync";

export const FEATURES: readonly Feature[] = [
  "slack",
  "issuePoller",
  "dispatchApi",
  "ideator",
  "autoTriage",
  "trelloSync",
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
  /**
   * Trello side-system pause. When `false`, every Trello inbound +
   * outbound call path no-ops for this repo. Allowed gate sites are
   * exactly THREE (see `.claude/rules/agent-dispatch.md` Forbidden
   * Patterns row + CLAUDE.md "Trello Is Background Infrastructure"):
   *
   *   1. Trello inbound module (`src/cron/inbound-fetch.ts`) — skips
   *      tracker fetch, comment pull, Needs-Help heal.
   *   2. Trello push step INSIDE reconcile (`src/issue/reconcile.ts:614`,
   *      step 7) — skips `pushTrelloDiff`. Every OTHER reconcile step
   *      (parent-derive, file move, hash diff, dispatchable fanout,
   *      `onReconcileResult` poke, parent recurse) runs unconditionally.
   *   3. Trello retry queue (`src/issue-tracker/retry-queue.ts`) —
   *      defers re-attempts of failed pushes.
   *
   * Anywhere else gating issue-tracker business logic on this flag is
   * a coupling violation. Cards continue to flow through the local YAML
   * + DB normally; the Trello board freezes at its last-synced state
   * until the toggle is re-enabled.
   *
   * Distinct from `issuePoller`, which halts the WHOLE per-tick poll
   * (including local-YAML dispatch) — `trelloSync` halts ONLY the
   * Trello legs and never blocks dispatching.
   */
  trelloSync: FeatureOverride;
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
  /**
   * DX-563 — Self-Repair display mirror for the dashboard. Worker-side
   * write mirrors `Settings.selfRepair.threshold` here so the dashboard
   * reads display-shape state from one section.
   */
  selfRepair?: SettingsDisplaySection;
}

/**
 * Self-Repair runtime config. Reserved for the rebuilt worker-fault
 * dispatcher; the card-creating dispatcher this used to drive was
 * removed (system_errors entries are now operator-viewed only via the
 * dashboard self-repair tab — no auto-dispatch). Default is 3 (see
 * {@link DEFAULT_SELF_REPAIR_THRESHOLD}).
 */
export interface SelfRepairSettings {
  threshold?: number;
}

export const DEFAULT_SELF_REPAIR_THRESHOLD = 3;

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
  /**
   * 24/7 master switch (DX-247 temp impl). When `true`, the per-day
   * window arrays are ignored by `isAgentInSchedule` — the agent is
   * always in-schedule regardless of weekday or time-of-day. When
   * `false`, the per-day arrays are consulted as before.
   *
   * Legacy schedules written before this field existed normalize to
   * `false` so existing operator-authored windows keep their original
   * semantics. New agents created via `AgentEditDrawer.vue` default to
   * `true` (24/7 on) but the per-day arrays still carry working-hour
   * defaults so toggling 24/7 off restores a usable window without the
   * operator having to retype anything.
   */
  always_on: boolean;
  mon: string[];
  tue: string[];
  wed: string[];
  thu: string[];
  fri: string[];
  sat: string[];
  sun: string[];
}

/**
 * DX-364 — outcome the strike-tally classifier records for each strike.
 * Phase 1 ships the type alias; Phase 2 wires the picker / post-dispatch
 * tally to actually map terminal dispatch states onto these values.
 *
 *  - `"failed"` — agent ended with `danxbot_complete({status:"failed"})`.
 *  - `"recovered"` — Anthropic stream-idle synthetic recover landed the
 *    dispatch on `status: "recovered"` (DX-260 chain).
 *  - `"throttled"` — rate-limit throttle killed the dispatch (DX-322).
 */
export type AgentStrikeTerminalStatus = "failed" | "recovered" | "throttled";

/**
 * DX-364 — one strike entry kept on `agents.<name>.strikes.history[]`.
 * Bounded list (last `STRIKES_HISTORY_CAP` entries — older entries
 * pruned). `raw_error` slices the last ~200 chars of the `dispatches.error`
 * column so the evaluator (Phase 4) has enough signal to triage without
 * the operator opening the dashboard.
 */
export interface AgentStrikeEntry {
  dispatch_id: string;
  issue_id: string;
  terminal_status: AgentStrikeTerminalStatus;
  timestamp: string;
  /** Up to ~200 chars from `dispatches.error`; empty string allowed. */
  raw_error: string;
}

/**
 * DX-364 — durable strike counter + history kept on every agent record.
 * `count` is the source of truth the picker consults (`>= STRIKES_MAX`
 * trips the broken stamp in Phase 2). `history` is the append-only
 * audit trail (capped at `STRIKES_HISTORY_CAP`) consumed by the
 * evaluator agent (Phase 4) and the banner UI (Phase 6).
 *
 * Fresh agents + legacy records (pre-DX-364) back-fill to
 * `{count: 0, history: []}` on first read. Strike-incrementing logic is
 * out of scope for Phase 1 — only the schema + loader land here.
 */
export interface AgentStrikes {
  count: number;
  history: AgentStrikeEntry[];
}

/**
 * DX-364 — evaluator workflow state for a populated `broken` record.
 * The Phase 6 banner reads this to decide whether to render the
 * `[Re-run evaluator]` button. Phase 4 (evaluator dispatch) is the only
 * code path that flips the value through `pending` → `running` →
 * `completed` / `failed`. Legacy `broken` records (DX-292) back-fill
 * to `"completed"` on first read so the banner shows a static state
 * instead of a stuck "running" spinner.
 */
export type AgentEvaluatorStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

/** Strike count that trips the broken stamp (Phase 2). */
export const STRIKES_MAX = 3;

/** Max entries kept on `strikes.history[]`; older entries pruned (Phase 2). */
export const STRIKES_HISTORY_CAP = 3;

/** Closed enum of values `validateStrikes` accepts for terminal_status. */
export const AGENT_STRIKE_TERMINAL_STATUSES: readonly AgentStrikeTerminalStatus[] = [
  "failed",
  "recovered",
  "throttled",
] as const;

/** Closed enum of values `validateBrokenInput` accepts for evaluator_status. */
export const AGENT_EVALUATOR_STATUSES: readonly AgentEvaluatorStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

/**
 * Fresh-agent default for `AgentRecord.strikes`. Used by the read-side
 * back-fill (legacy records missing the field) and the write-side
 * stamp (`handlePostAgent` building a new record).
 */
export function defaultStrikes(): AgentStrikes {
  return { count: 0, history: [] };
}

/**
 * DX-364 — default `{evaluator_status, evaluator_dispatch_id}` pair
 * for every call site that stamps a fresh `AgentBrokenState` outside
 * the Phase 4 evaluator workflow (prep-verdict route, queued-verdict
 * replay, sync-recovery abort). All three writers SHARE this default;
 * Phase 4 will introduce a separate evaluator-dispatching writer that
 * stamps `"pending"` instead. Extracted as a helper so a future field
 * add to the evaluator block lands in ONE place.
 */
export function defaultBrokenEvaluator(): Pick<
  AgentBrokenState,
  "evaluator_status" | "evaluator_dispatch_id"
> {
  return { evaluator_status: "completed", evaluator_dispatch_id: null };
}

/**
 * DX-292 + DX-364 — per-agent broken state. Stamped onto an `AgentRecord`
 * when a `danx-prep` dispatch ends with verdict `abort` (DX-291) OR
 * once Phase 2 lands the 3-strike auto-stamp. Cleared (set to `null`)
 * when the operator marks the agent resolved from the dashboard. The
 * poller's pick gate filters any agent with `broken !== null` out of
 * the eligible pool — see `src/poller/pick-agent.ts#pickFreeAgent`.
 *
 *  - `reason` — operator-facing headline; non-empty.
 *  - `suggested_steps` — ordered list of recovery actions (may be empty).
 *  - `set_at` — ISO 8601 stamp recorded when the state landed.
 *  - `evaluator_status` — DX-364. Workflow state the Phase 6 banner
 *    reads to render the [Re-run evaluator] button. Legacy records
 *    (DX-292 prep-verdict stamps) back-fill to `"completed"`.
 *  - `evaluator_dispatch_id` — DX-364. UUID of the most recent evaluator
 *    dispatch; `null` when none has run. Legacy records back-fill to `null`.
 */
export interface AgentBrokenState {
  reason: string;
  suggested_steps: string[];
  set_at: string;
  evaluator_status: AgentEvaluatorStatus;
  evaluator_dispatch_id: string | null;
}

export interface AgentRecord {
  type: "agent";
  bio: string;
  avatar_path?: string;
  capabilities: AgentCapability[];
  schedule: AgentSchedule;
  enabled: boolean;
  /**
   * DX-292 — `null` when the agent is healthy, populated when a prep
   * dispatch flagged the worktree as unrecoverable. The poller skips
   * any agent with `broken !== null` until the operator clears it.
   */
  broken: AgentBrokenState | null;
  /**
   * DX-364 — durable strike counter + history. Defaults to
   * `{count: 0, history: []}` for fresh agents; legacy records that
   * pre-date the field back-fill to the same default on first read.
   * Phase 2 wires the increment hook + 3-strike auto-stamp; this
   * Phase 1 ships the field so Phase 2 has somewhere to write.
   */
  strikes: AgentStrikes;
  /**
   * DX-509 — per-agent default effort label. Missing /
   * normalizer-rejected → `getAgentEffortLevel` falls back to
   * `DEFAULT_AGENT_EFFORT_LEVEL`. Dashboard PATCH writes the field via
   * `mutateAgents`; the DX-281 per-key merge keeps sibling agents and
   * sibling fields intact.
   */
  effortLevel?: EffortLevelName;
  created_at: string;
  updated_at: string;
}

/**
 * Per-repo agent-defaults block. Optional on disk, ALWAYS materialized
 * with defaults by `normalize()` so consumers can read without a
 * presence check.
 *
 * `prepMode` (DX-292) controls how the new pre-agent prep step runs:
 *   - `"combined"` — one dispatch on the worktree carrying BOTH the
 *     `danx-prep` skill body AND the card-work skill body (the prep
 *     agent transitions inline once verdict is `ok`).
 *   - `"separate"` — prep-only dispatch; verdict via
 *     `danxbot_prep_verdict`, then `danxbot_complete`. The poller
 *     re-picks the card on the next tick for the work dispatch.
 * Default: `"combined"` (cheaper, preserves prep context for the work
 * agent). See `<repo>/.danxbot/issues/closed/DX-291.yml`.
 */
export type AgentPrepMode = "combined" | "separate";

export interface AgentDefaults {
  prepMode: AgentPrepMode;
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

/**
 * DX-508 / DX-509 — operator-configurable effort ladder.
 *
 * 7 ordered slots, immutable position. Each slot maps a `name` (the
 * agent-facing label) to a `{model, effort}` pair the launcher forwards
 * at spawn time. The `effort` half is opaque at the dispatch boundary
 * (per-model knob — thinking budget for sonnet-thinking, ignored for
 * haiku, etc.); Phase 5 (DX-513) owns the model-side mapping.
 *
 * Default agent effort is `"medium"`. The DEFAULT_EFFORT_ASSIGNMENT_PROMPT
 * biases agents toward lower levels + fewer phase cards — see the
 * DX-508 epic body "Bias to encode in default prompt".
 */
export type EffortLevelName =
  | "min"
  | "very_low"
  | "low"
  | "medium"
  | "high"
  | "very_high"
  | "max";

export const EFFORT_LEVEL_NAMES: readonly EffortLevelName[] = [
  "min",
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
  "max",
] as const;

const EFFORT_LEVEL_NAMES_SET: ReadonlySet<string> = new Set(EFFORT_LEVEL_NAMES);

/** Opaque per-model knob. What each value MEANS is a per-model lookup. */
export type EffortKnob = string;

export interface EffortLevelMapping {
  name: EffortLevelName;
  model: string;
  effort: EffortKnob;
}

/**
 * Built-in default ladder. A brand-new repo with no settings.json gets
 * these values. Operator overrides land via `writeSettings({effortLevels})`
 * — the dashboard PATCH always re-sends the full 7-entry array (atomic
 * unit), so partial-row updates don't need a separate merge surface.
 */
export const DEFAULT_EFFORT_LEVELS: readonly EffortLevelMapping[] = [
  { name: "min", model: "claude-haiku-4-5", effort: "minimal" },
  { name: "very_low", model: "claude-haiku-4-5", effort: "low" },
  { name: "low", model: "claude-haiku-4-5", effort: "high" },
  { name: "medium", model: "claude-sonnet-4-6", effort: "low" },
  { name: "high", model: "claude-sonnet-4-6", effort: "medium" },
  { name: "very_high", model: "claude-sonnet-4-6", effort: "high" },
  { name: "max", model: "claude-opus-4-7", effort: "high" },
] as const;

/** Default per-agent label when `AgentRecord.effortLevel` is missing. */
export const DEFAULT_AGENT_EFFORT_LEVEL: EffortLevelName = "medium";

/**
 * Operator-tunable prompt agents read when picking an effort level for
 * a card. Bias matches the DX-508 epic "Bias to encode in default
 * prompt" section — default `medium`, bump up only for genuine depth,
 * bump down for mechanical work, prefer fewer phase cards.
 */
export const DEFAULT_EFFORT_ASSIGNMENT_PROMPT = [
  "Pick the LOWEST effort level that can plausibly complete the card.",
  "",
  "Levels are an ordered ladder: min, very_low, low, medium, high, very_high, max.",
  "",
  "Default: medium. Bump UP only when the card genuinely needs deeper reasoning —",
  "multi-file refactor, architectural decision, subtle concurrency.",
  "Bump DOWN aggressively for mechanical edits, single-file fixes, doc tweaks,",
  "well-scoped renames.",
  "",
  "Fewer phase cards is better than more. Combine phases when the combined unit",
  "still fits one commit + one TDD pass. Every phase is a fresh dispatch, fresh",
  "context load, fresh review cycle — phase fan-out is a cost multiplier.",
].join("\n");

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
  /**
   * DX-509 — operator-configurable effort ladder. Optional in the type
   * for fixture compatibility; `normalize` always materializes a length-7
   * array via per-row fallback to `DEFAULT_EFFORT_LEVELS`. Operator
   * writes go through `writeSettings({effortLevels})` (whole-array
   * replace — partial-row updates land via the dashboard PATCH that
   * re-sends the full array).
   */
  effortLevels?: EffortLevelMapping[];
  /**
   * DX-509 — operator-tunable prompt agents read when picking an
   * effort level. Optional in the type; `normalize` always materializes
   * to `DEFAULT_EFFORT_ASSIGNMENT_PROMPT` when missing / empty / wrong
   * type. Whole-string atomic replace via `writeSettings`.
   */
  effortAssignmentPrompt?: string;
  /**
   * Self-Repair runtime config. Parked — no consumer reads this today.
   * The card-creating dispatcher this used to drive was retired (DX-560)
   * and the worker-fault rebuild (DX-580) will rewire the reader.
   * Optional in the type; `normalize` always materializes `{}` so reads
   * see a stable shape. {@link DEFAULT_SELF_REPAIR_THRESHOLD} = 3.
   */
  selfRepair?: SelfRepairSettings;
  meta: SettingsMeta;
}

export interface WriteSettingsPatchOverrides {
  slack?: FeatureOverride;
  issuePoller?: IssuePollerOverride;
  dispatchApi?: FeatureOverride;
  ideator?: FeatureOverride;
  autoTriage?: FeatureOverride;
  trelloSync?: FeatureOverride;
}

export interface WriteSettingsPatch {
  overrides?: WriteSettingsPatchOverrides;
  display?: SettingsDisplay;
  /**
   * Merge entries into the agents map per-key. Patch entries win for
   * colliding keys; on-disk keys absent from the patch are PRESERVED.
   * Pass `undefined` (or omit the field) to leave the existing map
   * untouched. Empty `{}` is a no-op (nothing to merge).
   *
   * DX-281 — pre-DX-281 this was a wholesale replace, which silently
   * wiped operator-added agents whenever a setup-shaped caller passed
   * a fresh roster. Intentional clear (the only "drop on-disk entries"
   * use case) MUST go through `mutateAgents(p, () => ({}), w)` — the
   * mutator runs inside the lock and its return value replaces the map
   * verbatim, so the caller has explicitly consented to the drop.
   */
  agents?: Record<string, AgentRecord>;
  /** Patch a subset of agentDefaults; missing keys are preserved. */
  agentDefaults?: Partial<AgentDefaults>;
  /**
   * DX-509 — whole-array atomic replace. The dashboard PATCH always
   * re-sends the full 7-entry array, so partial-row updates land
   * through this single field. `undefined` (or omitted) preserves the
   * existing on-disk array.
   */
  effortLevels?: EffortLevelMapping[];
  /**
   * DX-509 — atomic string replace. `undefined` preserves the existing
   * on-disk value. Empty string normalizes to default on the next read.
   */
  effortAssignmentPrompt?: string;
  /**
   * DX-563 — atomic replace of the Self-Repair settings block.
   * `undefined` (or omitted) preserves the existing on-disk block.
   * Pass `{}` to clear the threshold back to its env default.
   */
  selfRepair?: SelfRepairSettings;
  writtenBy: SettingsWriter;
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const PARSE_ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Default block for `agentDefaults`. Used by every write-side path that
 * needs to fall back when the existing file has no block — kept as a
 * named helper so a future field addition lands in one spot instead of
 * three (defaultSettings, writeSettings merge fallback, mutateAgents
 * merge fallback).
 */
export function defaultAgentDefaults(): AgentDefaults {
  return { prepMode: "combined" };
}

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
      trelloSync: { enabled: null },
    },
    display: {},
    agents: {},
    agentDefaults: defaultAgentDefaults(),
    effortLevels: DEFAULT_EFFORT_LEVELS.map((r) => ({ ...r })),
    effortAssignmentPrompt: DEFAULT_EFFORT_ASSIGNMENT_PROMPT,
    selfRepair: {},
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
export function isValidIanaTimeZone(tz: unknown): tz is string {
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
    always_on: r.always_on === true,
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

/**
 * Normalize a `broken` field read from disk. `null` / missing → `null`.
 * Anything else MUST match the `AgentBrokenState` shape:
 *   - `reason` non-empty string
 *   - `suggested_steps` array of strings (empty allowed)
 *   - `set_at` non-empty string
 *   - `evaluator_status` — DX-364. One of `AGENT_EVALUATOR_STATUSES`.
 *     Missing / unknown → back-fill to `"completed"` (legacy DX-292
 *     records have no evaluator hook; the Phase 6 banner renders a
 *     static state for them).
 *   - `evaluator_dispatch_id` — DX-364. `string | null`. Missing /
 *     empty / non-string → back-fill to `null`.
 *
 * Malformed required fields degrade to `null` (with a log) — matches
 * the fail-soft pattern of every other reader on this hot path. The
 * write-side helper (`setAgentBroken` → `validateBrokenInput`) is the
 * fail-loud surface for malformed input.
 */
function normalizeBroken(raw: unknown): AgentBrokenState | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    log.warn(
      `agent.broken dropped — expected {reason, suggested_steps, set_at, ...} | null, got ${typeof raw}`,
    );
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.reason !== "string" || r.reason.length === 0) {
    log.warn("agent.broken dropped — reason must be a non-empty string");
    return null;
  }
  if (typeof r.set_at !== "string" || r.set_at.length === 0) {
    log.warn("agent.broken dropped — set_at must be a non-empty ISO 8601 string");
    return null;
  }
  if (!Array.isArray(r.suggested_steps)) {
    log.warn("agent.broken dropped — suggested_steps must be an array");
    return null;
  }
  const steps = r.suggested_steps.filter(
    (s): s is string => typeof s === "string",
  );

  // DX-364 — back-fill evaluator fields. Legacy DX-292 records have
  // neither; new Phase 4 records carry both.
  let evaluatorStatus: AgentEvaluatorStatus = "completed";
  if (typeof r.evaluator_status === "string") {
    if ((AGENT_EVALUATOR_STATUSES as readonly string[]).includes(r.evaluator_status)) {
      evaluatorStatus = r.evaluator_status as AgentEvaluatorStatus;
    } else {
      log.warn(
        `agent.broken.evaluator_status="${r.evaluator_status}" not in {${AGENT_EVALUATOR_STATUSES.join("|")}} — back-filling "completed"`,
      );
    }
  }
  let evaluatorDispatchId: string | null = null;
  if (typeof r.evaluator_dispatch_id === "string" && r.evaluator_dispatch_id.length > 0) {
    evaluatorDispatchId = r.evaluator_dispatch_id;
  }

  return {
    reason: r.reason,
    suggested_steps: steps,
    set_at: r.set_at,
    evaluator_status: evaluatorStatus,
    evaluator_dispatch_id: evaluatorDispatchId,
  };
}

/**
 * DX-364 — fail-loud loader for an `AgentStrikes` block. Throws
 * `TypeError` with a precise message on any malformed input. Mirror of
 * `validateBrokenInput` for the strikes side: write paths call this
 * directly (so 3-strike increments + dashboard mutations fail
 * immediately on bad data), and the read-path normalizer wraps it in
 * try/catch so the worker keeps booting against a corrupt file.
 *
 * Missing / `null` / `undefined` input is treated as "legacy record" —
 * returns `defaultStrikes()` instead of throwing — because pre-DX-364
 * agent records on disk have no `strikes` field at all and that is the
 * one-time back-fill window the entire epic is designed around. Once
 * Phase 2 starts incrementing strikes, every write goes through the
 * fail-loud surface and back-fill never re-fires for a given record.
 */
export function validateStrikes(raw: unknown): AgentStrikes {
  if (raw === null || raw === undefined) return defaultStrikes();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(
      `agent.strikes must be {count, history[]} | null — got ${
        Array.isArray(raw) ? "array" : typeof raw
      }`,
    );
  }
  const r = raw as Record<string, unknown>;
  const count = r.count;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > STRIKES_MAX
  ) {
    throw new TypeError(
      `agent.strikes.count must be an integer in [0, ${STRIKES_MAX}] — got ${
        typeof count === "number" ? count : typeof count
      }`,
    );
  }
  if (!Array.isArray(r.history)) {
    throw new TypeError(
      "agent.strikes.history must be an array of strike entries",
    );
  }
  if (r.history.length > STRIKES_HISTORY_CAP) {
    throw new TypeError(
      `agent.strikes.history capped at ${STRIKES_HISTORY_CAP} entries — got ${r.history.length}`,
    );
  }
  const history: AgentStrikeEntry[] = r.history.map((entry, i) =>
    validateStrikeEntry(entry, i),
  );
  return { count, history };
}

function validateStrikeEntry(raw: unknown, idx: number): AgentStrikeEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`agent.strikes.history[${idx}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.dispatch_id !== "string" || r.dispatch_id.length === 0) {
    throw new TypeError(
      `agent.strikes.history[${idx}].dispatch_id must be a non-empty string`,
    );
  }
  if (typeof r.issue_id !== "string" || r.issue_id.length === 0) {
    throw new TypeError(
      `agent.strikes.history[${idx}].issue_id must be a non-empty string`,
    );
  }
  if (
    typeof r.terminal_status !== "string" ||
    !(AGENT_STRIKE_TERMINAL_STATUSES as readonly string[]).includes(r.terminal_status)
  ) {
    throw new TypeError(
      `agent.strikes.history[${idx}].terminal_status must be one of {${AGENT_STRIKE_TERMINAL_STATUSES.join("|")}}`,
    );
  }
  if (typeof r.timestamp !== "string" || r.timestamp.length === 0) {
    throw new TypeError(
      `agent.strikes.history[${idx}].timestamp must be a non-empty ISO 8601 string`,
    );
  }
  if (typeof r.raw_error !== "string") {
    throw new TypeError(
      `agent.strikes.history[${idx}].raw_error must be a string (empty allowed)`,
    );
  }
  return {
    dispatch_id: r.dispatch_id,
    issue_id: r.issue_id,
    terminal_status: r.terminal_status as AgentStrikeTerminalStatus,
    timestamp: r.timestamp,
    raw_error: r.raw_error,
  };
}

/**
 * Read-path wrapper around `validateStrikes`. Hot-path readers
 * (`readSettings`, the dashboard's `GET /api/agents` snapshot) MUST
 * NOT throw on a corrupt settings file — `readSettings`'s top-level
 * contract is "never throws". Catch + log.error + degrade to default
 * so the worker keeps booting; operators see the bug fast in logs.
 *
 * Asymmetric with `normalizeBroken`: that normalizer drops to `null`
 * (the field is independently nullable on the type), while this one
 * degrades to `defaultStrikes()` (the field is REQUIRED on
 * `AgentRecord`, so `null` is not a legal value to return). Do NOT
 * "harmonize" the two — the divergence is intentional.
 */
function normalizeStrikes(raw: unknown): AgentStrikes {
  try {
    return validateStrikes(raw);
  } catch (err) {
    log.error(
      "agent.strikes malformed on disk — degrading to {count: 0, history: []}. Reason:",
      err,
    );
    return defaultStrikes();
  }
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
    broken: normalizeBroken(r.broken),
    strikes: normalizeStrikes(r.strikes),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (typeof r.avatar_path === "string" && r.avatar_path.length > 0) {
    out.avatar_path = r.avatar_path;
  }
  // DX-509 — drop unrecognized labels silently (fail-soft on read; the
  // dashboard PATCH route is the fail-loud surface for bad input).
  if (typeof r.effortLevel === "string" && EFFORT_LEVEL_NAMES_SET.has(r.effortLevel)) {
    out.effortLevel = r.effortLevel as EffortLevelName;
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

/**
 * DX-509 — fail-soft loader for the 7-entry effort ladder.
 *
 * Operator state is consulted by name (not by array index) so out-of-order
 * entries land in canonical position and missing entries fall through to
 * the default. A single malformed row downgrades that one slot to default
 * — others survive verbatim. Output is ALWAYS length 7 with names in
 * canonical order, so callers (and `resolveEffortToFlags`) can iterate
 * without a presence check.
 */
function normalizeEffortLevels(raw: unknown): EffortLevelMapping[] {
  const operatorByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== "string" || !EFFORT_LEVEL_NAMES_SET.has(e.name)) continue;
      // First-wins on duplicate names — matches the operator's intent
      // when the dashboard PATCH re-sends a canonical-order array.
      if (!operatorByName.has(e.name)) operatorByName.set(e.name, e);
    }
  }
  return EFFORT_LEVEL_NAMES.map((name, idx) => {
    const op = operatorByName.get(name);
    const fallback = DEFAULT_EFFORT_LEVELS[idx];
    if (!op) return { ...fallback };
    if (typeof op.model !== "string" || op.model.length === 0) return { ...fallback };
    if (typeof op.effort !== "string" || op.effort.length === 0) return { ...fallback };
    return { name, model: op.model, effort: op.effort };
  });
}

/**
 * DX-509 — fail-soft loader for the operator prompt. Empty / non-string
 * fall through to the built-in default.
 */
function normalizeEffortAssignmentPrompt(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_EFFORT_ASSIGNMENT_PROMPT;
  }
  return raw;
}

function normalizeAgentDefaults(raw: unknown): AgentDefaults {
  let prepMode: AgentPrepMode = "combined";
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.prepMode === "combined" || r.prepMode === "separate") {
      prepMode = r.prepMode;
    }
  }
  return { prepMode };
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
      trelloSync: normalizeOverride(partial.overrides?.trelloSync),
    },
    display:
      partial.display && typeof partial.display === "object"
        ? partial.display
        : {},
    agents: normalizeAgents(partial.agents),
    agentDefaults: normalizeAgentDefaults(partial.agentDefaults),
    effortLevels: normalizeEffortLevels(partial.effortLevels),
    effortAssignmentPrompt: normalizeEffortAssignmentPrompt(
      partial.effortAssignmentPrompt,
    ),
    selfRepair: normalizeSelfRepair(partial.selfRepair),
    meta,
  };
}

function normalizeSelfRepair(value: unknown): SelfRepairSettings {
  if (typeof value !== "object" || value === null) return {};
  const raw = (value as { threshold?: unknown }).threshold;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return { threshold: Math.floor(raw) };
  }
  return {};
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

/**
 * Per-file (== per-repo, since there is exactly one settings.json per
 * connected repo) mutex around every settings write. Mirrors the
 * dashboard's DX-236 per-issue-id mutex pattern: one promise chain per
 * file path, so concurrent writes from the same process serialize
 * before they even reach the cross-process `.settings.lock` file. The
 * combined guarantee — in-process queue + file lock + atomic
 * tmp+rename — satisfies the DX-281 "worker-side per-id mutex around
 * settings writes" AC.
 */
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
        trelloSync:
          patch.overrides?.trelloSync ?? existing.overrides.trelloSync,
      },
      display: patch.display
        ? { ...existing.display, ...patch.display }
        : existing.display,
      // DX-281 — merge `patch.agents` per-key into the locked on-disk
      // read instead of wholesale-replacing. Pre-DX-281 the writer
      // replaced the whole map, so a caller passing {alice} silently
      // wiped operator-added entries on disk (phil disappeared mid-
      // test-system runs). Post-DX-281 patch wins per-key but on-disk-
      // only keys (operator additions) ALWAYS survive. The empty-patch
      // ({agents: {}}) case becomes a no-op for agents; intentional
      // clear goes through `mutateAgents(p, () => ({}), w)` — the only
      // API that can drop on-disk entries, and only by explicitly
      // returning an empty map from inside the lock. See
      // `.claude/rules/settings-file.md` writer-merge invariant.
      agents:
        patch.agents !== undefined
          ? normalizeAgents({ ...(existing.agents ?? {}), ...patch.agents })
          : (existing.agents ?? {}),
      agentDefaults: patch.agentDefaults
        ? {
            ...(existing.agentDefaults ?? defaultAgentDefaults()),
            ...patch.agentDefaults,
          }
        : (existing.agentDefaults ?? defaultAgentDefaults()),
      // DX-509 — whole-array atomic replace. Dashboard PATCH always
      // re-sends the full 7-entry array, so partial-row updates land
      // through this single field. `undefined` (or omitted) preserves
      // the existing on-disk array. `normalize` re-runs on read so a
      // partially-malformed write self-heals per-row on next read.
      // `existing` flows through `safeParse → normalize`, so
      // `existing.effortLevels` is always materialized (length 7) —
      // no `?? DEFAULT_*` fallback required.
      effortLevels:
        patch.effortLevels !== undefined
          ? normalizeEffortLevels(patch.effortLevels)
          : existing.effortLevels!,
      effortAssignmentPrompt:
        patch.effortAssignmentPrompt !== undefined
          ? normalizeEffortAssignmentPrompt(patch.effortAssignmentPrompt)
          : existing.effortAssignmentPrompt!,
      // DX-563 — atomic replace via normalize. `undefined` preserves the
      // on-disk block; passing `{}` (the empty SelfRepairSettings)
      // explicitly clears any prior threshold override.
      selfRepair:
        patch.selfRepair !== undefined
          ? normalizeSelfRepair(patch.selfRepair)
          : (existing.selfRepair ?? {}),
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
    case "trelloSync":
      // DX-302 — the env default for "should Trello sync run" is the
      // same boolean the env-level `DANX_TRELLO_ENABLED` carries on
      // `RepoContext`. Operators flip the override to false when they
      // want to halt sync without touching `.env` + restarting; null
      // (the default) defers to env.
      return ctx.trelloEnabled;
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
 * The poller calls this on every tick (`src/cron/sync-and-audit.ts#runSync`) so
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
 * Atomic per-agent mutation. Runs `read → mutate → write` INSIDE the
 * per-file lock so concurrent CRUD on the agents map can't lose data.
 *
 * Post-DX-281 `writeSettings({agents})` is a per-key MERGE (patch wins
 * for colliding keys, on-disk-only keys preserved). That covers
 * setup/seed flows and concurrent dashboard add/update — both safe
 * under the file lock + in-process queue. `mutateAgents` exists for
 * the two cases the merge shape cannot express:
 *   1. INTENTIONAL DROP of on-disk entries — return value replaces
 *      the map verbatim, so `() => ({})` clears it, `(c) => { delete
 *      c.alice; return c }` removes one entry.
 *   2. REJECT mid-mutation based on existing state — throwing from
 *      the mutator (e.g. for `409 duplicate name` after seeing the
 *      key already on disk) propagates the error without writing.
 *
 * Lock semantics: acquired BEFORE the read, held across the mutator,
 * released after the write. The mutator is given the on-disk agents
 * map (a fresh shallow copy; mutations are safe) and returns the next
 * map. The return value is normalized through the same validation
 * pipeline as the public write surface; passing a record with garbage
 * in `capabilities` results in the record being dropped exactly as a
 * hand-edited bad JSON file would. Callers should validate at the
 * HTTP boundary BEFORE the mutator runs.
 */
export async function mutateAgents(
  localPath: string,
  mutator: (current: Record<string, AgentRecord>) => Record<string, AgentRecord>,
  writtenBy: SettingsWriter,
): Promise<Settings> {
  return enqueueWrite(localPath, async () => {
    const path = settingsFilePath(localPath);
    const lockFile = settingsLockPath(localPath);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const release = await acquireFileLock(lockFile);
    try {
      const existing = existsSync(path) ? safeParse(path) : defaultSettings();
      // Pass a shallow copy so callers can mutate freely without
      // worrying about whether a defensive `{...x}` was applied.
      const next = mutator({ ...(existing.agents ?? {}) });

      const merged: Settings = {
        overrides: existing.overrides,
        display: existing.display,
        agents: normalizeAgents(next),
        agentDefaults: existing.agentDefaults ?? defaultAgentDefaults(),
        // DX-509 — `mutateAgents` only touches the agents map; the
        // ladder + prompt come through from disk unchanged. `existing`
        // is `safeParse → normalize` output (or `defaultSettings()`),
        // so both fields are always materialized — no fallback needed.
        effortLevels: existing.effortLevels!,
        effortAssignmentPrompt: existing.effortAssignmentPrompt!,
        selfRepair: existing.selfRepair ?? {},
        meta: { updatedAt: new Date().toISOString(), updatedBy: writtenBy },
      };
      const body = JSON.stringify(merged, null, 2) + "\n";
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, body, "utf-8");
      renameSync(tmp, path);
      return merged;
    } finally {
      await release();
    }
  });
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
 * DX-302 — `trelloSync` override-only reader for call sites that don't
 * carry a full `RepoContext`. Returns `true` ONLY when the operator has
 * explicitly set `overrides.trelloSync.enabled: false` in
 * `<repo>/.danxbot/settings.json`; `null` (defer to env), `true`
 * (explicit on), or any read error returns `false` (i.e. NOT disabled).
 *
 * Used by the retry queue + reconcile step 7 (outbound mirror push) —
 * call sites that have a `repoLocalPath` but not the surrounding
 * `RepoContext` carrying `trelloEnabled`. Per-tick callers with a full
 * `RepoContext` (the poller, the worker's auto-sync) should call
 * `isFeatureEnabled(ctx, "trelloSync")` instead so the env-default path
 * also fires when override is null.
 *
 * Never throws — read failures degrade to "not disabled" so a broken
 * settings file can't paint every retry as permanently disabled and
 * silently drop tracker pushes for the duration of the corruption.
 */
export function isTrelloSyncOverrideDisabled(localPath: string): boolean {
  try {
    const settings = readSettings(localPath);
    return settings.overrides.trelloSync.enabled === false;
  } catch (err) {
    log.error(
      `isTrelloSyncOverrideDisabled threw — returning false for ${localPath}`,
      err,
    );
    return false;
  }
}

/**
 * DX-292 — return the per-repo `prepMode` controlling whether the new
 * pre-agent prep step runs combined-with-work (`"combined"`) or as a
 * separate dispatch (`"separate"`). Defaults to `"combined"` when the
 * file is missing, the field is unset, or the JSON is corrupt. Never
 * throws — matches the fail-soft semantics of every other hot-path
 * reader in this module so a broken settings file can't take down the
 * dispatch path.
 */
export function getPrepMode(localPath: string): AgentPrepMode {
  try {
    const settings = readSettings(localPath);
    return settings.agentDefaults?.prepMode ?? "combined";
  } catch (err) {
    log.error(`getPrepMode threw — returning "combined" for ${localPath}`, err);
    return "combined";
  }
}

/**
 * DX-509 — return the 7-entry effort ladder, with per-row fallback to
 * `DEFAULT_EFFORT_LEVELS`. Operator value rounds-trips verbatim when
 * complete + well-formed; a single malformed row downgrades that one
 * slot to default. Output is ALWAYS length 7 with names in canonical
 * order. Never throws — all failure modes degrade to the built-in
 * default array.
 */
export function getEffortLevels(localPath: string): EffortLevelMapping[] {
  try {
    const settings = readSettings(localPath);
    return (
      settings.effortLevels ?? DEFAULT_EFFORT_LEVELS.map((r) => ({ ...r }))
    );
  } catch (err) {
    log.error(
      `getEffortLevels threw — returning default ladder for ${localPath}`,
      err,
    );
    return DEFAULT_EFFORT_LEVELS.map((r) => ({ ...r }));
  }
}

/**
 * DX-509 — return the operator's effort-assignment prompt, or the
 * built-in default when missing / empty / wrong type. Never throws —
 * a corrupt settings file degrades to the built-in default so the
 * agent-prompt path can't break on bad operator data.
 */
export function getEffortAssignmentPrompt(localPath: string): string {
  try {
    const settings = readSettings(localPath);
    return settings.effortAssignmentPrompt ?? DEFAULT_EFFORT_ASSIGNMENT_PROMPT;
  } catch (err) {
    log.error(
      `getEffortAssignmentPrompt threw — returning default for ${localPath}`,
      err,
    );
    return DEFAULT_EFFORT_ASSIGNMENT_PROMPT;
  }
}

/**
 * DX-509 — return a single agent's default effort label. Falls back to
 * `DEFAULT_AGENT_EFFORT_LEVEL` when the agent is absent or its record
 * has no `effortLevel` field. Never throws.
 */
export function getAgentEffortLevel(
  localPath: string,
  agentName: string,
): EffortLevelName {
  try {
    const settings = readSettings(localPath);
    return settings.agents?.[agentName]?.effortLevel ?? DEFAULT_AGENT_EFFORT_LEVEL;
  } catch (err) {
    log.error(
      `getAgentEffortLevel threw — returning "${DEFAULT_AGENT_EFFORT_LEVEL}" for ${localPath}#${agentName}`,
      err,
    );
    return DEFAULT_AGENT_EFFORT_LEVEL;
  }
}

/**
 * DX-509 — resolve an effort label to the `{model, effort}` pair the
 * launcher forwards at spawn time. Unknown labels fall back to the
 * ladder's `medium` slot (which itself is the operator's medium row
 * when configured, else the built-in default). Single source of truth
 * for the dispatch boundary — Phase 5 (DX-513) callers use this rather
 * than indexing into the ladder themselves.
 *
 * Accepts `EffortLevelName` at the type level; callers feeding raw
 * strings from disk (YAML `effort_level`, dashboard POST body) should
 * validate at their boundary or cast — the runtime contract handles
 * unknowns via the medium-fallback so a misconfigured card cannot
 * crash dispatch.
 *
 * Pure-ish — reads the settings file once per call. Never throws —
 * `getEffortLevels` guarantees a length-7 ladder containing every
 * canonical name, so the medium lookup always succeeds.
 */
export function resolveEffortToFlags(
  localPath: string,
  levelName: EffortLevelName,
): { model: string; effort: EffortKnob } {
  const levels = getEffortLevels(localPath);
  const match = levels.find((l) => l.name === levelName);
  if (match) return { model: match.model, effort: match.effort };
  // `getEffortLevels` invariant: length 7, canonical names. The medium
  // row is always present — non-null assertion is the fail-loud signal
  // if a future refactor breaks the invariant.
  const medium = levels.find((l) => l.name === "medium")!;
  return { model: medium.model, effort: medium.effort };
}

/**
 * DX-292 — predicate used by the poller's pick gate
 * (`src/poller/pick-agent.ts#pickFreeAgent`) to skip agents whose prep
 * dispatch flagged the worktree as unrecoverable. Pure — no IO. Used
 * over a bare `record.broken !== null` check at call sites so a future
 * "broken with auto-clear after TTL" extension lands in one place.
 */
export function isAgentBroken(record: { broken: AgentBrokenState | null }): boolean {
  return record.broken !== null;
}

/**
 * Validate a candidate `AgentBrokenState | null`. Throws if the shape
 * is malformed. Used by `setAgentBroken` to fail-loud at the write
 * surface — agents calling through this helper get a usable error
 * instead of silently dropping the broken record on the next read.
 */
function validateBrokenInput(
  broken: AgentBrokenState | null,
): asserts broken is AgentBrokenState | null {
  if (broken === null) return;
  if (typeof broken !== "object") {
    throw new TypeError(
      `setAgentBroken: broken must be null or {reason, suggested_steps, set_at} — got ${typeof broken}`,
    );
  }
  if (typeof broken.reason !== "string" || broken.reason.length === 0) {
    throw new TypeError(
      "setAgentBroken: broken.reason must be a non-empty string",
    );
  }
  if (typeof broken.set_at !== "string" || broken.set_at.length === 0) {
    throw new TypeError(
      "setAgentBroken: broken.set_at must be a non-empty ISO 8601 string",
    );
  }
  if (!Array.isArray(broken.suggested_steps)) {
    throw new TypeError(
      "setAgentBroken: broken.suggested_steps must be an array",
    );
  }
  for (const step of broken.suggested_steps) {
    if (typeof step !== "string") {
      throw new TypeError(
        "setAgentBroken: every entry in broken.suggested_steps must be a string",
      );
    }
  }
  // DX-364 — evaluator fields. Write callers MUST supply both; the
  // read-side back-fill is the one-time legacy migration and not a
  // license to omit on write.
  if (
    typeof broken.evaluator_status !== "string" ||
    !(AGENT_EVALUATOR_STATUSES as readonly string[]).includes(broken.evaluator_status)
  ) {
    throw new TypeError(
      `setAgentBroken: broken.evaluator_status must be one of {${AGENT_EVALUATOR_STATUSES.join("|")}}`,
    );
  }
  if (broken.evaluator_dispatch_id !== null) {
    if (
      typeof broken.evaluator_dispatch_id !== "string" ||
      broken.evaluator_dispatch_id.length === 0
    ) {
      throw new TypeError(
        "setAgentBroken: broken.evaluator_dispatch_id must be null or a non-empty string",
      );
    }
  }
}

/**
 * DX-292 — set or clear the `broken` field on a single agent. The
 * direct write surface used by:
 *   - the prep MCP verdict handler when prep returns `abort` (Phase 5).
 *   - dashboard PATCH routes that mark an agent broken or resolve it
 *     (Phase 7).
 *
 * Validates the shape fail-loud (throws `TypeError` on malformed input)
 * BEFORE acquiring the per-file lock, so a bad request never even
 * touches disk. Returns the refreshed `Settings` post-write.
 *
 * Unknown agent name → throws (no silent no-op) so a caller mis-typing
 * the agent gets a usable error instead of believing the write
 * succeeded.
 */
export async function setAgentBroken(
  localPath: string,
  agentName: string,
  broken: AgentBrokenState | null,
  writtenBy: SettingsWriter,
): Promise<Settings> {
  validateBrokenInput(broken);
  return mutateAgents(
    localPath,
    (current) => {
      const record = current[agentName];
      if (!record) {
        throw new Error(
          `setAgentBroken: agent "${agentName}" not found in roster`,
        );
      }
      current[agentName] = {
        ...record,
        broken,
        updated_at: new Date().toISOString(),
      };
      return current;
    },
    writtenBy,
  );
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
      apiToken: mask(ctx.trello.apiToken),
      boardId: ctx.trello.boardId,
      todoListId: ctx.trello.todoListId,
      inProgressListId: ctx.trello.inProgressListId,
      doneListId: ctx.trello.doneListId,
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

/**
 * Phase 4b.2 (DX-289) of the Event-Driven Worker epic. Chokidar-watches
 * `<repo>/.danxbot/settings.json` and fires `onChange(localPath)` on
 * every emit. The sibling `.settings.lock` file MUST NOT trigger
 * onChange — it ticks every dashboard write and would double-fire the
 * scheduler's roster-rebuild path. Chokidar's `ignored` option filters
 * it out (path-substring match — covers both `.settings.lock` and any
 * future lock-file companion that starts the same way).
 *
 * The caller is responsible for the debounce: chokidar fires `change`
 * for every fs event, and an in-flight settings write that produces
 * two file writes (atomic tmp+rename → two `add` + one `unlink`) will
 * surface multiple events. The downstream consumer
 * (`scheduler.onAgentRosterChange`) coalesces back-to-back fires the
 * same way `onReconcileResult` does for reconcile.
 *
 * Returns an `unwatch` handle that drains the chokidar watcher when
 * called. Caller (`bootScheduler`) stashes the handle per-repo so
 * worker shutdown can `await unwatch()` cleanly.
 *
 * Errors from the chokidar handler are caught and logged — a single
 * `onChange` throw must not poison the watcher.
 */
export function watchSettingsFile(args: {
  localPath: string;
  onChange: (localPath: string) => void;
}): { unwatch: () => Promise<void> } {
  const { localPath, onChange } = args;
  const settingsPath = settingsFilePath(localPath);
  const watcher = chokidar.watch(settingsPath, {
    // Ignore the lock-file companion. `ignored` accepts an array of
    // path matchers; the function form runs per-path so we can match
    // any path whose basename starts with `.settings.lock`.
    ignored: (path: string) => path.endsWith(".settings.lock"),
    // Only emit after a settings write fully settles. The dashboard's
    // atomic tmp + rename produces a rename event that lands as a
    // `change` once the tmp file is in place; 200ms is the same
    // debounce the issues-mirror chokidar config uses for fan-in.
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
    // We poll for new file creation but `awaitWriteFinish` handles
    // settled-state. Initial `add` events suppressed via
    // `ignoreInitial: true` so a boot-time scan does not fire onChange
    // for the existing file.
    ignoreInitial: true,
  });

  watcher.on("add", (path) => {
    try {
      onChange(localPath);
    } catch (err) {
      log.error(
        `[settings-watch] ${localPath}: onChange threw for add ${path}`,
        err,
      );
    }
  });
  watcher.on("change", (path) => {
    try {
      onChange(localPath);
    } catch (err) {
      log.error(
        `[settings-watch] ${localPath}: onChange threw for change ${path}`,
        err,
      );
    }
  });
  watcher.on("error", (err) => {
    log.error(`[settings-watch] ${localPath}: chokidar emitted error`, err);
  });

  return {
    async unwatch() {
      await watcher.close();
    },
  };
}
