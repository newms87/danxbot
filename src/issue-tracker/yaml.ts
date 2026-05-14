import {
  parse as parseYamlText,
  stringify as stringifyYaml,
  YAMLParseError,
} from "yaml";
import {
  EFFORT_LEVEL_NAMES,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  type CreateCardInput,
  type EffortLevelName,
  type Issue,
  type IssueAcItem,
  type Blocked,
  type WaitingOn,
  type IssueComment,
  type IssueDispatch,
  type IssueHistoryEntry,
  type IssueHistoryEvent,
  type IssueIce,
  type IssueRetro,
  type IssueStatus,
  type IssueTriage,
  type IssueTriageHistoryEntry,
  type IssueType,
  type RequiresHuman,
  type ConflictOnEntry,
} from "./interface.js";

const EFFORT_LEVEL_SET: ReadonlySet<EffortLevelName> = new Set(EFFORT_LEVEL_NAMES);

const TRIAGE_HISTORY_CAP = 10;

/**
 * Forward-compatible schema_version bounds (DX-280).
 *
 * `KNOWN_SCHEMA_MIN` is the oldest schema_version this validator still
 * accepts directly (older YAMLs are rejected with a migration pointer).
 * `KNOWN_SCHEMA_MAX` is the newest schema_version this validator was
 * built against — values ABOVE this are still accepted (forward-compat)
 * but emit a `console.warn` so consumers notice their bundled validator
 * is behind the writer.
 *
 * The drift class this prevents: the writer in `serializeIssue` /
 * `createEmptyIssue` stamps `schema_version: N` on every save; the
 * published `@thehammer/danx-issue-mcp` package bundles a validator
 * snapshot at publish time. If the writer's N is bumped without a
 * same-commit `make publish-danx-issue-mcp`, host sessions running the
 * stale npm-resolved bundle hit a hard parse error on every save round
 * trip. Before DX-280 the bound was an explicit allowlist (`v.schema_version
 * !== 3 && !== 4 && !== 5 && !== 6`) — a writer bump to 7 with the bundle
 * still at 6 made every save fail until the operator noticed and
 * republished. Forward-compat soft-degrades that into a noisy warning;
 * cards still load, agents still work, the operator still sees a clear
 * signal to republish.
 *
 * Schema bumps are increment-only and ADDITIVE — new fields default to
 * safe values on parse, removed fields are still tolerated by the
 * shape-specific validators. Breaking field-shape changes are caught by
 * the per-field validators (`validateBlocked`, `validateRequiresHuman`,
 * etc.) regardless of `schema_version`, so forward-compat does not paper
 * over real schema breaks.
 *
 * Maintenance contract: every time the writer's stamped version bumps
 * (the literal in `createEmptyIssue` + `serializeIssue` +
 * `issueToCreateInput` + the `issue.schema_version` assignment in
 * `validateIssue`), bump `KNOWN_SCHEMA_MAX` here. The DX-280 lockstep
 * test in `yaml.test.ts` pins the writer == `KNOWN_SCHEMA_MAX` invariant
 * — a one-sided bump fails the unit suite before it reaches a host
 * session.
 *
 * Schema versions:
 *  - v3: `children[]` field for two-way epic ↔ phase linkage.
 *  - v4: split `blocked` → `waiting_on` (dep-chain) + `blocked` (self-block).
 *  - v5: `priority` field.
 *  - v6: `requires_human` orthogonal indicator (DX-231).
 *  - v7: `conflict_on[]` two-way dispatch mutex.
 *  - v8: `effort_level` field (DX-508 / DX-511).
 */
export const KNOWN_SCHEMA_MIN = 3;
export const KNOWN_SCHEMA_MAX = 8;

/**
 * Set of `schema_version` values this process has already warned about.
 * `parseIssue` is on the chokidar mirror's hot path (also `/api/issues`,
 * heal pass, retry queue, sync.ts) — without dedup, a single drifted
 * worker would emit `N_cards × M_call_sites` warnings per tick, drowning
 * the operator log. One warning per distinct unknown version per
 * process lifetime is enough signal: the operator runs `make
 * publish-danx-issue-mcp` once; subsequent reads stop warning after the
 * republish makes the version known. Module-scoped (per-process), so a
 * fresh dispatch starts with an empty set and re-warns once.
 */
const warnedSchemaVersions = new Set<number>();

/**
 * Local copy of `AGENT_NAME_SHAPE` from `src/settings-file.ts` — duplicated
 * here so the YAML parser can validate `assigned_agent` (DX-200) without
 * importing the settings file (which would pull `node:fs/promises` + the
 * logger + the full per-repo settings surface into every parseIssue
 * caller). The two definitions MUST stay byte-identical; a new test in
 * `yaml.test.ts` asserts the regex source.
 */
const AGENT_NAME_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Priority field bounds + default. Operators set `priority` in the open
 * interval `(0, 6)` clamped on read to `[PRIORITY_MIN, PRIORITY_MAX]`
 * (`[0.01, 5.99]` post-DX-521); the parser clamps out-of-range values
 * and defaults missing fields to `PRIORITY_DEFAULT` so legacy v3/v4
 * YAMLs round-trip without a hard migration. The numeric range maps to
 * six labeled tiers via `priorityTier()` in `./priority-tier.ts`:
 * `lowest` `(0, 1)`, `low` `[1, 2)`, `medium` `[2, 3)`, `high`
 * `[3, 4)`, `very_high` `[4, 5)`, `critical` `[5, 5.99]`. See
 * `Issue.priority` for the full semantic. Introduced by ISS-210;
 * bounds widened from `[1.0, 5.0]` to `[0.01, 5.99]` by DX-521 to
 * accommodate the 6-tier mapping (no schema bump — the value shape
 * is unchanged, only the clamp range widened).
 */
export const PRIORITY_MIN = 0.01;
export const PRIORITY_MAX = 5.99;
export const PRIORITY_DEFAULT = 3.0;

function clampPriority(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PRIORITY_DEFAULT;
  if (raw < PRIORITY_MIN) return PRIORITY_MIN;
  if (raw > PRIORITY_MAX) return PRIORITY_MAX;
  return raw;
}
const VALID_DISPATCH_KINDS: ReadonlySet<string> = new Set([
  "work",
  "triage",
  "recovery",
]);

/**
 * Maximum number of `IssueHistoryEntry`s retained on an Issue. Enforced both
 * on parse (a legacy YAML carrying more than this drops oldest silently) and
 * on `appendHistory` (push past the cap shifts the oldest off the head).
 * Phase 1 of DX-138 — see DX-145 description for sizing rationale (1000
 * transitions on a single card means the card is mis-scoped, not that
 * history is wrong).
 */
export const HISTORY_CAP = 1000;

/**
 * Maximum length of `IssueHistoryEntry.note`. Enforced ONLY at append time
 * by `appendHistory` — the validator tolerates longer existing entries so
 * legacy YAMLs round-trip. A note longer than `HISTORY_NOTE_CAP` is
 * truncated to `HISTORY_NOTE_CAP - 1` chars + `…` ellipsis (single-char
 * Unicode ellipsis, not three dots) so the resulting string is exactly
 * `HISTORY_NOTE_CAP` chars long.
 */
export const HISTORY_NOTE_CAP = 200;

const VALID_HISTORY_EVENTS: ReadonlySet<string> = new Set([
  "created",
  "status_change",
  "blocked",
  "unblocked",
]);

/**
 * Actor-format guard for `appendHistory`. The interface JSDoc on
 * `IssueHistoryEntry.actor` promises that format enforcement happens at
 * append-time (NOT parse-time, so legacy YAMLs with future actor prefixes
 * round-trip). This regex is the load-bearing implementation of that
 * promise — Phase 2/3 callers fail loud here when they accidentally drop
 * the `:` separator or pass an empty actor.
 *
 * Accepts:
 *  - `<source>:<id>` — non-empty source, non-empty id, separated by exactly
 *    one `:`. Source/id may contain `:`; the FIRST `:` is the separator.
 *  - bare `setup` and bare `unknown` — the two grandfathered formats from
 *    the canonical actor-source table in DX-138's description.
 */
const HISTORY_ACTOR_FORMAT = /^([^:]+:.+|setup|unknown)$/;

function emptyIce(): IssueIce {
  return { total: 0, i: 0, c: 0, e: 0 };
}

