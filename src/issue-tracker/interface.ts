/**
 * Tracker-agnostic interface for issue tracking systems.
 *
 * Identity model:
 *  - `id` (`ISS-N`): the internal, locally-generated, ALWAYS-PRESENT primary
 *    key for an issue. Stable across the issue's lifetime. The on-disk file
 *    is named `<id>.yml`. Every agent-facing surface (skills, MCP tools,
 *    dispatch prompts) refers to issues by `id` only — agents do not know
 *    that external trackers exist.
 *  - `external_id`: tracker-native id (e.g. Trello card id). Empty when the
 *    issue has not been pushed to any external tracker (memory tracker,
 *    pre-create draft). Only the sync layer and tracker implementations
 *    consume `external_id`; never expose it to agents.
 *
 * Tracker implementations (TrelloTracker, MemoryTracker) translate the YAML
 * schema's status / type values to backend-native concepts (list IDs, label
 * IDs) internally. No tracker-native concepts leak through this interface.
 *
 * The IssueTracker methods continue to take `externalId` as their lookup key
 * because that IS the tracker's native concept. Higher layers map `id ↔
 * external_id` via the YAML's two id fields.
 */

/**
 * Open-issue status enum.
 *
 * `Blocked` is the non-dispatchable parking status for cards that cannot
 * make progress on their own work — the card itself is blocked. A human
 * (or a subsequent agent run) must clear the block. Distinct from:
 *  - `Issue.waiting_on` field — the card is waiting on OTHER cards in
 *    `waiting_on.by[]` to reach a terminal status before it can start. The
 *    card's own work is fine; it's queued behind dependencies. Cards with
 *    a non-null `waiting_on` keep `status: "ToDo"` (worker enforces).
 *  - `Issue.requires_human` field — orthogonal indicator; the card needs
 *    human-only action (3rd-party token rotation, credential rotation,
 *    ambiguous spec). DX-231 retired the parking `"Needs Approval"`
 *    status in favor of this orthogonal field; the loader fail-loud
 *    rejects YAMLs carrying the legacy status.
 *
 * Invariant: `status === "Blocked" ⟺ Issue.blocked !== null`. The two
 * carry the same fact (current self-block); the field carries the
 * human-readable reason and timestamp; the status is the index lookup.
 */
export type IssueStatus =
  | "Review"
  | "ToDo"
  | "In Progress"
  | "Blocked"
  | "Done"
  | "Cancelled";

export type IssueType = "Epic" | "Bug" | "Feature" | "Chore";

export interface IssueRef {
  /** Internal id (`ISS-N`). Empty for refs from a tracker that has not yet been reconciled with a local YAML. */
  id: string;
  external_id: string;
  title: string;
  status: IssueStatus;
}

export interface IssueAcItem {
  check_item_id: string;
  title: string;
  checked: boolean;
}

export interface IssueComment {
  /** Tracker-native id; absent for local-only comments not yet pushed. */
  id?: string;
  author: string;
  timestamp: string;
  text: string;
}

/**
 * ICE score (Impact × Confidence × Ease) — populated by the triage agent.
 * Each axis is 0 (unscored) or 1-5; `total` is `i × c × e` cached for the
 * dispatch sort path so it doesn't recompute on every tick.
 */
export interface IssueIce {
  total: number;
  i: number;
  c: number;
  e: number;
}

/**
 * One historical triage decision. The triage agent appends one of these to
 * `triage.history[]` every time it touches the card, capping at 10 entries
 * (oldest dropped on overflow). `last_*` fields on `IssueTriage` mirror the
 * most recent entry for fast read-back without walking the array.
 */
export interface IssueTriageHistoryEntry {
  timestamp: string;
  status: string;
  explain: string;
  expires_at: string;
  ice: IssueIce;
}

