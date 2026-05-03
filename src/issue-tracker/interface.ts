/**
 * Tracker-agnostic interface for issue tracking systems.
 *
 * Phase 1 of the tracker-agnostic agents epic. The interface uses the YAML
 * schema's status / type values directly; concrete implementations
 * (TrelloTracker, MemoryTracker) translate to backend-native concepts
 * (list IDs, label IDs) internally.
 *
 * No tracker-native concepts (list IDs, label IDs, board IDs) leak through
 * this interface. Callers refer to cards by `external_id` and to lifecycle
 * state by the YAML status enum.
 */

export type IssueStatus =
  | "Review"
  | "ToDo"
  | "In Progress"
  | "Needs Help"
  | "Done"
  | "Cancelled";

export type IssueType = "Epic" | "Bug" | "Feature";

export type PhaseStatus = "Pending" | "Complete" | "Blocked";

export interface IssueRef {
  external_id: string;
  title: string;
  status: IssueStatus;
}

export interface IssueAcItem {
  check_item_id: string;
  title: string;
  checked: boolean;
}

export interface IssuePhase {
  check_item_id: string;
  title: string;
  status: PhaseStatus;
  notes: string;
}

export interface IssueComment {
  /** Tracker-native id; absent for local-only comments not yet pushed. */
  id?: string;
  author: string;
  timestamp: string;
  text: string;
}

export interface IssueTriaged {
  timestamp: string;
  status: string;
  explain: string;
}

export interface IssueRetro {
  good: string;
  bad: string;
  action_items: string[];
  commits: string[];
}

export interface Issue {
  schema_version: 1;
  tracker: string;
  external_id: string;
  /**
   * `parent_id` and `dispatch_id` are local-only metadata managed by the
   * poller (Phase 2) and the danx_issue_create flow (Phase 3). The tracker
   * abstraction has no place to store them, so sync passes them through
   * verbatim. Reconciling them is intentionally NOT a sync responsibility.
   */
  parent_id: string | null;
  dispatch_id: string | null;
  status: IssueStatus;
  type: IssueType;
  title: string;
  description: string;
  triaged: IssueTriaged;
  ac: IssueAcItem[];
  phases: IssuePhase[];
  comments: IssueComment[];
  retro: IssueRetro;
}

/**
 * Input shape for createCard — every Issue field that the caller can choose
 * minus the ids the tracker assigns.
 */
export interface CreateCardInput {
  schema_version: 1;
  tracker: string;
  parent_id: string | null;
  status: IssueStatus;
  type: IssueType;
  title: string;
  description: string;
  triaged: IssueTriaged;
  ac: Array<{ title: string; checked: boolean }>;
  phases: Array<{ title: string; status: PhaseStatus; notes: string }>;
  comments: IssueComment[];
  retro: IssueRetro;
}

export interface IssueTracker {
  fetchOpenCards(): Promise<IssueRef[]>;

  getCard(externalId: string): Promise<Issue>;

  createCard(input: CreateCardInput): Promise<{
    external_id: string;
    ac: { check_item_id: string }[];
    phases: { check_item_id: string }[];
  }>;

  updateCard(
    externalId: string,
    patch: { title?: string; description?: string },
  ): Promise<void>;

  moveToStatus(externalId: string, status: IssueStatus): Promise<void>;

  setLabels(
    externalId: string,
    labels: { type: IssueType; needsHelp: boolean; triaged: boolean },
  ): Promise<void>;

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

  getComments(externalId: string): Promise<
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

  addPhaseItem(
    externalId: string,
    item: { title: string; status: PhaseStatus; notes: string },
  ): Promise<{ check_item_id: string }>;

  updatePhaseItem(
    externalId: string,
    checkItemId: string,
    patch: { title?: string; status?: PhaseStatus; notes?: string },
  ): Promise<void>;

  deletePhaseItem(externalId: string, checkItemId: string): Promise<void>;

  /**
   * Create a fresh card on the tracker's Action Items list with the given
   * title. The new card is intentionally NOT linked to any parent at the
   * tracker layer — `parent_id` is local-only metadata (per the Phase 1
   * Issue contract), so callers wire parent linkage by setting `parent_id`
   * on the local Issue YAML themselves.
   */
  addLinkedActionItemCard(
    title: string,
  ): Promise<{ external_id: string }>;
}

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  "Review",
  "ToDo",
  "In Progress",
  "Needs Help",
  "Done",
  "Cancelled",
] as const;

export const ISSUE_TYPES: readonly IssueType[] = [
  "Epic",
  "Bug",
  "Feature",
] as const;

export const PHASE_STATUSES: readonly PhaseStatus[] = [
  "Pending",
  "Complete",
  "Blocked",
] as const;