function emptyTriage(): IssueTriage {
  return {
    expires_at: "",
    reassess_hint: "",
    last_status: "",
    last_explain: "",
    ice: emptyIce(),
    history: [],
  };
}

/**
 * Build a fully-populated minimal Issue from a small seed. Every required
 * field on `Issue` is filled with a deterministic default; callers that need
 * a "blank issue" should use this rather than relying on the validator to
 * fill gaps (the validator is strict and rejects missing fields outright).
 *
 * Defaults:
 *  - schema_version: 8
 *  - tracker: "memory"
 *  - id: "" (caller is responsible for assigning via nextIssueId)
 *  - external_id: ""
 *  - parent_id: null, dispatch: null
 *  - children: []
 *  - status: "ToDo"
 *  - type: "Feature"
 *  - title, description: ""
 *  - triage: empty (every field "" / 0; history: []) — re-triages on next poll
 *  - ac, comments: []
 *  - retro: { good: "", bad: "", action_item_ids: [], commits: [] }
 *  - effort_level: null (DX-508 — inherits agent default at dispatch)
 */
export function createEmptyIssue(
  seed: {
    id?: string;
    external_id?: string;
    status?: IssueStatus;
    type?: IssueType;
    title?: string;
    description?: string;
    effort_level?: EffortLevelName | null;
  } = {},
): Issue {
  return {
    schema_version: 8,
    tracker: "memory",
    id: seed.id ?? "",
    external_id: seed.external_id ?? "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: seed.status ?? "ToDo",
    type: seed.type ?? "Feature",
    title: seed.title ?? "",
    description: seed.description ?? "",
    priority: PRIORITY_DEFAULT,
    position: null,
    triage: emptyTriage(),
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: seed.effort_level ?? null,
    history: [],
  };
}

export class IssueHistoryAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueHistoryAppendError";
  }
}

/**
 * Push a new entry onto an Issue's `history[]` and apply both the rolling
 * cap and the note truncation. Pure — never mutates the input array.
 *
 *  - **Actor format**: throws `IssueHistoryAppendError` when `entry.actor`
 *    does not match `<source>:<id>` (or bare `setup` / `unknown`). The
 *    interface contract documents this as the only enforcement point —
 *    `validateHistory` (parse-time) is intentionally permissive so legacy
 *    YAMLs with future actor prefixes round-trip.
 *  - **Per-event field invariants**: throws when the event-required fields
 *    are missing. `status_change` requires both `from` and `to`;
 *    `created` / `blocked` require `to`; `unblocked` has no required
 *    transition fields. Same parse-time/append-time split as actor.
 *  - `HISTORY_CAP` rolling window: pushing past the cap drops the oldest
 *    entry (FIFO).
 *  - `HISTORY_NOTE_CAP` truncation: an entry whose `note` exceeds the cap
 *    is rewritten with `note = first (CAP - 1) chars + "…"`. Entries
 *    without a note pass through unchanged.
 *
 * Phase 2 (worker `runSync` diff) and Phase 3 (auto-derive / heal / Trello
 * hydrate) consume this helper so the cap + truncation + format logic
 * lives in exactly one place.
 */
export function appendHistory(
  history: IssueHistoryEntry[],
  entry: IssueHistoryEntry,
): IssueHistoryEntry[] {
  assertHistoryEntry(entry);
  const truncated = truncateHistoryNote(entry);
  const next = [...history, truncated];
  if (next.length > HISTORY_CAP) {
    return next.slice(next.length - HISTORY_CAP);
  }
  return next;
}

function assertHistoryEntry(entry: IssueHistoryEntry): void {
  if (!HISTORY_ACTOR_FORMAT.test(entry.actor)) {
    throw new IssueHistoryAppendError(
      `appendHistory: actor must match <source>:<id> or be bare "setup"/"unknown" (got ${JSON.stringify(entry.actor)})`,
    );
  }
  switch (entry.event) {
    case "status_change":
      if (entry.from === undefined || entry.to === undefined) {
        throw new IssueHistoryAppendError(
          `appendHistory: event=status_change requires both from and to (got from=${JSON.stringify(entry.from)} to=${JSON.stringify(entry.to)})`,
        );
      }
      break;
    case "created":
    case "blocked":
      if (entry.to === undefined) {
        throw new IssueHistoryAppendError(
          `appendHistory: event=${entry.event} requires to`,
        );
      }
      break;
    case "unblocked":
      // `unblocked` has no required transition fields per the interface
      // contract — the act of clearing `blocked` carries no status delta
      // (worker forces ToDo while blocked is set, so the post-unblock
      // status is whatever the YAML now holds, not derivable from the
      // event itself).
      break;
  }
}

function truncateHistoryNote(entry: IssueHistoryEntry): IssueHistoryEntry {
  if (entry.note === undefined) return entry;
  if (entry.note.length <= HISTORY_NOTE_CAP) return entry;
  return {
    ...entry,
    note: entry.note.slice(0, HISTORY_NOTE_CAP - 1) + "…",
  };
}

export class IssueParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueParseError";
  }
}

/**
 * Serialize an Issue into deterministic YAML. Field order is fixed so that
 * round-trip serialize → parse → serialize produces byte-identical output;
 * tests rely on this for diffing the on-disk form.
 */
export function serializeIssue(issue: Issue): string {
  // Build the document in canonical key order. yaml.stringify preserves the
  // insertion order of plain objects.
  const doc = {
    schema_version: issue.schema_version,
    tracker: issue.tracker,
    id: issue.id,
    external_id: issue.external_id,
    parent_id: issue.parent_id,
    children: [...issue.children],
    dispatch:
      issue.dispatch === null
        ? null
        : {
            id: issue.dispatch.id,
            pid: issue.dispatch.pid,
            host: issue.dispatch.host,
            kind: issue.dispatch.kind,
            started_at: issue.dispatch.started_at,
            ttl_seconds: issue.dispatch.ttl_seconds,
          },
    status: issue.status,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    position: issue.position,
    triage: {
      expires_at: issue.triage.expires_at,
      reassess_hint: issue.triage.reassess_hint,
      last_status: issue.triage.last_status,
      last_explain: issue.triage.last_explain,
      ice: {
        total: issue.triage.ice.total,
        i: issue.triage.ice.i,
        c: issue.triage.ice.c,
        e: issue.triage.ice.e,
      },
      history: issue.triage.history.map((h) => ({
        timestamp: h.timestamp,
        status: h.status,
        explain: h.explain,
        expires_at: h.expires_at,
        ice: { total: h.ice.total, i: h.ice.i, c: h.ice.c, e: h.ice.e },
      })),
    },
    ac: issue.ac.map((item) => ({
      check_item_id: item.check_item_id,
      title: item.title,
      checked: item.checked,
    })),
    comments: issue.comments.map((c) => {
      const out: Record<string, unknown> = {};
      // `id` is absent on local-only comments; preserve absence rather than
      // emitting an empty string, so sync.ts can detect un-pushed comments.
      if (c.id !== undefined) out.id = c.id;
      out.author = c.author;
      out.timestamp = c.timestamp;
      out.text = c.text;
      return out;
    }),
    history: issue.history.map((h) => {
      // Drop optional `from` / `to` / `note` when undefined so legacy entries
      // and entries that don't carry the field round-trip without growing
      // synthetic null keys (which would diverge from the byte-stable form
      // the rest of the schema commits to).
      const out: Record<string, unknown> = {
        timestamp: h.timestamp,
        actor: h.actor,
        event: h.event,
      };
      if (h.from !== undefined) out.from = h.from;
      if (h.to !== undefined) out.to = h.to;
      if (h.note !== undefined) out.note = h.note;
      return out;
    }),
    retro: {
      good: issue.retro.good,
      bad: issue.retro.bad,
      action_item_ids: [...issue.retro.action_item_ids],
      commits: [...issue.retro.commits],
    },
    // `assigned_agent` carries the persona name claiming the card or `null`
    // when no agent owns it. Serialized AFTER `retro` so existing YAMLs that
    // omit the field round-trip without churning the byte order; the v3 →
    // v6 migrations don't need a hard rewrite.
    assigned_agent: issue.assigned_agent,
    // `waiting_on` carries `null` (default) or a record with reason/timestamp/by[].
    // Position after `retro` keeps the canonical key order stable for older
    // YAMLs that omit the field — they parse with `waiting_on: null` defaulted in
    // and re-serialize at the end of the document.
    waiting_on:
      issue.waiting_on === null
        ? null
        : {
            reason: issue.waiting_on.reason,
            timestamp: issue.waiting_on.timestamp,
            by: [...issue.waiting_on.by],
          },
    // `blocked` is the self-block record. Position after `waiting_on` so a
    // reader scanning the YAML sees both parking states adjacent. `null`
    // when the card is not self-blocked. Worker enforces the invariant
    // `status === "Blocked" ⟺ blocked !== null`.
    blocked:
      issue.blocked === null
        ? null
        : {
            reason: issue.blocked.reason,
            timestamp: issue.blocked.timestamp,
          },
    // `requires_human` is the orthogonal "this card needs a human"
    // indicator (DX-231 — replaces the retired `"Needs Approval"`
    // status). Position after `blocked` so a reader scanning the YAML
    // sees every dispatch gate adjacent. Field is `null` when no human
    // action is needed. Independent from `blocked` and `waiting_on`.
    requires_human:
      issue.requires_human == null
        ? null
        : {
            reason: issue.requires_human.reason,
            steps: [...issue.requires_human.steps],
            set_by: issue.requires_human.set_by,
            set_at: issue.requires_human.set_at,
          },
    // `conflict_on` is the persistent dispatch-mutex record (v7). Each
    // entry declares a heavy-overlap pairing with another open card —
    // poller skips dispatch while any partner referenced from either
    // direction is currently In Progress. Empty array = no declared
    // conflicts. Position after `requires_human` keeps every dispatch
    // gate adjacent.
    conflict_on: issue.conflict_on.map((c) => ({
      id: c.id,
      reason: c.reason,
    })),
    // `effort_level` (v8) — one of the seven canonical EffortLevelName
    // literals or null. Position after `conflict_on` keeps the dispatch
    // gates contiguous; effort_level is a dispatch hint (not a gate) but
    // logically sits with the other dispatch-resolution fields. `null`
    // serializes as explicit YAML `null` (not absent key) so fresh
    // round-trips are stable. The type contract is `EffortLevelName |
    // null` (not optional), so we pass through verbatim — sibling fields
    // (`blocked`, `waiting_on`, `requires_human`) all use this discipline.
    effort_level: issue.effort_level,
  };

  return stringifyYaml(doc, { lineWidth: 0 });
}

