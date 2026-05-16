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
import { migrateForward } from "./migrations/registry.js";

const EFFORT_LEVEL_SET: ReadonlySet<EffortLevelName> = new Set(EFFORT_LEVEL_NAMES);

const TRIAGE_HISTORY_CAP = 10;

/**
 * Schema-version bounds — strict canonical reader (DX-594).
 *
 * The validator accepts exactly two `schema_version` values directly:
 *
 *   - `KNOWN_SCHEMA_MAX` — canonical. Disk YAMLs round-trip byte-stable.
 *   - `KNOWN_SCHEMA_MIN === KNOWN_SCHEMA_MAX - 1` — single-version
 *     tolerance window handed off to `migrations/registry.ts#migrateForward`
 *     before per-field validation. In practice the boot sweep
 *     (DX-593 / `bootMigrateSweep`) walks every on-disk YAML to MAX so
 *     this tolerance tier never fires under normal operation; it is
 *     kept as defense-in-depth for a writer/reader race during a
 *     schema bump.
 *
 * Anything `< KNOWN_SCHEMA_MIN` throws immediately: the boot sweep is
 * the only path that should produce a writable MIN-or-MAX file; a value
 * below MIN means a pre-sweep file slipped through (operator restore,
 * stale branch, hand-edit). Operator fixes the file or files a bug.
 *
 * Values `> KNOWN_SCHEMA_MAX` (writer bumped past this bundled reader)
 * warn-and-accept once per distinct version, then silent-downgrade
 * `Issue.schema_version` to MAX on the returned object — same drift
 * protection DX-280 introduced. Unknown future fields drop on the
 * write side (canonical key set in `serializeIssue`), so the
 * round-trip is read-only-faithful for known keys.
 *
 * Maintenance contract — bumping `KNOWN_SCHEMA_MAX`:
 *  1. Add `migrations/v(MAX)-to-v(MAX+1).ts` (pure `(prev) => next`).
 *  2. Register it in `migrations/registry.ts#migrationsByFromVersion`.
 *  3. Bump the literal in `schema-versions.ts` (MIN := old MAX, MAX := new MAX).
 *  4. Update every writer literal — `createEmptyIssue`, `serializeIssue`,
 *     `issueToCreateInput`, the `issue.schema_version` assignment in
 *     `validateIssue`.
 *  5. Run `make publish-danx-issue-mcp` in the SAME commit so the
 *     bundled MCP catches up. The DX-280 lockstep test pins the
 *     writer == `KNOWN_SCHEMA_MAX` invariant.
 *
 * Schema-version log (most recent last):
 *  - v9: `db_updated_at` field (DX-545 / DX-546).
 *  - v10 (DX-592 / parent epic DX-591): five computed-timestamp fields
 *    (`archived_at`, `ready_at`, `completed_at`, `cancelled_at`,
 *    `list_name`) + `blocked` payload's prior `timestamp` key renamed
 *    to `blocked.at` for naming consistency.
 *
 * The literal values live in `./schema-versions.ts` so the migration
 * registry can import them without creating a yaml.ts ↔ registry.ts
 * cycle. We re-export here so existing imports (`import { KNOWN_SCHEMA_MAX }
 * from "./yaml.js"`) keep working.
 */
export { KNOWN_SCHEMA_MIN, KNOWN_SCHEMA_MAX } from "./schema-versions.js";
import { KNOWN_SCHEMA_MIN, KNOWN_SCHEMA_MAX } from "./schema-versions.js";

/**
 * Per-process dedup set for the "future-version" warn path. `parseIssue`
 * sits on the chokidar mirror's hot path (plus `/api/issues`, heal
 * pass, retry queue, sync.ts) — without dedup, a single drifted worker
 * would emit `N_cards × M_call_sites` warnings per tick, drowning the
 * operator log. One warning per distinct unknown version per process
 * lifetime is enough signal: the operator runs `make
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
 * caller). The two definitions MUST stay byte-identical; a test in
 * `yaml.test.ts` asserts the regex source.
 */