/**
 * Per-card triage record.
 *
 * Replaces the older flat `IssueTriaged {timestamp, status, explain}` block
 * with a TTL-driven structure so the poller can re-triage stale cards on a
 * cadence (Phase 1 of the poller-triage rework, ISS-90 / ISS-91).
 *
 *  - `expires_at`: ISO 8601 — when this triage decision needs re-evaluation.
 *    Empty string forces re-triage on the next poll (newly hydrated cards
 *    and post-migration cards default to `""`).
 *  - `reassess_hint`: 1-line note from the previous triage agent describing
 *    how the next agent can re-check quickly (e.g. "If gpt-manager has
 *    deployed, can demote to ToDo").
 *  - `last_status` / `last_explain`: the most recent decision (mirror of
 *    `history[history.length-1]`) so callers don't walk the array for hot
 *    reads. Allowed values for `last_status` are agent-determined — today
 *    one of `Keep | Cancel | Approve | Demote | Confirm-Block`, but the
 *    schema enforces only "string", so future agents can extend without a
 *    schema bump.
 *  - `ice`: most recent ICE score. Mirrors `history[history.length-1].ice`.
 *  - `history`: append-only audit log capped at 10 entries (oldest dropped
 *    on overflow). Used for "why was this card recently confirmed-blocked"
 *    diagnostics and the dashboard's triage timeline.
 */
export interface IssueTriage {
  expires_at: string;
  reassess_hint: string;
  last_status: string;
  last_explain: string;
  ice: IssueIce;
  history: IssueTriageHistoryEntry[];
}

/**
 * Single source of truth for "has this card been triaged?" — used by every
 * tracker implementation (`MemoryTracker`, `TrelloTracker`) and the outbound
 * sync layer (`syncIssue`) to derive the `triaged` managed-label boolean.
 *
 * A card counts as triaged when EITHER:
 *  - `last_status` is non-empty (the triage agent recorded its most recent
 *    decision), OR
 *  - `history[]` is non-empty (a decision was recorded but `last_status`
 *    was cleared by a malformed write — the audit log is the fallback
 *    source of truth).
 *
 * Three call sites used to compute this inline with two slightly different
 * rules; consolidating the logic here keeps tracker implementations and
 * the sync-layer label diff in lockstep so a future agent that writes
 * only to `history[]` (or only `last_*`) doesn't trigger label drift.
 */
export function isTriaged(t: IssueTriage): boolean {
  return t.last_status !== "" || t.history.length > 0;
}

/**
 * Active dispatch tracking — replaces the bare `dispatch_id: string|null`
 * field. Populated by the poller when it spawns a Claude Code process for
 * the card; cleared when the dispatch terminates. Phase 2 of the
 * poller-triage rework adds PID-based liveness + reattach-on-restart;
 * Phase 1 (this card) just lands the schema shape so consumers can read
 * the new fields without a second migration.
 */
export interface IssueDispatch {
  /** Poller-generated UUID. Unique across the dispatch's lifetime. */
  id: string;
  /** OS PID on the host running the dispatched Claude process. 0 = unknown. */
  pid: number;
  /** Hostname for cross-host correlation. Empty = unknown. */
  host: string;
  /**
   * Which dispatch class is occupying this slot.
   *
   * - `work` — normal issue-worker dispatch (poller picks a ToDo card).
   * - `triage` — triage agent (auto-triage poll loop, see `danx-triage-card` skill).
   * - `recovery` — branch-state recovery dispatch (DX-161 / multi-worker
   *   epic). Worker pre-flight detected the agent's worktree is dirty or
   *   divergent from `origin/main`; the spawn runs a recovery prompt that
   *   forbids destructive ops and asks the agent to finish any WIP card,
   *   commit, and exit clean. After completion the worker re-runs validation
   *   before dispatching the next normal `work` slot.
   */
  kind: "work" | "triage" | "recovery";
  /** ISO 8601 dispatch start. Empty = unknown. */
  started_at: string;
  /** Liveness threshold (seconds). Phase 2 enforces; Phase 1 ignores. */
  ttl_seconds: number;
}