/**
 * Allowed shape for any per-repo `issue_prefix` value: 2-4 uppercase ASCII
 * letters. Long enough to be visually distinct between repos
 * (`DX`/`SG`/`FD`), short enough that prefixed ids stay scannable. Lives
 * here (not in `repo-context.ts`) so `id-generator.ts` and `yaml.ts` can
 * validate prefixes without taking a dep on the env-heavy config chain.
 */
export const ISSUE_PREFIX_SHAPE = /^[A-Z]{2,4}$/;

/**
 * Required knobs accepted by `parseIssue` and `validateIssue`. The
 * `expectedPrefix` knob enforces a per-repo `<PREFIX>-<N>` id shape (e.g.
 * `DX-12`, `SG-7`). Phase 4 of DX-99 made this required — there is no
 * legacy `"ISS"` default. Every caller MUST supply the active repo's
 * prefix (typically from `RepoContext.issuePrefix`).
 */
export interface ParseIssueOptions {
  /**
   * Per-repo issue id prefix the validator enforces. 2-4 uppercase
   * letters; supplied by the caller from `RepoContext.issuePrefix`. The
   * validator builds `^${expectedPrefix}-\d+$` from this value and rejects
   * any `id` / `parent_id` / `children[i]` / `waiting_on.by[i]` /
   * `retro.action_item_ids[i]` that doesn't match.
   */
  expectedPrefix: string;
}

/**
 * Parse YAML text into an Issue, throwing IssueParseError with a useful
 * message on either malformed YAML or schema violations.
 *
 * In schema v3, `external_id` is always allowed to be empty (YAML-only
 * mode + drafts pre-create have no tracker mapping yet), so there is no
 * separate "draft" parse mode — the v1 `parseDraftIssue` is gone. The
 * primary id (`id`) is the strict required-non-empty field. v3 adds the
 * `children: string[]` field for two-way epic ↔ phase linkage.
 *
 * `options.expectedPrefix` is required (Phase 4 of DX-99 dropped the legacy
 * `"ISS"` default). Pass the active repo's prefix from
 * `RepoContext.issuePrefix`.
 */