const AGENT_NAME_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Priority field bounds. `priority` is REQUIRED on every v10 YAML and
 * must be a finite number; the parser clamps out-of-range values into
 * `[PRIORITY_MIN, PRIORITY_MAX]` so a hand-edit (e.g. `priority: 0` or
 * `priority: 6`) heals to the bound rather than failing parse. Missing
 * field rejects fail-loud — the boot sweep stamps `PRIORITY_DEFAULT` on
 * any card that lacked the field on migration, so disk is canonical.
 * `PRIORITY_DEFAULT` (`3.0`) is exposed for the migration registry +
 * fresh-card constructor; it is NOT a parse-time default.
 *
 * The numeric range maps to six labeled tiers via `priorityTier()` in
 * `./priority-tier.ts`: `lowest` `(0, 1)`, `low` `[1, 2)`, `medium`
 * `[2, 3)`, `high` `[3, 4)`, `very_high` `[4, 5)`, `critical`
 * `[5, 5.99]`. See `Issue.priority` for the full semantic. Bounds:
 * `[0.01, 5.99]` (DX-521 widened from `[1.0, 5.0]` to accommodate the
 * 6-tier mapping; no schema bump — the value shape is unchanged, only
 * the clamp range widened).
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
 * on parse (a YAML carrying more than this drops oldest silently) and on
 * `appendHistory` (push past the cap shifts the oldest off the head).
 * Phase 1 of DX-138 — see DX-145 description for sizing rationale (1000
 * transitions on a single card means the card is mis-scoped, not that
 * history is wrong).
 */
export const HISTORY_CAP = 1000;

/**
 * Maximum length of `IssueHistoryEntry.note`. Enforced ONLY at append time
 * by `appendHistory` — the validator tolerates longer existing entries so
 * an over-cap note already on disk round-trips. A note longer than
 * `HISTORY_NOTE_CAP` is truncated to `HISTORY_NOTE_CAP - 1` chars + `…`
 * ellipsis (single-char Unicode ellipsis, not three dots) so the resulting
 * string is exactly `HISTORY_NOTE_CAP` chars long.
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
 * append-time (NOT parse-time, so a YAML carrying an unknown actor
 * prefix from a future writer round-trips). This regex is the
 * load-bearing implementation of that promise — Phase 2/3 callers fail
 * loud here when they accidentally drop the `:` separator or pass an
 * empty actor.
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
 *  - schema_version: 10 (v10 — DX-592)
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
 *  - db_updated_at: <current ISO 8601> (DX-545 / DX-546 — Phase 2 wires
 *    the synchronous DB upsert; Phase 1 just stamps creation time)
 *  - archived_at / ready_at / completed_at / cancelled_at / list_name:
 *    null (v10 fields, DX-592 — downstream of DX-575 wires the
 *    poller/picker/dispatch code that stamps these timestamps; this
 *    phase only lands the on-disk shape).
 */
