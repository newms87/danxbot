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
 *    issue has not been pushed to any external tracker (YAML-only mode,
 *    pre-create draft). Only the sync layer and tracker implementations
 *    consume `external_id`; never expose it to agents.
 *
 * Tracker implementations translate the YAML schema's status / type values
 * to backend-native concepts (list IDs, label IDs) internally. No
 * tracker-native concepts leak through this interface.
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
 *    card's own work is fine; it's queued behind dependencies.
 *    Status-independent — the validator allows `waiting_on` at any status
 *    (Review, ToDo, In Progress, Blocked, Done, Cancelled). The picker's
 *    runtime release path (multi-agent-pick) flips an actively-assigned
 *    card to `ToDo` + clears `assigned_agent` when a gate re-fires at
 *    pickup time; that is a runtime side effect, NOT a write-time
 *    invariant.
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
  | "Backlog"
  | "Done"
  | "Cancelled";

export type IssueType = "Epic" | "Bug" | "Feature" | "Chore";

/**
 * Canonical effort-level names for the DX-508 epic's ordered ladder. Cards
 * carry an `effort_level: EffortLevelName | null` field; settings.json
 * carries an `effortLevels[]` array mapping each name to `{model, effort}`
 * for dispatch. `null` on a card means "inherit the agent's default"
 * (resolved by `getAgentEffortLevel` in `src/settings-file.ts`, ultimately
 * defaulting to `"medium"`).
 *
 * Ordering is load-bearing — `min` → `max` corresponds to ascending
 * compute / quality. Position in the literal type IS the canonical order;
 * runtime callers depend on it (settings table row index, dispatch
 * upgrade/downgrade heuristics).
 *
 * Lockstep partner: `src/settings-file.ts#EFFORT_LEVEL_NAMES`. The
 * settings module is the source-of-truth for ordering + defaults; this
 * literal exists so the YAML validator can reject unknown names without
 * importing the settings module (which would pull `node:fs/promises` +
 * logger into every parseIssue call). The dashboard SPA's redeclaration
 * (`dashboard/src/types.ts`) is pinned in lockstep by
 * `dashboard/src/__tests__/effort-levels-lockstep.test.ts`.
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

export interface IssueRef {
  /** Internal id (`ISS-N`). Empty for refs from a tracker that has not yet been reconciled with a local YAML. */
  id: string;
  external_id: string;
  title: string;
  /**
   * Tracker-native list id the card lives on at fetch time (e.g. Trello's
   * `idList`). DX-621 / Phase 9d retired `IssueRef.status` — the only
   * inbound mapping from tracker list → danxbot list type now goes
   * through `external_list_id` + the per-repo `trello-list-map.yaml`
   * reverse-walk. Always populated by the Trello tracker; empty string
   * for trackers that have no native list concept.
   */
  external_list_id: string;
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
 * tracker implementation and the outbound sync layer (`syncIssue`) to
 * derive the `triaged` managed-label boolean.
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
 * Deep-copy an IssueTriage so downstream mutation cannot leak into the
 * source block. Used by every projection that surfaces the triage record
 * on a derived shape (dashboard's `IssueListItem` projection in
 * `src/dashboard/issues-reader.ts`, SPA's SSE reducers in
 * `dashboard/src/composables/useIssues.ts`). Centralized here so adding
 * a new field to `IssueTriage` / `IssueTriageHistoryEntry` is a one-file
 * edit instead of a three-file rename hunt.
 */