export function parseIssue(text: string, options: ParseIssueOptions): Issue {
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new IssueParseError(`Malformed YAML: ${err.message}`);
    }
    throw new IssueParseError(`Malformed YAML: ${String(err)}`);
  }
  const result = validateIssue(raw, options);
  if (!result.ok) {
    throw new IssueParseError(
      `Invalid Issue YAML:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return result.issue;
}

/**
 * Build the per-repo issue-id regex `^<prefix>-\d+$`. The prefix MUST
 * be 2-4 uppercase ASCII letters; this function asserts that contract
 * via `ISSUE_PREFIX_SHAPE` and throws on violation rather than
 * silently producing a broken regex (e.g. `^DX-evil-\d+$` from a
 * caller that forgot to validate). Returns a fresh RegExp on every
 * call — callers that hot-loop over many ids should cache the result
 * themselves.
 */
export function buildIssueIdRegex(prefix: string): RegExp {
  if (!ISSUE_PREFIX_SHAPE.test(prefix)) {
    throw new Error(
      `buildIssueIdRegex: invalid prefix "${prefix}" — must match ${ISSUE_PREFIX_SHAPE} (2-4 uppercase ASCII letters)`,
    );
  }
  return new RegExp(`^${prefix}-\\d+$`);
}

/**
 * Project an `Issue` into the `CreateCardInput` shape the tracker accepts.
 * `check_item_id` is dropped intentionally — the tracker assigns those on
 * `createCard` and the result is stamped back into the YAML by the caller.
 * Used by every code path that pushes a fresh issue to the tracker:
 * `danx_issue_create` (worker route), poller orphan-push, and `syncIssue`'s
 * orphan-recovery branch — all funnel through this one function.
 *
 * `dispatch` is intentionally omitted — local-only metadata managed by the
 * poller; the tracker abstraction has no place to store it.
 */
export function issueToCreateInput(issue: Issue): CreateCardInput {
  return {
    schema_version: 8,
    tracker: issue.tracker,
    id: issue.id,
    parent_id: issue.parent_id,
    children: [...issue.children],
    status: issue.status,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    triage: cloneTriage(issue.triage),
    ac: issue.ac.map((a) => ({ title: a.title, checked: a.checked })),
    comments: issue.comments.map((c) => ({ ...c })),
    retro: {
      good: issue.retro.good,
      bad: issue.retro.bad,
      action_item_ids: [...issue.retro.action_item_ids],
      commits: [...issue.retro.commits],
    },
    effort_level: issue.effort_level,
  };
}

function cloneTriage(t: IssueTriage): IssueTriage {
  return {
    expires_at: t.expires_at,
    reassess_hint: t.reassess_hint,
    last_status: t.last_status,
    last_explain: t.last_explain,
    ice: { total: t.ice.total, i: t.ice.i, c: t.ice.c, e: t.ice.e },
    history: t.history.map((h) => ({
      timestamp: h.timestamp,
      status: h.status,
      explain: h.explain,
      expires_at: h.expires_at,
      ice: { total: h.ice.total, i: h.ice.i, c: h.ice.c, e: h.ice.e },
    })),
  };
}

type ValidateResult =
  | { ok: true; issue: Issue }
  | { ok: false; errors: string[] };

/**
 * Validate an arbitrary value as an Issue. Returns either the typed Issue or
 * a list of human-readable error messages — one per defect.
 *
 * Validates: required fields present, enum values match, primitive types
 * match. Does NOT validate: ISO 8601 timestamp shape, UUID format, etc.;
 * those are caller responsibilities.
 *
 * Schema v3 contract:
 *  - `id` is required, non-empty, must match `ISS-<positive-integer>`.
 *  - `external_id` is required as a field but may be empty (YAML-only
 *    mode + drafts pre-tracker-create have no external mapping yet).
 *  - `children` is required, must be an array of `ISS-N` strings (may be
 *    empty). Available on every card type. On Epic = ordered phase cards;
 *    on non-epic = ordered sub-cards. Reverse linkage to `parent_id`.
 *  - `phases` is RETIRED in ISS-81. Legacy YAMLs may still carry it; the
 *    parse path tolerates any value and drops the field on the next save.
 *  - v1 / v2 documents are rejected with a migration suggestion — there is
 *    NO runtime backwards-compat shim. Run `scripts/migrate-issues-to-v3.ts`
 *    once on each repo to upgrade.
 */
export function validateIssue(
  value: unknown,
  options: ParseIssueOptions,
): ValidateResult {
  const errors: string[] = [];
  const expectedPrefix = options.expectedPrefix;
  const idRegex = buildIssueIdRegex(expectedPrefix);
  const idShape = `${expectedPrefix}-<positive integer>`;

  if (!isPlainObject(value)) {
    return { ok: false, errors: ["Issue must be a YAML mapping"] };
  }
  const v = value as Record<string, unknown>;

  // schema_version — v3 through v6 (KNOWN_SCHEMA_MIN..KNOWN_SCHEMA_MAX),
  // with forward-compat for any integer > KNOWN_SCHEMA_MAX (DX-280).
  // Reject older versions with a loud migration pointer. v1 was retired
  // by `migrate-issues-to-v2`; v2 is retired by `migrate-issues-to-v3`
  // (adds the required `children: []` field). v3 is migrated to v4
  // lazily by this validator when reading v3 YAMLs with `blocked:` field
  // (auto-renamed to `waiting_on:` in the output). v6 (DX-231) drops
  // `"Needs Approval"` status and adds the orthogonal `requires_human`
  // field — the migration is a no-op for YAMLs that did not carry the
  // retired status (the field defaults `null` on parse when missing);
  // YAMLs carrying `status: "Needs Approval"` are rejected fail-loud
  // below so the operator migrates by hand before the loader can
  // normalize them. Versions ABOVE KNOWN_SCHEMA_MAX warn-and-accept so
  // a writer bump committed without a matching `make
  // publish-danx-issue-mcp` does not bring down host saves — see the
  // `KNOWN_SCHEMA_MAX` header above for the drift-class rationale.
  if (!("schema_version" in v)) {
    errors.push("missing required field: schema_version");
  } else if (v.schema_version === 1 || v.schema_version === 2) {
    errors.push(
      `schema_version ${v.schema_version} is no longer supported — run scripts/migrate-issues-to-v3.ts to upgrade`,
    );
  } else if (
    typeof v.schema_version !== "number" ||
    !Number.isInteger(v.schema_version) ||
    v.schema_version < KNOWN_SCHEMA_MIN
  ) {
    errors.push(
      `schema_version must be an integer >= ${KNOWN_SCHEMA_MIN} (got ${JSON.stringify(v.schema_version)})`,
    );
  } else if (v.schema_version > KNOWN_SCHEMA_MAX) {
    // Forward-compat (DX-280). Writer bumped past this validator's known
    // max — bundled package is behind. Accept the YAML (cards still load,
    // saves still round-trip), but emit a loud warning so the operator
    // sees the lag and runs `make publish-danx-issue-mcp` to refresh the
    // bundle. Same parser otherwise — unknown future fields are silently
    // dropped on serialize, which is the standard forward-compat read
    // semantic. Per-field validators still fire so a breaking shape
    // change is NOT papered over. Dedup keyed on the unknown version so
    // a 100-card poll tick emits ONE warning per distinct future
    // version, not 100 × N call sites.
    if (!warnedSchemaVersions.has(v.schema_version)) {
      warnedSchemaVersions.add(v.schema_version);
      console.warn(
        `[danx-issue-yaml] schema_version ${v.schema_version} is newer than this validator's known max ${KNOWN_SCHEMA_MAX} — accepting (forward-compat). Run \`make publish-danx-issue-mcp\` from danxbot to refresh the bundled validator.`,
      );
    }
  }

  // tracker
  if (!("tracker" in v)) {
    errors.push("missing required field: tracker");
  } else if (typeof v.tracker !== "string" || v.tracker.length === 0) {
    errors.push("tracker must be a non-empty string");
  }

  // id — internal primary id, always non-empty, must match <PREFIX>-N format.
  if (!("id" in v)) {
    errors.push("missing required field: id");
  } else if (typeof v.id !== "string") {
    errors.push("id must be a string");
  } else if (v.id.length === 0) {
    errors.push(
      `id must be a non-empty string (format: ${idShape})`,
    );
  } else if (!idRegex.test(v.id)) {
    errors.push(
      `id must match ${idShape} (got ${JSON.stringify(v.id)})`,
    );
  }

  // external_id — required as a field; empty string is permitted (memory
  // tracker issues + drafts pre-create have no external mapping yet).
  if (!("external_id" in v)) {
    errors.push("missing required field: external_id");
  } else if (typeof v.external_id !== "string") {
    errors.push("external_id must be a string");
  }

  // parent_id — null OR a `<PREFIX>-N` string. Phase 1 of ISS-99 added the
  // prefix-shape check so a `DX` repo can't end up with `parent_id: "ISS-99"`
  // pointing at a sibling repo's id space — the same mistake `id` /
  // `children[]` / `blocked.by[]` / `retro.action_item_ids[]` already
  // reject. Existing well-formed YAMLs (parent_id is either null or a
  // same-prefix `<PREFIX>-<N>`) are unaffected.
  if (!("parent_id" in v)) {
    errors.push("missing required field: parent_id");
  } else if (v.parent_id !== null && typeof v.parent_id !== "string") {
    errors.push("parent_id must be a string or null");
  } else if (typeof v.parent_id === "string" && !idRegex.test(v.parent_id)) {
    errors.push(
      `parent_id must be null or match ${idShape} (got ${JSON.stringify(v.parent_id)})`,
    );
  }

  // children — required array of `<PREFIX>-N` strings (may be empty).
  let childrenResult: string[] | null = null;
  if (!("children" in v)) {
    errors.push("missing required field: children");
  } else {
    const r = validateChildrenList(v.children, idRegex, idShape);
    if (typeof r === "string") errors.push(r);
    else childrenResult = r;
  }

  // dispatch — required object (or null when no active dispatch). Replaces
  // the legacy `dispatch_id: string|null` field. Legacy YAMLs that still
  // carry `dispatch_id` are rejected with a migration pointer — running
  // `scripts/migrate-issues-to-triage-v3.ts` upgrades every YAML in one
  // shot. The presence check ALWAYS rejects (even when both fields are
  // present) so a half-migrated YAML with both legacy + new fields fails
  // loud instead of silently picking one.
  if ("dispatch_id" in v) {
    errors.push(
      "Legacy `dispatch_id` field is no longer supported — run scripts/migrate-issues-to-triage-v3.ts to convert to the structured `dispatch` block",
    );
  }
  let dispatchResult: IssueDispatch | null = null;
  if ("dispatch" in v) {
    const r = validateDispatch(v.dispatch);
    if (typeof r === "string") errors.push(r);
    else dispatchResult = r;
  }
  // Old YAMLs that pre-date both fields parse with dispatch: null —
  // tolerated here so test fixtures that omit the field don't have to
  // be rebuilt. Strict callers can pass through `validateIssue` once
  // and re-emit via `serializeIssue` to get the canonical shape.

  // status — v3 YAMLs carry `"Needs Help"`; v4 renames to `"Blocked"`.
  // Auto-migrate on read so existing files round-trip without a separate
  // migration script. The validator accepts the legacy literal only when
  // schema_version is 3 (else the file is a half-migrated v4 with stale
  // status — fail loud). Sets `v3NeedsHelpMigration = true` so the v3
  // `blocked` synthesis below populates the new self-block field (the
  // invariant `status === "Blocked" ⟺ blocked !== null` requires it).
  //
  // DX-231 (schema_version 6): the `"Needs Approval"` parking status was
  // retired in favour of the orthogonal `requires_human` field. The
  // ~3 cards in flight at the time of the rollout are migrated by hand
  // BEFORE this phase merges (operator moves them to `Review`/`ToDo` and
  // sets `requires_human` where appropriate). Any YAML still carrying
  // `status: "Needs Approval"` is a half-migrated file — reject fail-loud
  // with a clear migration pointer rather than silently coercing.
  let v3NeedsHelpMigration = false;
  if (!("status" in v)) {
    errors.push("missing required field: status");
  } else if (v.status === "Needs Approval") {
    errors.push(
      'status: "Needs Approval" was retired in DX-231 (schema_version 6) — migrate this card by hand: move it to "Review" or "ToDo" and set the orthogonal `requires_human: {...}` field if a human still needs to act.',
    );
  } else if (
    v.status === "Needs Help" &&
    v.schema_version === 3
  ) {
    v.status = "Blocked";
    v3NeedsHelpMigration = true;
  } else if (!ISSUE_STATUSES.includes(v.status as IssueStatus)) {
    errors.push(
      `status must be one of [${ISSUE_STATUSES.join(", ")}] (got ${JSON.stringify(v.status)})`,
    );
  }

  // type
  if (!("type" in v)) {
    errors.push("missing required field: type");
  } else if (!ISSUE_TYPES.includes(v.type as IssueType)) {
    errors.push(
      `type must be one of [${ISSUE_TYPES.join(", ")}] (got ${JSON.stringify(v.type)})`,
    );
  }

  // title
  if (!("title" in v)) {
    errors.push("missing required field: title");
  } else if (typeof v.title !== "string" || v.title.length === 0) {
    errors.push("title must be a non-empty string");
  }

  // description — required, must be present (may be empty string).
  let description: string | null = null;
  if (!("description" in v)) {
    errors.push("missing required field: description");
  } else if (typeof v.description !== "string") {
    errors.push("description must be a string");
  } else {
    description = v.description;
  }

  // triage — required object. Replaces the legacy flat
  // `triaged: {timestamp, status, explain}` block. Legacy YAMLs that
  // still carry `triaged` are rejected with a migration pointer
  // regardless of whether `triage` is also present, so a half-migrated
  // YAML with both fields fails loud instead of silently picking one.
  if ("triaged" in v) {
    errors.push(
      "Legacy `triaged` field is no longer supported — run scripts/migrate-issues-to-triage-v3.ts to convert to the structured `triage` block",
    );
  }
  let triageResult: IssueTriage | null = null;
  if (!("triage" in v)) {
    if (!("triaged" in v)) {
      errors.push("missing required field: triage");
    }
  } else {
    const r = validateTriage(v.triage);
    if (typeof r === "string") errors.push(r);
    else triageResult = r;
  }

  // ac — required.
  let acResult: IssueAcItem[] | null = null;
  if (!("ac" in v)) {
    errors.push("missing required field: ac");
  } else {
    const r = validateAcList(v.ac);
    if (typeof r === "string") errors.push(r);
    else acResult = r;
  }

  // phases — RETIRED in ISS-81. Legacy YAMLs may still carry the key; the
  // normalize-on-read path tolerates any value here (including malformed
  // shapes) and drops it silently. The next save re-emits the YAML without
  // `phases:`. The unified field for child cards is `children[]`.
  // Intentionally NO validation: a legacy `phases: []` or `phases: [...stuff]`
  // must never block a parse, otherwise pre-ISS-81 YAMLs become unreadable.

  // comments — required.
  let commentsResult: IssueComment[] | null = null;
  if (!("comments" in v)) {
    errors.push("missing required field: comments");
  } else {
    const r = validateCommentsList(v.comments);
    if (typeof r === "string") errors.push(r);
    else commentsResult = r;
  }

  // retro — required.
  let retroResult: IssueRetro | null = null;
  if (!("retro" in v)) {
    errors.push("missing required field: retro");
  } else {
    const r = validateRetro(v.retro, idRegex, idShape);
    if (typeof r === "string") errors.push(r);
    else retroResult = r;
  }

  // waiting_on — dep-chain queue. Optional field. Missing → null. Present
  // must be either YAML null OR `{reason, timestamp, by[]}`.
  //
  // blocked — self-block record. Optional field. Missing → null. Present
  // must be either YAML null OR `{reason, timestamp}` (NO `by[]` —
  // distinguishes from v3 schema where `blocked` carried the dep-chain
  // payload, now renamed to `waiting_on`).
  //
  // v3 → v4 auto-migration: in a v3 YAML the `blocked:` key carries the
  // dep-chain payload (`{reason, timestamp, by[]}`). On read we map it to
  // `waiting_on` and leave `blocked: null`. v4 YAMLs with the new
  // self-block shape (`blocked: {reason, timestamp}`) parse straight
  // through.
  let waitingOnResult: WaitingOn | null = null;
  let blockedResult: Blocked | null = null;
  const isV3 = v.schema_version === 3;
  if (isV3) {
    // v3 file: `blocked:` is dep-chain → goes into waiting_on. New
    // self-block field doesn't exist on v3 files.
    if ("waiting_on" in v) {
      errors.push(
        "schema_version: 3 file carries 'waiting_on:' — set schema_version to 4",
      );
    }
    if ("blocked" in v) {
      const r = validateWaitingOn(v.blocked, idRegex, idShape);
      if (typeof r === "string") errors.push(r);
      else waitingOnResult = r;
    }
    // v3 status="Needs Help" → v4 status="Blocked". Synthesize a placeholder
    // `blocked` self-block record so the invariant
    // `status === "Blocked" ⟺ blocked !== null` holds. Reason is a
    // migration marker; timestamp is epoch so reloads stamp deterministically
    // (next save serializes the synthesized record; subsequent reads round-trip
    // it byte-stable). Agents can edit the reason on next pickup.
    if (v3NeedsHelpMigration) {
      blockedResult = {
        reason:
          "(no recorded reason — migrated from legacy v3 'Needs Help' status; agent should overwrite on next pickup)",
        timestamp: "1970-01-01T00:00:00.000Z",
      };
    }
  } else {
    // v4 file: `waiting_on:` is dep-chain, `blocked:` is self-block.
    if ("waiting_on" in v) {
      const r = validateWaitingOn(v.waiting_on, idRegex, idShape);
      if (typeof r === "string") errors.push(r);
      else waitingOnResult = r;
    }
    if ("blocked" in v) {
      const r = validateBlocked(v.blocked);
      if (typeof r === "string") errors.push(r);
      else blockedResult = r;
    }
  }

  // Invariant: status === "Blocked" ⟺ blocked !== null. Worker write-paths
  // enforce this on write; the parser enforces it on read so a hand-edited
  // file with a half-set state fails loud rather than landing in memory.
  //
  // `waiting_on` is independent of `status`. Any status (ToDo, In Progress,
  // Review, Blocked, Done, Cancelled) is legal with any waiting_on shape.
  // waiting_on is a pure dispatch gate — the picker checks effective
  // resolution of every id in `by[]`; the field itself is a durable record
  // never mutated by the system as a side effect of a status change.
  if (
    typeof v.status === "string" &&
    ISSUE_STATUSES.includes(v.status as IssueStatus)
  ) {
    const statusBlocked = v.status === "Blocked";
    const fieldBlocked = blockedResult !== null;
    if (statusBlocked && !fieldBlocked) {
      errors.push(
        "status is 'Blocked' but blocked field is null — must populate blocked record",
      );
    }
    if (!statusBlocked && fieldBlocked) {
      errors.push(
        `blocked field is non-null but status is '${v.status}' — must set status to 'Blocked'`,
      );
    }
  }

  // requires_human — optional field. Missing → null. Cards predating
  // DX-231 omit the field entirely; the loader defaults `null` so legacy
  // YAMLs continue to parse cleanly. Present must be either YAML null OR
  // `{reason, steps[], set_by, set_at}`. Independent from `blocked` /
  // `waiting_on` — all three are dispatch gates and may co-exist.
  let requiresHumanResult: RequiresHuman | null = null;
  if ("requires_human" in v) {
    const r = validateRequiresHuman(v.requires_human);
    if (typeof r === "string") errors.push(r);
    else requiresHumanResult = r;
  }

  // conflict_on — optional field (v7). Missing → []. Present must be
  // an array of `{id: <PREFIX>-N, reason: non-empty string}`. Legacy
  // v3-v6 YAMLs omit the field; the validator defaults `[]` so they
  // round-trip cleanly. Independent dispatch gate from `blocked` /
  // `waiting_on` / `requires_human` — see `Issue.conflict_on`
  // docstring for the two-way enforcement contract.
  let conflictOnResult: ConflictOnEntry[] = [];
  if ("conflict_on" in v && v.conflict_on !== null && v.conflict_on !== undefined) {
    const r = validateConflictOn(v.conflict_on, idRegex, idShape);
    if (typeof r === "string") errors.push(r);
    else conflictOnResult = r;
  }

  // effort_level — optional field (v8). Missing / null → null. Present
  // must be one of the seven canonical EffortLevelName literals
  // (EFFORT_LEVEL_NAMES). Anything else fails-loud — a typo in a
  // hand-edited card would silently route the dispatch through the
  // wrong model/effort tier. v3-v7 YAMLs omit the field; the
  // validator defaults to `null` so they round-trip cleanly.
  let effortLevelResult: EffortLevelName | null = null;
  if ("effort_level" in v && v.effort_level !== null && v.effort_level !== undefined) {
    if (typeof v.effort_level !== "string" || !EFFORT_LEVEL_SET.has(v.effort_level as EffortLevelName)) {
      errors.push(
        `effort_level must be null or one of [${EFFORT_LEVEL_NAMES.join(", ")}] (got ${JSON.stringify(v.effort_level)})`,
      );
    } else {
      effortLevelResult = v.effort_level as EffortLevelName;
    }
  }

  // history — optional field. Missing → []. Legacy YAMLs ship without the
  // field (DX-138 Phase 1 lands the schema). Present must be a list (or YAML
  // null which normalizes to []); each entry strictly validated so a
  // half-written entry fails loud rather than silently corrupting the audit
  // log.
  let historyResult: IssueHistoryEntry[] = [];
  if ("history" in v) {
    const r = validateHistory(v.history);
    if (typeof r === "string") errors.push(r);
    else historyResult = r;
  }

  // assigned_agent — optional field. Missing → null. Present must be either
  // null or a non-empty string matching `AGENT_NAME_SHAPE`. Cards predating
  // DX-200 omit the field entirely; the multi-worker pick algorithm stamps
  // it on dispatch start. Strict shape check so a hand-typo (`true`,
  // garbage object) fails loud rather than silently leaking into the
  // dispatches table's `agent_name` column.
  let assignedAgentResult: string | null = null;
  if ("assigned_agent" in v) {
    const raw = v.assigned_agent;
    if (raw === null || raw === undefined) {
      assignedAgentResult = null;
    } else if (typeof raw !== "string") {
      errors.push("assigned_agent must be a string or null");
    } else if (raw.length === 0) {
      // Treat empty string as null — same forgiving shape as
      // `external_id`, so a YAML that wrote `assigned_agent: ""` (e.g.
      // hand-edit, mid-migration) round-trips as null without erroring.
      assignedAgentResult = null;
    } else if (!AGENT_NAME_SHAPE.test(raw)) {
      errors.push(
        `assigned_agent must match ${AGENT_NAME_SHAPE} (URL/branch/path-safe agent name)`,
      );
    } else {
      assignedAgentResult = raw;
    }
  }

  // Position: optional `number | null` (DX-264). Missing → `null`.
  // Strict shape check at parse-time so a hand-typed garbage value
  // (string, NaN, Infinity) fails loud instead of silently re-sorting
  // the column. Finite number or null only — fractional-indexing
  // midpoints stay representable, and `null` is the canonical "no
  // operator override" sentinel that the sort tier checks against.
  // Runs BEFORE the `errors.length > 0` early return so its push counts.
  let positionValue: number | null = null;
  if ("position" in v) {
    const raw = v.position;
    if (raw === null || raw === undefined) {
      positionValue = null;
    } else if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(
        `position must be a finite number or null (got ${JSON.stringify(raw)})`,
      );
    } else {
      positionValue = raw;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All required fields present and well-typed; build the validated Issue.
  // Priority: missing / out-of-range values are clamped to `[1.0, 5.0]` and
  // missing fields default to `3.0` — same forgiving shape as `description`
  // so v3 / v4 YAMLs round-trip without a hard migration. The
  // `migrate-issues-priority.ts` one-off bumps the on-disk shape lazily.
  const priorityValue =
    "priority" in v ? clampPriority(v.priority) : PRIORITY_DEFAULT;
  const issue: Issue = {
    // Hardcoded to the canonical writer version (KNOWN_SCHEMA_MAX). A
    // forward-compat-accepted parse (v.schema_version > KNOWN_SCHEMA_MAX)
    // silent-downgrades here — the returned `Issue.schema_version` is
    // type-literal `KNOWN_SCHEMA_MAX`, never the future value seen on
    // disk. Lockstep contract: when the writer bumps, bump this literal
    // AND KNOWN_SCHEMA_MAX above in the same commit (the `lockstep
    // invariant` test pins both directions).
    schema_version: 8,
    tracker: v.tracker as string,
    id: v.id as string,
    external_id: v.external_id as string,
    parent_id: v.parent_id as string | null,
    children: childrenResult as string[],
    dispatch: dispatchResult,
    status: v.status as IssueStatus,
    type: v.type as IssueType,
    title: v.title as string,
    description: description as string,
    priority: priorityValue,
    position: positionValue,
    triage: triageResult as IssueTriage,
    ac: acResult as IssueAcItem[],
    comments: commentsResult as IssueComment[],
    retro: retroResult as IssueRetro,
    assigned_agent: assignedAgentResult,
    waiting_on: waitingOnResult,
    blocked: blockedResult,
    requires_human: requiresHumanResult,
    conflict_on: conflictOnResult,
    effort_level: effortLevelResult,
    history: historyResult,
  };
  return { ok: true, issue };
}

/**
 * Validate the v7 `conflict_on` field. Shape: array of `{id, reason}`
 * objects. Missing / null → empty array (default). Present must be an
 * array; each entry must have a non-empty string `reason` and an `id`
 * that matches `${prefix}-<N>`. The id is NOT required to resolve in
 * the current open-set — a partner card may be closed (Done /
 * Cancelled), in which case the entry is durable-audit-only and the
 * eligibility filter ignores it (terminal partner cannot block
 * dispatch). Self-reference (an entry pointing at the owning card's
 * own id) is rejected fail-loud — would create a no-progress loop.
 *
 * Duplicate ids are deduplicated by keeping the LAST entry's reason
 * (callers can update the reason by re-stamping). Validator does NOT
 * verify the partner exists — the missing-card-handling is the
 * poller's responsibility (`effectiveConflictOn`).
 */
function validateConflictOn(
  value: unknown,
  idRegex: RegExp,
  idShape: string,
): ConflictOnEntry[] | string {
  if (!Array.isArray(value)) {
    return `conflict_on must be a list of {id, reason} objects`;
  }
  const seen = new Map<string, ConflictOnEntry>();
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!isPlainObject(entry)) {
      return `conflict_on[${i}] must be a mapping with keys {id, reason}`;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !idRegex.test(e.id)) {
      return `conflict_on[${i}].id must match ${idShape} (got ${JSON.stringify(e.id)})`;
    }
    if (typeof e.reason !== "string" || e.reason.length === 0) {
      return `conflict_on[${i}].reason must be a non-empty string`;
    }
    seen.set(e.id, { id: e.id, reason: e.reason });
  }
  return [...seen.values()];
}