/**
 * Append-only audit log of `status` / `blocked` transitions and the `created`
 * event. Maintained by the worker write-paths (Phase 2 of DX-138) and the
 * auto-mutation paths (Phase 3 of DX-138). Phase 1 (this card) lands the
 * on-disk shape only — no write-paths populate `history[]` yet.
 *
 * `event` enum:
 *  - `created` — exactly one entry per card. Pushed by `danx_issue_create`
 *    (worker route) and by inbound tracker hydrate (`bulkSyncMissingYamls`).
 *  - `status_change` — `status` changed between the loaded YAML and the saved
 *    YAML. `from` + `to` both required.
 *  - `blocked` — `blocked` transitioned `null → record`. `to` carries the
 *    forced `ToDo` status the worker imposes; `from` may be omitted.
 *  - `unblocked` — `blocked` transitioned `record → null`. Worker auto-clears
 *    on all blockers terminal.
 *
 * `actor` is the audit identity that performed the mutation. Format
 * `<source>:<id>` — canonical sources today: `dispatch:<uuid>`,
 * `dashboard:<username>`, `worker:<reason>` (e.g. `worker:auto-derive`,
 * `worker:heal`), `tracker:<name>` (e.g. `tracker:trello`). Bare `setup`
 * and `unknown` are also accepted. The validator does NOT enforce the
 * format on parse — historical entries with future actor prefixes must
 * round-trip — the format check lives at append-time only.
 */
export type IssueHistoryEvent =
  | "created"
  | "status_change"
  | "blocked"
  | "unblocked";

export interface IssueHistoryEntry {
  /** ISO 8601, server-side wall clock. Validator does NOT parse the format. */
  timestamp: string;
  /** Required, non-empty. Format `<source>:<id>` OR bare `setup` / `unknown`. */
  actor: string;
  event: IssueHistoryEvent;
  /** Required for `status_change`. Optional for `blocked`/`unblocked`/`created`. */
  from?: IssueStatus;
  /** Required for every event except (optionally) `unblocked`. */
  to?: IssueStatus;
  /**
   * Optional human-readable note. Capped at 200 chars on append (truncated to
   * 197 chars + `…` ellipsis). Validator tolerates longer existing entries
   * so legacy YAMLs round-trip; truncation is enforced on `appendHistory`.
   */
  note?: string;
}

export interface IssueRetro {
  good: string;
  bad: string;
  /**
   * IDs (`ISS-N`) of pre-existing issue cards filed as action items by the
   * agent during this card's lifecycle. The agent MUST create each action
   * item card via `danx_issue_create` (with full title + description + ac)
   * BEFORE pushing the resulting `ISS-N` here. The worker NEVER spawns cards
   * from this field; on terminal save it just resolves each id to the
   * corresponding issue's `title` for the rendered retro comment. Unknown
   * ids surface as `<ISS-N: unknown>` in the comment so a typo is loud, not
   * silent.
   */
  action_item_ids: string[];
  commits: string[];
}

/**
 * Waiting-on record. Populated when an in-progress card cannot proceed
 * because it is waiting on other in-flight work (a phase sibling, an Action
 * Items card, a separately-scoped task), but the card itself is fine and
 * does NOT need human intervention.
 *
 * The record is a **durable audit trail**: once the agent (or operator)
 * sets it, the worker NEVER auto-clears it — only the agent itself may
 * null it if the original link was a mistake. Effective state is derived
 * at read time by `effectiveWaitingOn` (src/issue/effective-waiting-on.ts):
 * dispatch eligibility and the dashboard "waiting on" pill both treat the
 * card as effectively unblocked once every id in `by[]` resolves to a
 * terminal status (Done / Cancelled), but the raw record stays on disk.
 *
 * Distinct from `status: "Blocked"` + the `Issue.blocked` field, which mean
 * the card itself cannot make progress on its own work — a human (or a
 * subsequent agent run) must act. Cards waiting on other work go to
 * `waiting_on` and stay in `ToDo`. Cards self-blocked move to status
 * `Blocked` with the reason captured on `Issue.blocked.reason`.
 *
 * Invariants enforced by `validateIssue`:
 *  - `reason` non-empty.
 *  - `timestamp` non-empty (caller supplies ISO 8601; the validator does not
 *    parse the format).
 *  - `by[]` non-empty, every entry matches `<PREFIX>-<positive integer>`.
 *
 * When the agent has no existing card to point at, it MUST create one
 * (`danx_issue_create`) describing the unblock work and put that new id in
 * `by[]` — the field is never empty.
 */
export interface WaitingOn {
  reason: string;
  timestamp: string;
  by: string[];
}

