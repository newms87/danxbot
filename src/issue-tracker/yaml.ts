import {
  parse as parseYamlText,
  stringify as stringifyYaml,
  YAMLParseError,
} from "yaml";
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  type CreateCardInput,
  type Issue,
  type IssueAcItem,
  type IssueBlocked,
  type IssueComment,
  type IssueDispatch,
  type IssueIce,
  type IssueRetro,
  type IssueStatus,
  type IssueTriage,
  type IssueTriageHistoryEntry,
  type IssueType,
} from "./interface.js";

const TRIAGE_HISTORY_CAP = 10;
const VALID_DISPATCH_KINDS: ReadonlySet<string> = new Set(["work", "triage"]);

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
 *  - schema_version: 3
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
 */
export function createEmptyIssue(
  seed: {
    id?: string;
    external_id?: string;
    status?: IssueStatus;
    type?: IssueType;
    title?: string;
    description?: string;
  } = {},
): Issue {
  return {
    schema_version: 3,
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
    triage: emptyTriage(),
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
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
    retro: {
      good: issue.retro.good,
      bad: issue.retro.bad,
      action_item_ids: [...issue.retro.action_item_ids],
      commits: [...issue.retro.commits],
    },
    // `blocked` carries `null` (default) or a record with reason/timestamp/by[].
    // Position after `retro` keeps the canonical key order stable for older
    // YAMLs that omit the field — they parse with `blocked: null` defaulted in
    // and re-serialize at the end of the document.
    blocked:
      issue.blocked === null
        ? null
        : {
            reason: issue.blocked.reason,
            timestamp: issue.blocked.timestamp,
            by: [...issue.blocked.by],
          },
  };

  return stringifyYaml(doc, { lineWidth: 0 });
}

/**
 * Single source of truth for the legacy default issue id prefix. Used by
 * the `parseIssue`/`validateIssue` `expectedPrefix` fallback, the
 * `nextIssueId`/`maxIssueNumber` `prefix` fallback, and `loadIssuePrefix`'s
 * absent-config fallback. Exported so Phase 4 of ISS-99 only has to grep
 * one symbol when dropping the legacy compat path.
 */
export const DEFAULT_ISSUE_PREFIX = "ISS";

/**
 * Allowed shape for any per-repo `issue_prefix` value: 2-4 uppercase ASCII
 * letters. Long enough to be visually distinct between repos
 * (`DX`/`SG`/`FD`), short enough that prefixed ids stay scannable. Lives
 * here (not in `repo-context.ts`) so `id-generator.ts` and `yaml.ts` can
 * validate prefixes without taking a dep on the env-heavy config chain.
 */
export const ISSUE_PREFIX_SHAPE = /^[A-Z]{2,4}$/;

/**
 * Optional knobs accepted by `parseIssue` and `validateIssue`. Phase 1 of
 * ISS-99 introduced the `expectedPrefix` knob so the validator can enforce
 * a per-repo `<PREFIX>-<N>` id shape (e.g. `DX-12`, `SG-7`) instead of the
 * historical `ISS-` literal. Defaults to `DEFAULT_ISSUE_PREFIX` so every
 * existing caller keeps the legacy behavior until the consumer threads its
 * real prefix.
 */
export interface ParseIssueOptions {
  /**
   * Per-repo issue id prefix the validator should enforce. 2-4 uppercase
   * letters; supplied by the caller from `RepoContext.issuePrefix`. The
   * validator builds `^${expectedPrefix}-\d+$` from this value and rejects
   * any `id` / `parent_id` / `children[i]` / `blocked.by[i]` /
   * `retro.action_item_ids[i]` that doesn't match.
   */
  expectedPrefix?: string;
}

/**
 * Parse YAML text into an Issue, throwing IssueParseError with a useful
 * message on either malformed YAML or schema violations.
 *
 * In schema v3, `external_id` is always allowed to be empty (memory tracker
 * issues + drafts pre-create have no tracker mapping yet), so there is no
 * separate "draft" parse mode — the v1 `parseDraftIssue` is gone. The
 * primary id (`id`) is the strict required-non-empty field. v3 adds the
 * `children: string[]` field for two-way epic ↔ phase linkage.
 *
 * `options.expectedPrefix` (optional, defaults to `"ISS"`) controls the
 * per-repo id shape — Phase 1 of ISS-99.
 */