/**
 * Validate the `requires_human` field. Shape: `{reason, steps[], set_by,
 * set_at}` OR null. Mirrors the `Blocked` validator's strictness:
 *  - `reason` must be a non-empty string (a blank reason is uninformative
 *    and would surface as an empty banner on the dashboard).
 *  - `steps` must be an array of strings (empty list permitted but
 *    discouraged — the dashboard renders the array as a numbered
 *    checklist; an empty list is a wording defect).
 *  - `set_by` must be `"agent"` or `"human"` (anything else is a typo).
 *  - `set_at` must be a non-empty string (caller supplies ISO 8601; the
 *    validator does not parse the format).
 */
function validateRequiresHuman(value: unknown): RequiresHuman | null | string {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    return "requires_human must be a mapping or null";
  }
  const v = value as Record<string, unknown>;
  if (typeof v.reason !== "string" || v.reason.length === 0) {
    return "requires_human.reason must be a non-empty string";
  }
  if (!Array.isArray(v.steps)) {
    return "requires_human.steps must be a list of strings";
  }
  const steps: string[] = [];
  for (let i = 0; i < v.steps.length; i++) {
    const item = v.steps[i];
    if (typeof item !== "string") {
      return `requires_human.steps[${i}] must be a string`;
    }
    steps.push(item);
  }
  if (v.set_by !== "agent" && v.set_by !== "human") {
    return `requires_human.set_by must be one of ["agent", "human"] (got ${JSON.stringify(v.set_by)})`;
  }
  if (typeof v.set_at !== "string" || v.set_at.length === 0) {
    return "requires_human.set_at must be a non-empty string";
  }
  return {
    reason: v.reason,
    steps,
    set_by: v.set_by,
    set_at: v.set_at,
  };
}