/**
 * Self-block record. Populated when the card ITSELF cannot make progress on
 * its own work — broken environment, missing credentials, ambiguous spec,
 * write-only resource, decision input the agent cannot resolve from the
 * codebase, etc. A human (or a subsequent agent dispatch) must clear the
 * block before the card can proceed.
 *
 * Distinct from `Issue.waiting_on` (dep-chain queue) — `waiting_on` keeps
 * `status: "ToDo"` and is a durable record (derived effective-null when
 * every dep is terminal — see `effectiveWaitingOn`). `blocked` parks the
 * card at `status: "Blocked"` until a human or next dispatch clears it.
 *
 * Both fields can technically coexist, but practically rare: a card that is
 * both queued behind deps AND self-blocked. The poller's gates handle each
 * independently.
 *
 * Shape rationale: no `by[]` field. The card's reason is free-text human
 * description of why the card itself is stuck — not a list of other cards
 * (that's `waiting_on.by`). Resolution is a human / next-dispatch judgment,
 * not deterministic dep clearing.
 *
 * Invariants enforced by `validateIssue` + worker write-paths:
 *  - `status === "Blocked" ⟺ blocked !== null` (worker enforces both
 *    directions: setting one without the other is a validation error).
 *  - `reason` non-empty.
 *  - `timestamp` non-empty (caller supplies ISO 8601).
 */
export interface Blocked {
  reason: string;
  timestamp: string;
}

/**
 * Orthogonal "this card needs a human" indicator. DX-231 introduced this
 * field as the replacement for the retired `"Needs Approval"` parking
 * status: instead of overloading `IssueStatus`, the field travels alongside
 * any open status and the poller's dispatch filter skips cards where it is
 * non-null.
 *
 * Independent from `blocked` and `waiting_on`; all three are dispatch gates
 * and may co-exist in principle (in practice rare).
 *
 *  - `reason` — short headline (one sentence) that surfaces in the
 *    dashboard banner and on the Trello card label.
 *  - `steps[]` — ordered list of concrete actions the operator must take
 *    to clear the field. Empty list permitted but discouraged — the
 *    dashboard renders the steps as a numbered checklist; an empty list
 *    means the operator has to read `reason` and infer the actions.
 *  - `set_by` — `"agent"` (rare 3rd-party blockers) or `"human"` (operator
 *    flagged the card themselves via the dashboard). Surfaces in the
 *    audit trail.
 *  - `set_at` — ISO 8601 timestamp the field was populated. Validator
 *    does not parse the format; caller supplies a wall-clock ISO string.
 */
export interface RequiresHuman {
  reason: string;
  steps: string[];
  set_by: "agent" | "human";
  set_at: string;
}