export function createEmptyIssue(
  seed: {
    id?: string;
    external_id?: string;
    status?: IssueStatus;
    type?: IssueType;
    title?: string;
    description?: string;
    priority?: number;
    blocked?: { reason: string; at: string } | null;
    effort_level?: EffortLevelName | null;
  } = {},
): Issue {
  return {
    schema_version: 10,
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
    priority:
      seed.priority !== undefined ? clampPriority(seed.priority) : PRIORITY_DEFAULT,
    position: null,
    triage: emptyTriage(),
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: null,
    waiting_on: null,
    blocked: seed.blocked ?? null,
    requires_human: null,
    conflict_on: [],
    effort_level: seed.effort_level ?? null,
    history: [],
    db_updated_at: new Date().toISOString(),
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
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
 *    `validateHistory` (parse-time) is intentionally permissive so an
 *    entry from a future writer with an unknown actor prefix round-trips.
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
      // Drop optional `from` / `to` / `note` when undefined so an entry
      // that doesn't carry the field round-trips without growing
      // synthetic null keys (which would diverge from the byte-stable
      // form the rest of the schema commits to).
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
    // when no agent owns it.
    assigned_agent: issue.assigned_agent,
    // `waiting_on` carries `null` (default) or a record with
    // reason/timestamp/by[].
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
            // v10 — DX-592 renamed `timestamp` → `at` for consistency
            // with every other timestamp field on the schema.
            at: issue.blocked.at,
          },
    // `requires_human` is the orthogonal "this card needs a human"
    // indicator (DX-231). Position after `blocked` so a reader scanning
    // the YAML sees every dispatch gate adjacent. Field is `null` when
    // no human action is needed. Independent from `blocked` and
    // `waiting_on`.
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
    // `db_updated_at` (v9) — ISO 8601 timestamp of the most recent DB
    // upsert of this card's canonical content. Phase 2 wires the
    // synchronous DB-mirror write; Phase 1 (DX-546) just lands the
    // field on every save. Empty string serializes as YAML `""` — the
    // "never-mirrored" sentinel for fresh cards that have not yet hit
    // the mirror path.
    db_updated_at: issue.db_updated_at,
    // v10 (DX-592) computed-timestamp fields. Position at the tail of
    // the document so v9 YAMLs migrated forward via
    // `migrations/registry.ts#migrateForward` re-serialize stably (the
    // new keys simply append to the existing structure). Each is
    // `string | null`; null is the "never-recorded" sentinel for
    // cards that pre-date the field. Downstream (DX-575 phase cards
    // gated by parent epic DX-591) wires the dispatch/picker/poller
    // code that stamps these on the appropriate lifecycle events.
    archived_at: issue.archived_at,
    ready_at: issue.ready_at,
    completed_at: issue.completed_at,
    cancelled_at: issue.cancelled_at,
    list_name: issue.list_name,
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
 * implicit default. Every caller MUST supply the active repo's prefix
 * (typically from `RepoContext.issuePrefix`).
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
 * `external_id` is always allowed to be empty (memory-tracker mode +
 * drafts pre-create have no tracker mapping yet); the primary `id` is
 * the strict required-non-empty field. `options.expectedPrefix` is
 * required — pass the active repo's prefix from `RepoContext.issuePrefix`.
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
    schema_version: 10,
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
 * Schema contract (v10 canonical — see schema-version log at top of file):
 *  - `id` is required, non-empty, must match `<PREFIX>-<positive-integer>`
 *    (prefix from `options.expectedPrefix`).
 *  - `external_id` is required as a field but may be empty (memory-tracker
 *    mode + drafts pre-tracker-create have no external mapping yet).
 *  - `children` is required, must be an array of `<PREFIX>-N` strings
 *    (may be empty). Available on every card type. On Epic = ordered
 *    phase cards; on non-epic = ordered sub-cards. Reverse linkage to
 *    `parent_id`.
 *  - `priority` is required; values are clamped into
 *    `[PRIORITY_MIN, PRIORITY_MAX]` and non-finite values fall back to
 *    `PRIORITY_DEFAULT`. The boot sweep stamps a default on any pre-v10
 *    card that lacked the field.
 *  - Anything `schema_version < KNOWN_SCHEMA_MIN` is rejected with the
 *    canonical < MIN error string; the boot sweep is the only path that
 *    should produce a writable MIN-or-MAX file.
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
  let v = value as Record<string, unknown>;

  // schema_version — strict canonical reader (DX-594).
  //
  //   v < KNOWN_SCHEMA_MIN  → reject fail-loud (boot sweep should have
  //                           handled this before any reader saw it).
  //   v == KNOWN_SCHEMA_MIN → migrate forward via the registry
  //                           (defense-in-depth tier for a writer/reader
  //                           race during a schema bump).
  //   v == KNOWN_SCHEMA_MAX → pass through (canonical).
  //   v > KNOWN_SCHEMA_MAX  → warn-and-accept (DX-280 drift protection)
  //                           with silent-downgrade of `Issue.schema_version`
  //                           to MAX on the returned object.
  //
  // Non-integer / missing / non-numeric values reject with the canonical
  // error string the boot sweep + tests grep on.
  if (!("schema_version" in v)) {
    errors.push("missing required field: schema_version");
  } else if (
    typeof v.schema_version !== "number" ||
    !Number.isInteger(v.schema_version) ||
    v.schema_version < KNOWN_SCHEMA_MIN
  ) {
    errors.push(
      `schema_version must be an integer >= ${KNOWN_SCHEMA_MIN} (got ${JSON.stringify(v.schema_version)})`,
    );
  } else if (v.schema_version < KNOWN_SCHEMA_MAX) {
    // Defense-in-depth: the boot sweep should have already migrated this
    // to MAX before any in-process reader saw it. Hand off to the
    // registry; surface any registry failure as a validation error so
    // callers see a consistent `{ok: false, errors}` shape.
    try {
      const migrated = migrateForward(v);
      if (isPlainObject(migrated)) {
        v = migrated as Record<string, unknown>;
      }
    } catch (err) {
      return {
        ok: false,
        errors: [
          `schema migration failed: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  } else if (v.schema_version > KNOWN_SCHEMA_MAX) {
    // Writer bumped past this validator's known max — bundled package is
    // behind. Accept the YAML (cards still load, saves still round-trip),
    // but emit a loud warning so the operator sees the lag and runs
    // `make publish-danx-issue-mcp` to refresh the bundle. Unknown future
    // top-level fields drop on the write side (canonical key set in
    // `serializeIssue`). Per-field validators still fire so a breaking
    // shape change is NOT papered over. Dedup keyed on the unknown
    // version so a 100-card poll tick emits ONE warning per distinct
    // future version, not 100 × N call sites.
    if (!warnedSchemaVersions.has(v.schema_version)) {
      warnedSchemaVersions.add(v.schema_version);
      console.warn(
        `[danx-issue-yaml] schema_version ${v.schema_version} is newer than this validator's known max ${KNOWN_SCHEMA_MAX} — accepting. Run \`make publish-danx-issue-mcp\` from danxbot to refresh the bundled validator.`,
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

  // dispatch — required object (or null when no active dispatch). The
  // poller-managed dispatch record. Missing key parses as `null` so
  // fixtures that omit the field don't have to spell it out.
  let dispatchResult: IssueDispatch | null = null;
  if ("dispatch" in v) {
    const r = validateDispatch(v.dispatch);
    if (typeof r === "string") errors.push(r);
    else dispatchResult = r;
  }

  // status — required, must match the canonical enum.
  if (!("status" in v)) {
    errors.push("missing required field: status");
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

  // triage — required object. Strict mapping shape (no flat alternative).
  let triageResult: IssueTriage | null = null;
  if (!("triage" in v)) {
    errors.push("missing required field: triage");
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

  // `phases` was retired in ISS-81 — `children[]` carries the same info.
  // Unknown top-level keys silently drop on the write side (canonical key
  // set in `serializeIssue`), so no parse-time check is needed.

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

  // waiting_on — dep-chain queue. Optional field. Missing → null.
  // Present must be either YAML null OR `{reason, timestamp, by[]}`.
  //
  // blocked — self-block record. Optional field. Missing → null.
  // Present must be either YAML null OR `{reason, at}` (NO `by[]` —
  // dep-chain payload lives on `waiting_on`).
  let waitingOnResult: WaitingOn | null = null;
  let blockedResult: Blocked | null = null;
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

  // requires_human — optional field. Missing → null. Present must be
  // either YAML null OR `{reason, steps[], set_by, set_at}`. Independent
  // from `blocked` / `waiting_on` — all three are dispatch gates and may
  // co-exist.
  let requiresHumanResult: RequiresHuman | null = null;
  if ("requires_human" in v) {
    const r = validateRequiresHuman(v.requires_human);
    if (typeof r === "string") errors.push(r);
    else requiresHumanResult = r;
  }

  // conflict_on — optional field (v7). Missing → []. Present must be
  // an array of `{id: <PREFIX>-N, reason: non-empty string}`.
  // Independent dispatch gate from `blocked` / `waiting_on` /
  // `requires_human` — see `Issue.conflict_on` docstring for the two-way
  // enforcement contract.
  let conflictOnResult: ConflictOnEntry[] = [];
  if ("conflict_on" in v && v.conflict_on !== null && v.conflict_on !== undefined) {
    const r = validateConflictOn(v.conflict_on, idRegex, idShape);
    if (typeof r === "string") errors.push(r);
    else conflictOnResult = r;
  }

  // db_updated_at — optional field (v9). Missing / null → "" (the
  // "never-mirrored" sentinel for cards that have not yet hit the
  // synchronous DB mirror — DX-545 / DX-546). Present must be a string;
  // anything else fails-loud (a numeric or boolean here would silently
  // route the wrong value into the canonical hash + the DB column).
  // No ISO 8601 shape check — same forgiving discipline as every
  // other timestamp field on the schema (`triage.expires_at`,
  // `dispatch.started_at`, `comments[].timestamp`).
  let dbUpdatedAtResult = "";
  if ("db_updated_at" in v && v.db_updated_at !== null && v.db_updated_at !== undefined) {
    if (typeof v.db_updated_at !== "string") {
      errors.push(
        `db_updated_at must be a string or null (got ${JSON.stringify(v.db_updated_at)})`,
      );
    } else {
      dbUpdatedAtResult = v.db_updated_at;
    }
  }

  // effort_level — optional field (v8). Missing / null → null
  // (canonical "inherit agent default"). Present must be one of the
  // seven canonical EffortLevelName literals (EFFORT_LEVEL_NAMES).
  // Anything else fails-loud — a typo in a hand-edited card would
  // silently route the dispatch through the wrong model/effort tier.
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

  // priority — REQUIRED. Strict canonical reader (DX-594): every v10
  // YAML on disk has been stamped by the boot sweep, so a missing key
  // here means a pre-sweep file slipped through. Out-of-range finite
  // numbers heal by clamp; non-finite / non-numeric values fall back
  // to the default (matches the NaN-from-.nan handling DX-521 pinned).
  let priorityValue = PRIORITY_DEFAULT;
  if (!("priority" in v)) {
    errors.push("missing required field: priority");
  } else {
    priorityValue = clampPriority(v.priority);
  }

  // v10 (DX-592) — five computed-timestamp / projection fields. Each
  // is `string | null`; missing defaults to `null`. Anything that is
  // NOT a string and NOT `null` / `undefined` pushes onto `errors[]`
  // via the shared helper. Hoisted ABOVE the post-validation early-
  // return so the gate at the end sees the same errors[] shape as
  // every sibling field — mirrors the validate-into-local-→-early-
  // return-→-build-issue idiom the rest of the function uses.
  const archivedAtResult = optionalNullableStringResult(v, "archived_at", errors);
  const readyAtResult = optionalNullableStringResult(v, "ready_at", errors);
  const completedAtResult = optionalNullableStringResult(v, "completed_at", errors);
  const cancelledAtResult = optionalNullableStringResult(v, "cancelled_at", errors);
  const listNameResult = optionalNullableStringResult(v, "list_name", errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All required fields present and well-typed; build the validated Issue.
  const issue: Issue = {
    // Hardcoded to the canonical writer version (KNOWN_SCHEMA_MAX). A
    // future-version-accepted parse (v.schema_version > KNOWN_SCHEMA_MAX)
    // silent-downgrades here — the returned `Issue.schema_version` is
    // type-literal `KNOWN_SCHEMA_MAX`, never the future value seen on
    // disk. Lockstep contract: when the writer bumps, bump this literal
    // AND KNOWN_SCHEMA_MAX above in the same commit (the `lockstep
    // invariant` test pins both directions).
    schema_version: 10,
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
    db_updated_at: dbUpdatedAtResult,
    // v10 (DX-592). Missing on disk → null (the "never-recorded"
    // sentinel for v9 cards migrated forward via the registry, and
    // for fresh v10 cards that have not yet hit the lifecycle event
    // that stamps the field). Validated above via
    // `optionalNullableStringResult` so a hand-typo (number/boolean)
    // fails loud rather than silently routing the wrong value into
    // the canonical hash.
    archived_at: archivedAtResult,
    ready_at: readyAtResult,
    completed_at: completedAtResult,
    cancelled_at: cancelledAtResult,
    list_name: listNameResult,
  };
  return { ok: true, issue };
}

/**
 * Parse-time helper for v10's five computed-timestamp / projection
 * fields (`archived_at`, `ready_at`, `completed_at`, `cancelled_at`,
 * `list_name`). Shape: `string | null` with `null` as the default for
 * missing keys. Anything that is NOT a string and NOT `null` /
 * `undefined` fails loud — same forgiving discipline as
 * `db_updated_at` (v9) which already uses the same defaulting shape.
 *
 * Errors are pushed onto the caller's `errors[]` so the validator can
 * surface every defect in one pass; the returned value is `null` on
 * error so the type checker sees a valid `string | null` regardless.
 * The caller is responsible for the `errors.length > 0` early-return
 * gate AFTER all five fields are read.
 */
function optionalNullableStringResult(
  v: Record<string, unknown>,
  key: string,
  errors: string[],
): string | null {
  if (!(key in v)) return null;
  const raw = v[key];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    errors.push(`${key} must be a string or null (got ${JSON.stringify(raw)})`);
    return null;
  }
  return raw;
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
  // YAML with too many entries instead of failing parse.
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
 * Validate the v10 `blocked` self-block field. Shape: `{reason, at}`.
 * NO `by[]` (that's `waiting_on.by`). A half-migrated YAML carrying
 * `by` on `blocked` rejects fail-loud here so the half-migrated state
 * doesn't silently round-trip. v9 inputs reach this function via
 * `migrateForward` in `validateIssue`, which renames the v9-era
 * `.timestamp` key to v10's `.at` before per-field validation.
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
  if (typeof v.at !== "string" || v.at.length === 0) {
    return "blocked.at must be a non-empty string";
  }
  if ("by" in v) {
    return "blocked must NOT carry 'by' — use 'waiting_on' for dep-chain queues";
  }
  return { reason: v.reason, at: v.at };
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