function validateHistory(value: unknown): IssueHistoryEntry[] | string {
  // Accept YAML null as "no entries" (parallel to children/comments/triage)
  // so a hand-edited file with `history: null` rather than `history: []`
  // still parses cleanly.
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return "history must be a list";
  const out: IssueHistoryEntry[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) {
      return `history[${i}] must be a mapping`;
    }
    const entry = item as Record<string, unknown>;

    if (typeof entry.timestamp !== "string") {
      return `history[${i}].timestamp must be a string`;
    }

    if (typeof entry.actor !== "string" || entry.actor.length === 0) {
      return `history[${i}].actor must be a non-empty string`;
    }

    if (typeof entry.event !== "string") {
      return `history[${i}].event must be a string`;
    }
    if (!VALID_HISTORY_EVENTS.has(entry.event)) {
      return `history[${i}].event must be one of [${[...VALID_HISTORY_EVENTS].join(", ")}] (got ${JSON.stringify(entry.event)})`;
    }

    if (entry.from !== undefined && entry.from !== null) {
      if (
        typeof entry.from !== "string" ||
        !ISSUE_STATUSES.includes(entry.from as IssueStatus)
      ) {
        return `history[${i}].from must be one of [${ISSUE_STATUSES.join(", ")}] (got ${JSON.stringify(entry.from)})`;
      }
    }

    if (entry.to !== undefined && entry.to !== null) {
      if (
        typeof entry.to !== "string" ||
        !ISSUE_STATUSES.includes(entry.to as IssueStatus)
      ) {
        return `history[${i}].to must be one of [${ISSUE_STATUSES.join(", ")}] (got ${JSON.stringify(entry.to)})`;
      }
    }

    if (entry.note !== undefined && entry.note !== null) {
      if (typeof entry.note !== "string") {
        return `history[${i}].note must be a string`;
      }
    }

    const built: IssueHistoryEntry = {
      timestamp: entry.timestamp,
      actor: entry.actor,
      event: entry.event as IssueHistoryEvent,
    };
    if (typeof entry.from === "string") built.from = entry.from as IssueStatus;
    if (typeof entry.to === "string") built.to = entry.to as IssueStatus;
    if (typeof entry.note === "string") built.note = entry.note;

    // Per-event field invariants — same enforcement as `appendHistory`'s
    // assertHistoryEntry, but at parse time too. Asymmetric leniency between
    // the parse path and the append path would mean a Phase 2/3 bug that
    // emits an invalid entry could land on disk via a non-appendHistory
    // write path and then round-trip cleanly forever. Both paths reject so
    // the contract has exactly one shape.
    if (built.event === "status_change") {
      if (built.from === undefined || built.to === undefined) {
        return `history[${i}] event=status_change requires both from and to`;
      }
    } else if (built.event === "created" || built.event === "blocked") {
      if (built.to === undefined) {
        return `history[${i}] event=${built.event} requires to`;
      }
    }

    out.push(built);
  }
  // Cap on parse — drop oldest silently. Same idiom as TRIAGE_HISTORY_CAP
  // (cap-and-slice), but `validateHistory` is strict on required fields
  // (timestamp / actor / event) where `validateTriageHistory` defaults
  // missing strings to "" — audit-log entries shouldn't have empty
  // identifiers, so the asymmetry is intentional. The append-time helper
  // applies the same cap; both paths agree so the post-cap slice is
  // whichever wrote last.
  if (out.length > HISTORY_CAP) {
    return out.slice(out.length - HISTORY_CAP);
  }
  return out;
}