export interface Issue {
  schema_version: 6;
  tracker: string;
  /**
   * Internal primary id (`ISS-N`). Required, non-empty, locally generated by
   * `nextIssueId` from `./id-generator.ts`. Stable across the issue's
   * lifetime. The on-disk filename is `<id>.yml`. Agents only ever see this.
   */
  id: string;
  /**
   * Tracker-native id (e.g. Trello card id). Empty string when not synced
   * to any external tracker (memory tracker, pre-create draft, or a local
   * issue that will never push). Only the sync layer + tracker
   * implementations consume this — never expose it to agents.
   */
  external_id: string;
  /**
   * `parent_id` and `dispatch` are local-only metadata managed by the
   * poller and the danx_issue_create flow. `parent_id` references the
   * parent issue's `id` (NOT `external_id`). The tracker abstraction has
   * no place to store them, so sync passes them through verbatim.
   */
  parent_id: string | null;
  /**
   * Child issue ids (`ISS-N[]`). Available on every card type. Reverse
   * linkage to `parent_id`: each entry in `children` MUST have its own
   * YAML with `parent_id == <this.id>`. Local-only metadata; not synced to
   * any external tracker (parallel to `parent_id`).
   *
   * Two label conventions:
   *  - On `type === "Epic"`, `children[]` IS the ordered list of phase
   *    cards. UI / skills label them **Phases**. One card per phase; phases
   *    are NEVER tracked as an in-card checklist (no `phases[]` field
   *    exists on the schema — that concept was retired in ISS-81).
   *  - On non-epic types (`Bug` / `Feature`), `children[]` is the list of
   *    sub-cards. UI / skills label them **Children**.
   *
   * Maintained by the `danx-epic-link` skill on first epic pickup and by
   * the `danx_issue_create` flow when a new child card is created.
   */
  children: string[];
  /**
   * Active dispatch record OR null when no dispatch is in flight. Replaces
   * the bare `dispatch_id: string|null` schema (retired with the
   * poller-triage rework). Phase 1 introduces the field and migrates every
   * existing YAML; Phase 2 begins populating PID + host on every spawn.
   * The tracker abstraction never sees `dispatch` — it's local-only
   * metadata, same as `parent_id` / `children`.
   */
  dispatch: IssueDispatch | null;
  status: IssueStatus;
  type: IssueType;
  title: string;
  description: string;
  /**
   * Operator-managed priority knob inside a sort bucket. Float in
   * `[1.0, 5.0]`; default `3.0`. Semantics: 1 = very low, 2 = low,
   * 3 = medium, 4 = high, 5 = critical. The float resolution lets
   * operators express ordering inside a bracket (`3.44`, `5.88`)
   * without a coarse five-bucket discretization.
   *
   * The field is consumed by `sortIssuesForStatus` (in
   * `src/issue-tracker/sort.ts`): for the Review / ToDo / Blocked
   * buckets, `priority` DESC tiebreaks ICE-equal cards.
   * In Progress / Done / Cancelled keep `updated_at` DESC and ignore
   * priority. Out-of-range / missing values are clamped to `[1.0, 5.0]`
   * on read by `parseIssue` and missing values default to `3.0`.
   * ISS-210 introduced the field with a v4 → v5 schema bump and the
   * one-off `migrate-issues-priority.ts` backfill.
   */
  priority: number;
  /**
   * Per-card triage record. Replaces the older flat
   * `triaged: {timestamp, status, explain}` block. Newly hydrated cards
   * (poller hydration + agent-create) get a fully empty `triage` (every
   * field empty string / 0; `history: []`); the triage agent populates on
   * first triage. `expires_at: ""` forces re-triage on the next poll —
   * the migration script uses this to backfill every existing open card.
   */
  triage: IssueTriage;
  ac: IssueAcItem[];
  comments: IssueComment[];
  retro: IssueRetro;
  /**
   * Resolved persona name (`AGENT_NAME_SHAPE`) when the multi-worker pick
   * algorithm has claimed this card for a specific agent (DX-200 / DX-158).
   * Stamped at dispatch start by the poller's `pickAgent` step BEFORE the
   * agent spawns; cleared on the next dispatch's pick if the previous
   * agent finished cleanly (or persists when the agent should re-claim
   * the same card on the next eligible tick).
   *
   * `null` when no agent owns the card (every pre-Phase-5 card and every
   * card the multi-agent picker has not yet seen). The mirror's
   * generated column `issues.assigned_agent` (migration 016) reads
   * `data->>'assigned_agent'` directly; production rows that pre-date
   * this field stamp the column NULL automatically.
   */
  assigned_agent: string | null;
  /**
   * Non-null = the card is waiting on the issues listed in `waiting_on.by[]`.
   * Worker forces `status: "ToDo"` whenever this is non-null; poller skips
   * dispatching the card until every dependency in `by[]` reaches a terminal
   * status (Done or Cancelled), at which point the poller clears
   * `waiting_on` and resumes dispatch. See `WaitingOn` for the invariants.
   */
  waiting_on: WaitingOn | null;
  /**
   * Non-null = the card itself is blocked from performing its own task. A
   * human (or a subsequent agent dispatch) must clear the block. Worker
   * enforces the invariant `status === "Blocked" ⟺ blocked !== null` —
   * setting `blocked` without `status: "Blocked"` (or vice versa) is a
   * validation error. See `Blocked` for the shape rationale.
   *
   * Distinct from `waiting_on`: `blocked` is self-block (THIS card can't
   * proceed); `waiting_on` is dep-chain queue (waiting for OTHER cards to
   * finish first). Both can coexist (rare).
   */
  blocked: Blocked | null;
  /**
   * Orthogonal "this card needs a human" indicator. Non-null = the card
   * cannot make progress until a human acts (3rd-party token rotation,
   * credential rotation, ambiguous spec needing a design decision). The
   * poller's dispatch filter skips cards with `requires_human != null`
   * (Phase 2 of DX-231 lands the filter; this phase only lands the
   * schema). Independent from `blocked` and `waiting_on` — all three
   * are dispatch gates and may co-exist.
   *
   * DX-231 introduced this field as the replacement for the retired
   * `"Needs Approval"` parking status. The loader rejects
   * `status: "Needs Approval"` fail-loud; existing cards must be
   * migrated by hand before this phase merges.
   */
  requires_human: RequiresHuman | null;
  /**
   * Append-only audit log of `status` / `blocked` transitions plus the
   * `created` event. Maintained by Phase 2/3 worker write-paths (DX-138);
   * Phase 1 (DX-145) lands the on-disk shape only. Capped at 1000 entries —
   * oldest dropped on overflow. Empty `history: []` is the legacy default;
   * existing YAMLs ship with no entries and acquire them as future
   * mutations land. Position in `serializeIssue`: AFTER `comments`, BEFORE
   * `retro`.
   */
  history: IssueHistoryEntry[];
  /**
   * TRANSIENT, tracker-derived projection of the card's managed labels.
   * Populated by `tracker.getCard()` so `syncIssue`'s outbound label diff
   * can compare against the actual remote label state (the only source of
   * truth on Trello — `triage` / `waiting_on` data fields don't round-trip).
   * NEVER serialized to YAML and NEVER written by agents — the local
   * YAML's `status` / `type` / `triage.last_status` / `waiting_on` fields are
   * the source of truth, and `labels` is recomputed from those at sync
   * time. `parseIssue` ignores it on disk; `serializeIssue` never emits
   * it.
   */
  labels?: ManagedLabels;
}