export function cloneTriage(t: IssueTriage): IssueTriage {
  return {
    expires_at: t.expires_at,
    reassess_hint: t.reassess_hint,
    last_status: t.last_status,
    last_explain: t.last_explain,
    ice: { ...t.ice },
    history: t.history.map((h) => ({ ...h, ice: { ...h.ice } })),
  };
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
 *  - `blocked` — `waiting_on` transitioned `null → record` (the event
 *    name predates the rename; it tracks the dep-chain note, not the
 *    self-block field). `to` carries the card's status at the moment of
 *    the transition.
 *  - `unblocked` — `waiting_on` transitioned `record → null` (agent or
 *    operator cleared the dep-chain note).
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
  /**
   * ISO 8601 timestamp the card was self-blocked. v10 renamed this
   * field from `timestamp` (its v3-v9 name) — DX-592 / parent epic
   * DX-591 / the single-canonical-shape invariant. v9 YAMLs on disk
   * are migrated forward via `migrations/registry.ts#migrateForward`
   * which renames the field; in-memory `Issue.blocked` always carries
   * `at`.
   */
  at: string;
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

/**
 * One entry in `Issue.conflict_on[]`. Declares that THIS card has a
 * file-scope / structural overlap with the named card such that landing
 * both concurrently would produce a merge headache too large to resolve
 * at finalize time.
 *
 * Two-way semantics: a card A in B's `conflict_on[]` blocks B from
 * dispatch while A is In Progress, AND blocks A from dispatch while B
 * is In Progress. The declaration only needs to live on ONE side; the
 * poller's eligibility filter (`isAnyKindBlocked` in
 * `src/poller/local-issues.ts`) walks BOTH directions. Operators or
 * agents may declare it on both sides for clarity, but the
 * enforcement is symmetric regardless.
 *
 * Distinct from `Issue.waiting_on`: waiting_on is a one-way precedence
 * relationship ("A consumes B's output, A waits for B to be terminal").
 * `conflict_on` is a mutual exclusion ("A and B cannot be in progress
 * concurrently because their work spaces collide"). Cleared when one
 * card reaches terminal (the OTHER card is then free to dispatch).
 *
 * Distinct from `Issue.blocked`: blocked = THIS card self-stuck, human
 * must clear. conflict_on = TEMPORAL contention with another card, no
 * human action needed — auto-resolves when the conflict partner ships.
 *
 * `reason` is a human-readable note (markdown OK) that surfaces in the
 * dashboard drawer + the poller's skip log. Non-empty.
 */
export interface ConflictOnEntry {
  /** `<PREFIX>-N` of the conflict partner. */
  id: string;
  /**
   * One-sentence explanation of the overlap — what files, functions,
   * or systems collide. Surfaces in the dashboard + the poller skip
   * log. Non-empty.
   */
  reason: string;
}

/**
 * Repo-agnostic clipboard payload produced by the dashboard's Copy
 * affordance (DX-519). Carries one root issue plus every descendant in
 * its `children[]` hierarchy, fully stripped of repo-specific bits
 * (`external_id`, `tracker`, `dispatch`, `triage`, `history`,
 * `assigned_agent`, `position`). Issue ids inside the payload are the
 * SOURCE repo's ids — the paste-side import handler allocates fresh
 * ids against the TARGET repo's `<PREFIX>-N` sequence and rewrites
 * every internal `parent_id` / `children[]` / `waiting_on.by[]` /
 * `conflict_on[].id` reference to point at the new ids. References
 * outside the payload (e.g. `retro.action_item_ids[]` pointing at a
 * card the operator did not copy) are kept verbatim and render as
 * `<PREFIX-N>: unknown` in the dashboard until the operator
 * re-creates them.
 *
 * `schema_version` matches the current writer literal so a stale
 * payload pasted into a newer dashboard surfaces the same forward-
 * compat warn-then-accept path the YAML parser uses (`yaml.ts`
 * `KNOWN_SCHEMA_MAX`). A payload from a future dashboard pasted into
 * an older one is rejected fail-loud at parse — the import handler
 * round-trips every entry through `parseIssue` so unknown future
 * fields drop silently AND incompatibly-shaped fields surface as a
 * 400.
 */
export interface IssueCopyPayload {
  /**
   * Pinned to `Issue["schema_version"]` so the next coordinated bump
   * (writer literal + `KNOWN_SCHEMA_MAX` + `Issue` type) drags this
   * field along automatically. A naked literal `9` here would drift
   * silently when the rest of the schema-version lockstep moves.
   */
  schema_version: Issue["schema_version"];
  issues: Issue[];
}

export interface Issue {
  schema_version: 10;
  tracker: string;
  /**
   * Internal primary id (`ISS-N`). Required, non-empty, locally generated by
   * `nextIssueId` from `./id-generator.ts`. Stable across the issue's
   * lifetime. The on-disk filename is `<id>.yml`. Agents only ever see this.
   */
  id: string;
  /**
   * Tracker-native id (e.g. Trello card id). Empty string when not synced
   * to any external tracker (YAML-only mode, pre-create draft, or a local
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
   * Operator-managed priority knob inside a sort bucket. Float in the
   * open interval `(0, 6)` clamped on read to `[0.01, 5.99]`; default
   * `3.0`. Mapped to six labeled tiers via `priorityTier()` in
   * `src/issue-tracker/priority-tier.ts`: `lowest` `(0, 1)`, `low`
   * `[1, 2)`, `medium` `[2, 3)`, `high` `[3, 4)`, `very_high` `[4, 5)`,
   * `critical` `[5, 5.99]`. The float resolution lets operators express
   * ordering inside a tier (`3.44`, `4.88`) without a coarse six-bucket
   * discretization.
   *
   * The field is consumed by `sortIssuesForStatus` (in
   * `src/issue-tracker/sort.ts`) as the SOLE sort key for the
   * Review / ToDo / Blocked buckets — `priority` DESC, with id numeric
   * ASC (FIFO) breaking ties. DX-627 (priority canon, Phase 1) made
   * priority the sole expression of dispatch intent; the prior
   * position / epic phase-order / ICE-total tiebreaks were stripped.
   * In Progress / Done / Cancelled keep `updated_at` DESC and ignore
   * priority. Out-of-range / missing values are clamped to
   * `[0.01, 5.99]` on read by `parseIssue` and missing values default
   * to `3.0`. ISS-210 introduced the field with a v4 → v5 schema bump
   * and a one-off backfill migration (retired in DX-595); DX-521
   * widened the bounds without a schema version bump (value shape
   * unchanged, only the clamp range widened).
   */
  priority: number;
  /**
   * Operator manual ordering knob inside a status column (DX-264).
   *
   * **No longer participates in the priority-bucket sort as of DX-627
   * (priority canon, Phase 1).** Priority is the sole canonical
   * expression of dispatch intent; this field is dropped entirely in
   * a follow-up phase of the same epic. Retained on the schema for
   * round-trip stability of existing YAMLs until the drop ships. The
   * dashboard's drag-to-reorder gesture still writes the field for
   * display compatibility but the comparator ignores it.
   */
  position: number | null;
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
   * Non-null = a durable dep-chain record naming the issues in
   * `waiting_on.by[]` that gate dispatch of this card. **Pure dispatch
   * gate, independent of `status`** — the picker checks effective
   * resolution (every id in `by[]` reaches `Done` or `Cancelled`); the
   * field itself is NEVER auto-mutated by the system as a side effect of
   * a status change. Any status (ToDo, In Progress, Review, Blocked,
   * Done, Cancelled) is legal with any `waiting_on` value. Only the
   * agent or operator may clear the record (if they decide the link was
   * mistaken). See `WaitingOn` for the shape.
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
   * Persistent dispatch-mutex record. Each entry declares an overlap
   * with another card such that landing both concurrently would
   * produce a merge headache too large to resolve at finalize time.
   *
   * Two-way enforcement (see `ConflictOnEntry` docstring) — a single
   * entry blocks dispatch in BOTH directions. The poller's
   * eligibility filter (`isAnyKindBlocked` in
   * `src/poller/local-issues.ts`) walks each open card's
   * `conflict_on[]` AND scans every OTHER open card's `conflict_on[]`
   * for this card's id. A candidate is skipped iff some partner
   * referenced by either direction is currently In Progress.
   *
   * Distinct from `waiting_on` (one-way precedence — A consumes B's
   * output, A waits for B to be terminal) and `blocked` (THIS card
   * self-stuck — human clears). conflict_on auto-resolves when the
   * partner reaches a terminal status; the entry stays on the YAML
   * as a durable audit trail of the historical contention.
   *
   * Empty array (default) means no declared conflicts. Stamped by:
   *   - the agent during its own dispatch when it discovers heavy
   *     overlap with another open card (see Step 10c of
   *     `danx-next/SKILL.md`).
   *   - the conflict-check pre-dispatch precursor
   *     (`src/dispatch/conflict-check.ts` → `multi-agent-pick.ts`)
   *     when its verdict returns `kind: "conflict"`.
   *   - the operator via the dashboard.
   */
  conflict_on: ConflictOnEntry[];
  /**
   * Effort-ladder selector (DX-508 / DX-511). One of the seven
   * `EffortLevelName` literals or `null`. `null` means "inherit the
   * agent's default at dispatch time" — resolved by
   * `getAgentEffortLevel` in `src/settings-file.ts`, which falls back
   * through the per-agent setting → repo-level `effortLevels[]` table
   * → built-in `"medium"`. Cards default to `null` on create so the
   * dispatch prompting layer (DX-512) can pick a level based on the
   * card's description without an explicit operator decision.
   *
   * Schema-version bump v7 → v8 carries this field. v7 YAMLs lacking
   * the key are migrated on read to `effort_level: null` (same shape
   * as a fresh card). The bump preserves the DX-280 lockstep
   * invariant — writer literal == `KNOWN_SCHEMA_MAX`.
   */
  effort_level: EffortLevelName | null;
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
   * ISO 8601 timestamp of the most recent DB upsert of this card's
   * canonical content (DX-545 / DX-546). Phase 1 (this card) lands the
   * field on the schema and stamps it in `createEmptyIssue`; Phase 2
   * wires the synchronous DB-mirror write so every save updates the
   * timestamp before the YAML is fsynced. Empty string is the
   * "never-mirrored" sentinel for v8 YAMLs that round-trip through this
   * validator before Phase 2 ships — the parser defaults missing values
   * to `""` so legacy cards continue to load.
   *
   * Included in `canonicalize()` via the generic object walk in
   * `src/db/canonicalize.ts` — no explicit allowlist change needed.
   */
  db_updated_at: string;
  /**
   * v10 (DX-592, parent epic DX-591) — ISO 8601 timestamp the card
   * was archived (moved to `closed/`). `null` is the "never-archived"
   * sentinel; once a card transitions to a terminal status and gets
   * moved by the worker, this is stamped on the next save. Downstream
   * of DX-575 phase cards wire the actual stamping logic; this phase
   * (P1) only lands the on-disk shape so future writers can fill it
   * in without a coordinated schema bump.
   */
  archived_at: string | null;
  /**
   * v10 (DX-592) — ISO 8601 timestamp the card entered `ToDo` from
   * `Review` (i.e. the moment it became dispatch-eligible). `null` is
   * the "never-ready" sentinel; cards created directly at `ToDo` get
   * the field stamped at create time. Downstream of DX-575.
   */
  ready_at: string | null;
  /**
   * v10 (DX-592) — ISO 8601 timestamp the card reached `Done`.
   * `null` is the "not-yet-completed" sentinel. Stamped on the
   * status transition to `Done`. Downstream of DX-575.
   */
  completed_at: string | null;
  /**
   * v10 (DX-592) — ISO 8601 timestamp the card reached `Cancelled`.
   * `null` is the "not-yet-cancelled" sentinel. Stamped on the
   * status transition to `Cancelled`. Downstream of DX-575.
   */
  cancelled_at: string | null;
  /**
   * v10 (DX-592) — denormalized projection of the card's current
   * tracker list name (Trello list, GitHub project column, etc.).
   * `null` when the card is YAML-only (no tracker mapping yet) or
   * the field has not been populated. Downstream of DX-575 wires the
   * sync logic that mirrors this from the tracker's authoritative
   * state.
   */
  list_name: string | null;
  /**
   * TRANSIENT, tracker-derived projection of the card's CURRENT tracker
   * list id (Trello `idList`). Populated by `tracker.getCard()` so the
   * outbound diff in `syncIssue` step 4b can idempotency-check a
   * `moveToList(destinationTrelloListId)` call without a second round-
   * trip. Mirrors the `labels?` field's discipline: NEVER serialized to
   * YAML and NEVER written by agents — the tracker is authoritative for
   * this projection on every read.
   */
  tracker_list_id?: string;
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
  schema_version: 10;
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
  /**
   * Optional on input — `createCard` always stores `effort_level: null`
   * on the fresh card. The dispatch prompting layer (DX-512) reads the
   * card body on first pickup and picks an `EffortLevelName` via a
   * subsequent save. Carried here so the danx-issue-mcp's
   * `danx_issue_create` tool can accept an explicit operator override
   * when the level is already known at create time.
   */
  effort_level?: EffortLevelName | null;
  /**
   * DX-621 / Phase 9d — destination tracker list id for the created card.
   * Callers resolve via the operator-mapped `trello-list-map.yaml`
   * (`<repo>/.danxbot/trello-list-map.yaml`) before calling. Optional so
   * the in-process fake tracker (memory) can ignore it; the Trello tracker
   * passes it verbatim as Trello's `idList` POST field. Empty / undefined
   * lands the card on the board's default list (operator must map the
   * list explicitly to control placement).
   */
  destinationTrelloListId?: string;
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
  /**
   * Fetch every open card across the supplied tracker-native list ids.
   * DX-621 / Phase 9d — callers pass `Object.values(map.list_id_to_trello_list_id)`
   * from the operator-configured `trello-list-map.yaml` so the cron polls
   * exactly the lists the operator mapped (no implicit ordering, no
   * hard-coded status→list resolution). Tracker implementations iterate
   * the supplied ids and surface each card's tracker-native list id in
   * `IssueRef.external_list_id` so callers can reverse-walk the map.
   */
  fetchOpenCards(trelloListIds: readonly string[]): Promise<IssueRef[]>;

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

  /**
   * Move the card to an explicit tracker-native list id. Callers resolve
   * the destination Trello list id via the operator-configured
   * `<repo>/.danxbot/trello-list-map.yaml` (DX-618 / Phase 9a) — the
   * legacy `status → list-id` resolution path is gone (DX-621 / Phase 9d).
   */
  moveToList(externalId: string, trelloListId: string): Promise<void>;

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
  "Backlog",
  "Done",
  "Cancelled",
] as const;

export const ISSUE_TYPES: readonly IssueType[] = [
  "Epic",
  "Bug",
  "Feature",
  "Chore",
] as const;