function validateTriage(value: unknown): IssueTriage | string {
  // null is permitted at the YAML level and means "no triage record yet" —
  // it normalizes to a fully-empty IssueTriage.
  if (value === null) return emptyTriage();
  if (!isPlainObject(value)) return "triage must be a mapping";
  const v = value as Record<string, unknown>;
  if (v.expires_at !== undefined && typeof v.expires_at !== "string") {
    return "triage.expires_at must be a string";
  }
  if (v.reassess_hint !== undefined && typeof v.reassess_hint !== "string") {
    return "triage.reassess_hint must be a string";
  }
  if (v.last_status !== undefined && typeof v.last_status !== "string") {
    return "triage.last_status must be a string";
  }
  if (v.last_explain !== undefined && typeof v.last_explain !== "string") {
    return "triage.last_explain must be a string";
  }
  let ice = emptyIce();
  if (v.ice !== undefined && v.ice !== null) {
    const r = validateIce(v.ice, "triage.ice");
    if (typeof r === "string") return r;
    ice = r;
  }
  let history: IssueTriageHistoryEntry[] = [];
  if (v.history !== undefined && v.history !== null) {
    const r = validateTriageHistory(v.history);
    if (typeof r === "string") return r;
    history = r;
  }
  return {
    expires_at: typeof v.expires_at === "string" ? v.expires_at : "",
    reassess_hint:
      typeof v.reassess_hint === "string" ? v.reassess_hint : "",
    last_status: typeof v.last_status === "string" ? v.last_status : "",
    last_explain:
      typeof v.last_explain === "string" ? v.last_explain : "",
    ice,
    history,
  };
}

function validateIce(value: unknown, path: string): IssueIce | string {
  if (!isPlainObject(value)) return `${path} must be a mapping`;
  const v = value as Record<string, unknown>;
  for (const key of ["total", "i", "c", "e"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "number") {
      return `${path}.${key} must be a number`;
    }
  }
  return {
    total: typeof v.total === "number" ? v.total : 0,
    i: typeof v.i === "number" ? v.i : 0,
    c: typeof v.c === "number" ? v.c : 0,
    e: typeof v.e === "number" ? v.e : 0,
  };
}

function validateTriageHistory(
  value: unknown,
): IssueTriageHistoryEntry[] | string {
  if (!Array.isArray(value)) return "triage.history must be a list";
  const out: IssueTriageHistoryEntry[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) {
      return `triage.history[${i}] must be a mapping`;
    }
    const entry = item as Record<string, unknown>;
    for (const key of ["timestamp", "status", "explain", "expires_at"] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== "string") {
        return `triage.history[${i}].${key} must be a string`;
      }
    }
    let ice = emptyIce();
    if (entry.ice !== undefined && entry.ice !== null) {
      const r = validateIce(entry.ice, `triage.history[${i}].ice`);
      if (typeof r === "string") return r;
      ice = r;
    }
    out.push({
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      status: typeof entry.status === "string" ? entry.status : "",
      explain: typeof entry.explain === "string" ? entry.explain : "",
      expires_at:
        typeof entry.expires_at === "string" ? entry.expires_at : "",
      ice,
    });
  }
  // Cap at TRIAGE_HISTORY_CAP — drop oldest entries silently. The triage
  // agent is supposed to maintain the cap on write, but we tolerate a
  // legacy YAML with too many entries instead of failing parse.
  if (out.length > TRIAGE_HISTORY_CAP) {
    return out.slice(out.length - TRIAGE_HISTORY_CAP);
  }
  return out;
}

function validateDispatch(value: unknown): IssueDispatch | null | string {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return "dispatch must be a mapping or null";
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) {
    return "dispatch.id must be a non-empty string";
  }
  if (typeof v.pid !== "number") return "dispatch.pid must be a number";
  if (typeof v.host !== "string") return "dispatch.host must be a string";
  if (typeof v.kind !== "string") return "dispatch.kind must be a string";
  if (!VALID_DISPATCH_KINDS.has(v.kind)) {
    return `dispatch.kind must be one of [${[...VALID_DISPATCH_KINDS].join(", ")}] (got ${JSON.stringify(v.kind)})`;
  }
  if (typeof v.started_at !== "string") {
    return "dispatch.started_at must be a string";
  }
  if (typeof v.ttl_seconds !== "number") {
    return "dispatch.ttl_seconds must be a number";
  }
  return {
    id: v.id,
    pid: v.pid,
    host: v.host,
    kind: v.kind as "work" | "triage" | "recovery",
    started_at: v.started_at,
    ttl_seconds: v.ttl_seconds,
  };
}

