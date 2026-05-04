import { parse as parseYamlText, stringify as stringifyYaml, YAMLParseError } from "yaml";
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  PHASE_STATUSES,
  type Issue,
  type IssueAcItem,
  type IssueComment,
  type IssuePhase,
  type IssueRetro,
  type IssueStatus,
  type IssueTriaged,
  type IssueType,
  type PhaseStatus,
} from "./interface.js";
import { BOOKKEEPING_SEP } from "./sync.js";

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
 *  - parent_id, dispatch_id: null
 *  - children: []
 *  - status: "ToDo"
 *  - type: "Feature"
 *  - title, description: ""
 *  - triaged: { timestamp: "", status: "", explain: "" }
 *  - ac, phases, comments: []
 *  - retro: { good: "", bad: "", action_items: [], commits: [] }
 */
export function createEmptyIssue(seed: {
  id?: string;
  external_id?: string;
  status?: IssueStatus;
  type?: IssueType;
  title?: string;
  description?: string;
} = {}): Issue {
  return {
    schema_version: 3,
    tracker: "memory",
    id: seed.id ?? "",
    external_id: seed.external_id ?? "",
    parent_id: null,
    children: [],
    dispatch_id: null,
    status: seed.status ?? "ToDo",
    type: seed.type ?? "Feature",
    title: seed.title ?? "",
    description: seed.description ?? "",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [],
    phases: [],
    comments: [],
    retro: { good: "", bad: "", action_items: [], commits: [] },
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
    dispatch_id: issue.dispatch_id,
    status: issue.status,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    triaged: {
      timestamp: issue.triaged.timestamp,
      status: issue.triaged.status,
      explain: issue.triaged.explain,
    },
    ac: issue.ac.map((item) => ({
      check_item_id: item.check_item_id,
      title: item.title,
      checked: item.checked,
    })),
    phases: issue.phases.map((p) => ({
      check_item_id: p.check_item_id,
      title: p.title,
      status: p.status,
      notes: p.notes,
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
      action_items: [...issue.retro.action_items],
      commits: [...issue.retro.commits],
    },
  };

  return stringifyYaml(doc, { lineWidth: 0 });
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
 */
export function parseIssue(text: string): Issue {
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new IssueParseError(`Malformed YAML: ${err.message}`);
    }
    throw new IssueParseError(`Malformed YAML: ${String(err)}`);
  }
  const result = validateIssue(raw);
  if (!result.ok) {
    throw new IssueParseError(
      `Invalid Issue YAML:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return result.issue;
}

/**
 * Format check for an internal issue id. The id-generator emits this format
 * exclusively (`ISS-<positive-integer>`); the validator enforces it so a
 * typo'd or hand-written id is rejected at YAML parse time.
 */
export const ISSUE_ID_REGEX = /^ISS-\d+$/;

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
 *    empty). Reverse linkage to `parent_id`. Only Epic-typed issues
 *    populate it; non-epics carry `[]`.
 *  - v1 / v2 documents are rejected with a migration suggestion — there is
 *    NO runtime backwards-compat shim. Run `scripts/migrate-issues-to-v3.ts`
 *    once on each repo to upgrade.
 */
export function validateIssue(value: unknown): ValidateResult {
  const errors: string[] = [];

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
    errors.push(`schema_version must be 3 (got ${JSON.stringify(v.schema_version)})`);
  }

  // tracker
  if (!("tracker" in v)) {
    errors.push("missing required field: tracker");
  } else if (typeof v.tracker !== "string" || v.tracker.length === 0) {
    errors.push("tracker must be a non-empty string");
  }

  // id — internal primary id, always non-empty, must match ISS-N format.
  if (!("id" in v)) {
    errors.push("missing required field: id");
  } else if (typeof v.id !== "string") {
    errors.push("id must be a string");
  } else if (v.id.length === 0) {
    errors.push("id must be a non-empty string (format: ISS-<positive integer>)");
  } else if (!ISSUE_ID_REGEX.test(v.id)) {
    errors.push(
      `id must match ISS-<positive integer> (got ${JSON.stringify(v.id)})`,
    );
  }

  // external_id — required as a field; empty string is permitted (memory
  // tracker issues + drafts pre-create have no external mapping yet).
  if (!("external_id" in v)) {
    errors.push("missing required field: external_id");
  } else if (typeof v.external_id !== "string") {
    errors.push("external_id must be a string");
  }

  // parent_id
  if (!("parent_id" in v)) {
    errors.push("missing required field: parent_id");
  } else if (v.parent_id !== null && typeof v.parent_id !== "string") {
    errors.push("parent_id must be a string or null");
  }

  // children — required array of `ISS-N` strings (may be empty).
  let childrenResult: string[] | null = null;
  if (!("children" in v)) {
    errors.push("missing required field: children");
  } else {
    const r = validateChildrenList(v.children);
    if (typeof r === "string") errors.push(r);
    else childrenResult = r;
  }

  // dispatch_id
  if (!("dispatch_id" in v)) {
    errors.push("missing required field: dispatch_id");
  } else if (v.dispatch_id !== null && typeof v.dispatch_id !== "string") {
    errors.push("dispatch_id must be a string or null");
  }

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

  // triaged — required.
  let triaged: IssueTriaged | null = null;
  if (!("triaged" in v)) {
    errors.push("missing required field: triaged");
  } else {
    const r = validateTriaged(v.triaged);
    if (typeof r === "string") errors.push(r);
    else triaged = r;
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

  // phases — required.
  let phasesResult: IssuePhase[] | null = null;
  if (!("phases" in v)) {
    errors.push("missing required field: phases");
  } else {
    const r = validatePhasesList(v.phases);
    if (typeof r === "string") errors.push(r);
    else phasesResult = r;
  }

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
    const r = validateRetro(v.retro);
    if (typeof r === "string") errors.push(r);
    else retroResult = r;
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
    dispatch_id: v.dispatch_id as string | null,
    status: v.status as IssueStatus,
    type: v.type as IssueType,
    title: v.title as string,
    description: description as string,
    triaged: triaged as IssueTriaged,
    ac: acResult as IssueAcItem[],
    phases: phasesResult as IssuePhase[],
    comments: commentsResult as IssueComment[],
    retro: retroResult as IssueRetro,
  };
  return { ok: true, issue };
}

function validateTriaged(value: unknown): IssueTriaged | string {
  // null is permitted at the YAML level and means "no triage record yet" —
  // it normalizes to a fully-empty IssueTriaged.
  if (value === null) {
    return { timestamp: "", status: "", explain: "" };
  }
  if (!isPlainObject(value)) return "triaged must be a mapping";
  const v = value as Record<string, unknown>;
  if (v.timestamp !== undefined && typeof v.timestamp !== "string") {
    return "triaged.timestamp must be a string";
  }
  if (v.status !== undefined && typeof v.status !== "string") {
    return "triaged.status must be a string";
  }
  if (v.explain !== undefined && typeof v.explain !== "string") {
    return "triaged.explain must be a string";
  }
  return {
    timestamp: typeof v.timestamp === "string" ? v.timestamp : "",
    status: typeof v.status === "string" ? v.status : "",
    explain: typeof v.explain === "string" ? v.explain : "",
  };
}

function validateChildrenList(value: unknown): string[] | string {
  // null normalizes to empty list (yaml has no native "empty array" sigil
  // distinct from null when the key is present with no value).
  if (value === null) return [];
  if (!Array.isArray(value)) return "children must be a list of ISS-N strings";
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string") {
      return `children[${i}] must be a string`;
    }
    if (!ISSUE_ID_REGEX.test(item)) {
      return `children[${i}] must match ISS-<positive integer> (got ${JSON.stringify(item)})`;
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

function validatePhasesList(value: unknown): IssuePhase[] | string {
  if (value === null) return [];
  if (!Array.isArray(value)) return "phases must be a list";
  const out: IssuePhase[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) return `phases[${i}] must be a mapping`;
    const v = item as Record<string, unknown>;
    if (typeof v.check_item_id !== "string") {
      return `phases[${i}].check_item_id must be a string`;
    }
    if (typeof v.title !== "string") {
      return `phases[${i}].title must be a string`;
    }
    if (!PHASE_STATUSES.includes(v.status as PhaseStatus)) {
      return `phases[${i}].status must be one of [${PHASE_STATUSES.join(", ")}] (got ${JSON.stringify(v.status)})`;
    }
    if (v.notes !== undefined && typeof v.notes !== "string") {
      return `phases[${i}].notes must be a string`;
    }
    out.push({
      check_item_id: v.check_item_id,
      title: v.title,
      status: v.status as PhaseStatus,
      notes: typeof v.notes === "string" ? v.notes : "",
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

function validateRetro(value: unknown): IssueRetro | string {
  if (value === null) {
    return { good: "", bad: "", action_items: [], commits: [] };
  }
  if (!isPlainObject(value)) return "retro must be a mapping";
  const v = value as Record<string, unknown>;
  if (v.good !== undefined && typeof v.good !== "string") {
    return "retro.good must be a string";
  }
  if (v.bad !== undefined && typeof v.bad !== "string") {
    return "retro.bad must be a string";
  }
  let actionItems: string[] = [];
  if (v.action_items !== undefined) {
    if (!Array.isArray(v.action_items)) {
      return "retro.action_items must be a list of strings";
    }
    for (let i = 0; i < v.action_items.length; i++) {
      if (typeof v.action_items[i] !== "string") {
        return `retro.action_items[${i}] must be a string`;
      }
      // The worker's action-items bookkeeping comment uses
      // `BOOKKEEPING_SEP` (U+0009 TAB) as its `<title><sep><external_id>`
      // separator (see `src/issue-tracker/sync.ts`). Allowing the
      // separator in a title would break the parser and silently
      // misattribute spawned-card ids on reread, so we reject it at
      // validate time instead of escaping. Use a space or `:` for
      // separators in titles. Arrow lookalikes (`->`, `=>`, `→`, `⟶`,
      // `➔`, etc.) are inert under the tab-separator design and are
      // accepted as ordinary title text.
      if ((v.action_items[i] as string).includes(BOOKKEEPING_SEP)) {
        return `retro.action_items[${i}] must not contain a tab character (reserved separator in the worker's bookkeeping comment)`;
      }
    }
    actionItems = v.action_items as string[];
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
    action_items: actionItems,
    commits,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