/**
 * Input shape for createCard — every Issue field that the caller can choose
 * minus the tracker-assigned ids (external_id, check_item_ids).
 *
 * `id` is REQUIRED here because it is locally generated BEFORE the tracker
 * push — the worker assigns the next `ISS-N` to a draft, then asks the
 * tracker to create a card with title prefixed `#<id>: <title>`.
 */
export interface CreateCardInput {
  schema_version: 6;
  tracker: string;
  id: string;
  parent_id: string | null;
  children: string[];
  status: IssueStatus;
  type: IssueType;
  title: string;
  description: string;
  /** See `Issue.priority`. Defaulted to `3.0` by `danx_issue_create`. */
  priority: number;
  triage: IssueTriage;
  ac: Array<{ title: string; checked: boolean }>;
  comments: IssueComment[];
  retro: IssueRetro;
  /**
   * Optional on input — `createCard` always stores `waiting_on: null` on the
   * fresh card. Agents add the `waiting_on` record via subsequent saves.
   */
  waiting_on?: WaitingOn | null;
  /**
   * Optional on input — `createCard` always stores `blocked: null` on the
   * fresh card. Agents add the `blocked` record via subsequent saves when
   * the card itself becomes self-blocked.
   */
  blocked?: Blocked | null;
  /**
   * Optional on input — `createCard` always stores `requires_human: null`
   * on the fresh card. Agents add the `requires_human` record via
   * subsequent saves when the card needs human action (DX-231). Carried
   * here for API symmetry with `blocked` and `waiting_on`; today no
   * production caller passes a non-null value at create time, but the
   * dashboard Phase 5 "Flag for human" affordance and the triage agent's
   * Approve path may.
   */
  requires_human?: RequiresHuman | null;
}

/**
 * The set of "managed" labels danxbot owns on every card. The poller / sync
 * layer derives these booleans from the local YAML's `status`, `triage`,
 * and `blocked` fields and pushes via `setLabels`. Labels not in this set
 * (operator-applied labels) are preserved by tracker implementations'
 * `setLabels` filter.
 *
 * Extracted so adding a new managed label is a one-line edit instead of
 * four (interface signature + setLabels arg shape in trello.ts +
 * memory.ts + sync diff). The booleans are derived data — never store
 * them on the YAML.
 */