function validateChildrenList(
  value: unknown,
  idRegex: RegExp,
  idShape: string,
): string[] | string {
  // null normalizes to empty list (yaml has no native "empty array" sigil
  // distinct from null when the key is present with no value).
  if (value === null) return [];
  if (!Array.isArray(value)) {
    return `children must be a list of ${idShape} strings`;
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string") {
      return `children[${i}] must be a string`;
    }
    if (!idRegex.test(item)) {
      return `children[${i}] must match ${idShape} (got ${JSON.stringify(item)})`;
    }
    out.push(item);
  }
  return out;
}

function validateAcList(value: unknown): IssueAcItem[] | string {
  // null normalizes to empty list (yaml has no native "empty array" sigil
  // distinct from null when the key is present with no value).
  if (value === null) return [];
  if (!Array.isArray(value)) return "ac must be a list";
  const out: IssueAcItem[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) return `ac[${i}] must be a mapping`;
    const v = item as Record<string, unknown>;
    // DX-347: `check_item_id` is a sync-layer-only Trello id. Absent /
    // null / non-string → auto-heal to "". The sync path
    // (`src/issue-tracker/sync.ts:346` ac-reconcile) already treats
    // empty `check_item_id` as "new item" → `addAcItem` stamps the
    // tracker-assigned id back on next sync. The dashboard's PATCH
    // route (`src/dashboard/issue-write.ts:303`) already uses this
    // same heal shape on the WRITE side; this brings the READ side
    // into alignment. Hard-rejecting here turned a single missing
    // optional field into a YAML-wide parse failure, masking the card
    // from orphan-heal / poller / dashboard.
    const checkItemId = typeof v.check_item_id === "string" ? v.check_item_id : "";
    if (typeof v.title !== "string") {
      return `ac[${i}].title must be a string`;
    }
    if (typeof v.checked !== "boolean") {
      return `ac[${i}].checked must be a boolean`;
    }
    out.push({
      check_item_id: checkItemId,
      title: v.title,
      checked: v.checked,
    });
  }
  return out;
}

function validateCommentsList(value: unknown): IssueComment[] | string {
  if (value === null) return [];
  if (!Array.isArray(value)) return "comments must be a list";
  const out: IssueComment[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) return `comments[${i}] must be a mapping`;
    const v = item as Record<string, unknown>;
    if (v.id !== undefined && typeof v.id !== "string") {
      return `comments[${i}].id must be a string`;
    }
    if (v.author !== undefined && typeof v.author !== "string") {
      return `comments[${i}].author must be a string`;
    }
    if (v.timestamp !== undefined && typeof v.timestamp !== "string") {
      return `comments[${i}].timestamp must be a string`;
    }
    if (typeof v.text !== "string") {
      return `comments[${i}].text must be a string`;
    }
    const c: IssueComment = {
      author: typeof v.author === "string" ? v.author : "",
      timestamp: typeof v.timestamp === "string" ? v.timestamp : "",
      text: v.text,
    };
    if (typeof v.id === "string") c.id = v.id;
    out.push(c);
  }
  return out;
}

function validateWaitingOn(
  value: unknown,
  idRegex: RegExp,
  idShape: string,
): WaitingOn | null | string {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    return "waiting_on must be a mapping or null";
  }
  const v = value as Record<string, unknown>;
  if (typeof v.reason !== "string" || v.reason.length === 0) {
    return "waiting_on.reason must be a non-empty string";
  }
  if (typeof v.timestamp !== "string" || v.timestamp.length === 0) {
    return "waiting_on.timestamp must be a non-empty string";
  }
  if (!Array.isArray(v.by)) {
    return `waiting_on.by must be a list of ${idShape} strings`;
  }
  if (v.by.length === 0) {
    return "waiting_on.by must contain at least one issue id";
  }
  const by: string[] = [];
  for (let i = 0; i < v.by.length; i++) {
    const item = v.by[i];
    if (typeof item !== "string") {
      return `waiting_on.by[${i}] must be a string`;
    }
    if (!idRegex.test(item)) {
      return `waiting_on.by[${i}] must match ${idShape} (got ${JSON.stringify(item)})`;
    }
    by.push(item);
  }
  return { reason: v.reason, timestamp: v.timestamp, by };
}

/**
 * Validate the v4 `blocked` self-block field. Shape: `{reason, timestamp}`.
 * NO `by[]` (that's `waiting_on.by`). A v3 file's `blocked:` carries a
 * `by[]` and is mapped to `waiting_on:` upstream — `validateBlocked` is
 * only called on v4 input.
 */
function validateBlocked(value: unknown): Blocked | null | string {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    return "blocked must be a mapping or null";
  }
  const v = value as Record<string, unknown>;
  if (typeof v.reason !== "string" || v.reason.length === 0) {
    return "blocked.reason must be a non-empty string";
  }
  if (typeof v.timestamp !== "string" || v.timestamp.length === 0) {
    return "blocked.timestamp must be a non-empty string";
  }
  if ("by" in v) {
    return "blocked must NOT carry 'by' — use 'waiting_on' for dep-chain queues";
  }
  return { reason: v.reason, timestamp: v.timestamp };
}

function validateRetro(
  value: unknown,
  idRegex: RegExp,
  idShape: string,
): IssueRetro | string {
  if (value === null) {
    return { good: "", bad: "", action_item_ids: [], commits: [] };
  }
  if (!isPlainObject(value)) return "retro must be a mapping";
  const v = value as Record<string, unknown>;
  if (v.good !== undefined && typeof v.good !== "string") {
    return "retro.good must be a string";
  }
  if (v.bad !== undefined && typeof v.bad !== "string") {
    return "retro.bad must be a string";
  }
  // Legacy `action_items: string[]` (free-text titles) is no longer accepted.
  // Reject loudly: silent-drop would lose information from the only place it
  // exists. The agent must convert each title to a `danx_issue_create` call
  // and reference the returned `ISS-N` in `action_item_ids[]`. An empty
  // `action_items: []` field on disk is harmless legacy noise — accept that
  // shape silently because no information is lost. Anything non-empty fails
  // validation so the operator/agent fixes it once instead of forever.
  if (v.action_items !== undefined) {
    if (!Array.isArray(v.action_items)) {
      return "retro.action_items is no longer supported (legacy free-text shape). Remove the field; use retro.action_item_ids[] of ISS-N references instead.";
    }
    if (v.action_items.length > 0) {
      const sample = v.action_items
        .filter((s) => typeof s === "string")
        .slice(0, 3)
        .map((s) => JSON.stringify(s))
        .join(", ");
      return (
        `retro.action_items (legacy free-text shape) is no longer supported. ` +
        `Create each action item as a full issue via danx_issue_create and reference its ISS-N in retro.action_item_ids[]. ` +
        `Offending sample: [${sample}${v.action_items.length > 3 ? ", …" : ""}]`
      );
    }
  }
  let actionItemIds: string[] = [];
  if (v.action_item_ids !== undefined) {
    if (!Array.isArray(v.action_item_ids)) {
      return `retro.action_item_ids must be a list of ${idShape} strings`;
    }
    for (let i = 0; i < v.action_item_ids.length; i++) {
      const item = v.action_item_ids[i];
      if (typeof item !== "string") {
        return `retro.action_item_ids[${i}] must be a string`;
      }
      if (!idRegex.test(item)) {
        return `retro.action_item_ids[${i}] must match ${idShape} (got ${JSON.stringify(item)}). Create the action-item card via danx_issue_create first, then reference its ${idShape} here.`;
      }
    }
    actionItemIds = v.action_item_ids as string[];
  }
  let commits: string[] = [];
  if (v.commits !== undefined) {
    if (!Array.isArray(v.commits)) {
      return "retro.commits must be a list of strings";
    }
    // Coerce numeric / bigint entries to strings — bare git SHAs that
    // happen to be all digits (e.g. `9828791`) parse as YAML ints. The
    // canonical on-disk form is a string, but the parser is forgiving
    // here so a small operator slip doesn't 500 the entire issues list.
    commits = new Array<string>(v.commits.length);
    for (let i = 0; i < v.commits.length; i++) {
      const c = v.commits[i];
      if (typeof c === "string") {
        commits[i] = c;
      } else if (typeof c === "number" || typeof c === "bigint") {
        commits[i] = String(c);
      } else {
        return `retro.commits[${i}] must be a string or number (got ${typeof c})`;
      }
    }
  }
  return {
    good: typeof v.good === "string" ? v.good : "",
    bad: typeof v.bad === "string" ? v.bad : "",
    action_item_ids: actionItemIds,
    commits,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