export function parseIssue(text: string, options?: ParseIssueOptions): Issue {
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
 * Legacy literal for the `ISS-<N>` id shape. Retained as a named
 * constant for one release — Phase 3 of ISS-99 (the migration script)
 * uses it to identify pre-migration filenames, and any future code that
 * needs to detect "old-style ids" goes through this constant rather
 * than re-introducing a literal `/^ISS-\d+$/` regex.
 */
export const LEGACY_ISS_REGEX = /^ISS-\d+$/;

/**
 * @deprecated Use `buildIssueIdRegex(prefix)` with the active repo's
 * prefix from `RepoContext.issuePrefix`. Kept as a name-only alias for
 * one release so legacy import sites compile while Phase 1 of ISS-99
 * threads the prefix through every consumer. Equivalent to
 * `LEGACY_ISS_REGEX` and `buildIssueIdRegex("ISS")`.
 */
export const ISSUE_ID_REGEX = LEGACY_ISS_REGEX;

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
    schema_version: 3,
    tracker: issue.tracker,
    id: issue.id,
    parent_id: issue.parent_id,
    children: [...issue.children],
    status: issue.status,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    triage: cloneTriage(issue.triage),
    ac: issue.ac.map((a) => ({ title: a.title, checked: a.checked })),
    comments: issue.comments.map((c) => ({ ...c })),
    retro: {
      good: issue.retro.good,
      bad: issue.retro.bad,
      action_item_ids: [...issue.retro.action_item_ids],
      commits: [...issue.retro.commits],
    },
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
 *  - `external_id` is required as a field but may be empty (memory tracker
 *    issues + drafts pre-tracker-create have no external mapping yet).
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
  options?: ParseIssueOptions,
): ValidateResult {
  const errors: string[] = [];
  const expectedPrefix = options?.expectedPrefix ?? DEFAULT_ISSUE_PREFIX;
  const idRegex = buildIssueIdRegex(expectedPrefix);
  const idShape = `${expectedPrefix}-<positive integer>`;

  if (!isPlainObject(value)) {
    return { ok: false, errors: ["Issue must be a YAML mapping"] };
  }
  const v = value as Record<string, unknown>;

  // schema_version — v3 only. Reject older versions with a loud migration
  // pointer. v1 was retired by `migrate-issues-to-v2`; v2 is retired by
  // `migrate-issues-to-v3` (adds the required `children: []` field).
  if (!("schema_version" in v)) {
    errors.push("missing required field: schema_version");
  } else if (v.schema_version === 1 || v.schema_version === 2) {
    errors.push(
      `schema_version ${v.schema_version} is no longer supported — run scripts/migrate-issues-to-v3.ts to upgrade`,
    );
  } else if (v.schema_version !== 3) {
    errors.push(
      `schema_version must be 3 (got ${JSON.stringify(v.schema_version)})`,
    );
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

  // status
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

  // blocked — optional field. Missing → null. Present must be either YAML
  // null OR a fully-formed `{reason, timestamp, by[]}` mapping. Tolerating
  // absence keeps pre-`blocked` YAMLs round-trippable; presence must validate
  // strictly so a half-written blocked record fails loud instead of silently
  // un-blocking the card.
  let blockedResult: IssueBlocked | null = null;
  if ("blocked" in v) {
    const r = validateBlocked(v.blocked, idRegex, idShape);
    if (typeof r === "string") errors.push(r);
    else blockedResult = r;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All required fields present and well-typed; build the validated Issue.
  const issue: Issue = {
    schema_version: 3,
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
    triage: triageResult as IssueTriage,
    ac: acResult as IssueAcItem[],
    comments: commentsResult as IssueComment[],
    retro: retroResult as IssueRetro,
    blocked: blockedResult,
  };
  return { ok: true, issue };
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
    kind: v.kind as "work" | "triage",
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
    if (typeof v.check_item_id !== "string") {
      return `ac[${i}].check_item_id must be a string`;
    }
    if (typeof v.title !== "string") {
      return `ac[${i}].title must be a string`;
    }
    if (typeof v.checked !== "boolean") {
      return `ac[${i}].checked must be a boolean`;
    }
    out.push({
      check_item_id: v.check_item_id,
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

function validateBlocked(
  value: unknown,
  idRegex: RegExp,
  idShape: string,
): IssueBlocked | null | string {
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
  if (!Array.isArray(v.by)) {
    return `blocked.by must be a list of ${idShape} strings`;
  }
  if (v.by.length === 0) {
    return "blocked.by must contain at least one issue id";
  }
  const by: string[] = [];
  for (let i = 0; i < v.by.length; i++) {
    const item = v.by[i];
    if (typeof item !== "string") {
      return `blocked.by[${i}] must be a string`;
    }
    if (!idRegex.test(item)) {
      return `blocked.by[${i}] must match ${idShape} (got ${JSON.stringify(item)})`;
    }
    by.push(item);
  }
  return { reason: v.reason, timestamp: v.timestamp, by };
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
    for (let i = 0; i < v.commits.length; i++) {
      if (typeof v.commits[i] !== "string") {
        return `retro.commits[${i}] must be a string`;
      }
    }
    commits = v.commits as string[];
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