export interface ManagedLabels {
  type: IssueType;
  /**
   * `true` ⟺ status === "Blocked". Mapped to the tracker's "Blocked"
   * label. The boolean is derived from `status`, NOT from `Issue.blocked`
   * — the field is the reason cache, the status is the index lookup.
   * Worker enforces the field/status invariant.
   */
  blocked: boolean;
  /**
   * `true` ⟺ `requires_human != null`. DX-231 replaced the legacy
   * `needsApproval` label (driven by the retired `"Needs Approval"`
   * status) with this orthogonal indicator. The setup skill provisions
   * the `requires_human` Trello label in Phase 3; sync auto-applies /
   * strips on field transitions. The tracker label is the visual cue;
   * the structured `RequiresHuman` record (reason, steps, set_by,
   * set_at) stays local-only.
   */
  requires_human: boolean;
  triaged: boolean;
}

export interface IssueTracker {
  fetchOpenCards(): Promise<IssueRef[]>;

  /**
   * Cheap, synchronous shape check: does `id` look like an id this tracker
   * could plausibly own? Used by the per-tick `healExternalIds` pass
   * (DX-150) to detect YAMLs whose `external_id` was minted by a different
   * tracker (e.g. `mem-2` from a `MemoryTracker` window before the repo's
   * Trello config landed). Tracker owns its id format → tracker validates.
   *
   * Implementations MUST NOT make a network call here — this runs against
   * every YAML on every tick and a remote round-trip per id would be
   * prohibitive. The check is pure-format: it answers "could this id ever
   * have come from me?" not "does this id refer to a card I currently
   * have?". A truly-deleted-on-the-tracker id still passes the format
   * check; the missing-card error surfaces later via `getCard` /
   * `getComments` against that id.
   */
  isValidExternalId(id: string): boolean;

  getCard(externalId: string): Promise<Issue>;

  createCard(input: CreateCardInput): Promise<{
    external_id: string;
    ac: { check_item_id: string }[];
  }>;

  /**
   * Patch the card's title / description. When `patch.title` is supplied,
   * the caller SHOULD also supply `patch.id` so tracker implementations
   * that prefix the title with `#<id>: ` (Trello) preserve the prefix
   * without a read round-trip. Implementations that don't prefix titles
   * (memory) ignore `patch.id`.
   */
  updateCard(
    externalId: string,
    patch: { title?: string; description?: string; id?: string },
  ): Promise<void>;

  moveToStatus(externalId: string, status: IssueStatus): Promise<void>;

  setLabels(externalId: string, labels: ManagedLabels): Promise<void>;

  addComment(
    externalId: string,
    text: string,
  ): Promise<{ id: string; timestamp: string }>;

  /**
   * Replace the body of an existing tracker comment in-place.
   *
   * Used by the worker-side retro renderer to keep ONE retro comment per
   * card lifetime — when retro fields change between saves, we EDIT the
   * existing comment rather than POST a duplicate. `commentId` is the
   * tracker-native id returned by `addComment` / `getComments`.
   *
   * Implementations MUST preserve the comment's tracker-native author and
   * timestamp; only the text is replaced. Throw if the comment does not
   * exist on the given card.
   */
  editComment(
    externalId: string,
    commentId: string,
    text: string,
  ): Promise<void>;

  getComments(
    externalId: string,
  ): Promise<
    Array<{ id: string; author: string; timestamp: string; text: string }>
  >;

  addAcItem(
    externalId: string,
    item: { title: string; checked: boolean },
  ): Promise<{ check_item_id: string }>;

  updateAcItem(
    externalId: string,
    checkItemId: string,
    patch: { title?: string; checked?: boolean },
  ): Promise<void>;

  deleteAcItem(externalId: string, checkItemId: string): Promise<void>;
}

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  "Review",
  "ToDo",
  "In Progress",
  "Blocked",
  "Done",
  "Cancelled",
] as const;

export const ISSUE_TYPES: readonly IssueType[] = [
  "Epic",
  "Bug",
  "Feature",
  "Chore",
] as const;
