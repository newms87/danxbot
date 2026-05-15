/**
 * FakeTracker — in-memory `IssueTracker` implementation for tests.
 * Stores cards in a `Map<external_id, StoredCard>`, records every
 * method call into a `RequestLogEntry[]`, and supports
 * `failNextWrite()` for error-path tests.
 *
 * Production code MUST NOT import from this file — guarded by
 * `src/__tests__/issue-tracker/no-fake-tracker-in-production.test.ts`.
 */
import {
  isTriaged,
  type CreateCardInput,
  type Issue,
  type IssueAcItem,
  type IssueComment,
  type IssueDispatch,
  type IssueRef,
  type IssueStatus,
  type IssueTracker,
  type IssueTriage,
  type IssueType,
  type ManagedLabels,
  type RequiresHuman,
} from "../../issue-tracker/interface.js";

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

function cloneDispatch(d: IssueDispatch | null): IssueDispatch | null {
  return d === null ? null : { ...d };
}

export interface RequestLogEntry {
  method: string;
  externalId?: string;
  details?: Record<string, unknown>;
}

interface StoredCard {
  /**
   * Tracker name to surface on read. Defaults to `"memory"` for cards
   * created via `createCard`; for seeded cards we preserve whatever the
   * caller put in the seed Issue's `tracker` field (so a Trello-shaped
   * fixture round-trips with `tracker: "trello"`).
   */
  tracker: string;
  /**
   * Internal issue id (`ISS-N`). Stored alongside the tracker-native id
   * so the fake tracker round-trips preserve it. Empty string is permitted
   * for seeded fixtures that pre-date the id contract; tests touching
   * the schema are responsible for supplying a valid id.
   */
  id: string;
  external_id: string;
  parent_id: string | null;
  /**
   * Child issue ids (`ISS-N[]`). Mirrors `Issue.children`. Stored on the
   * card so seeded fixtures round-trip cleanly.
   */
  children: string[];
  dispatch: IssueDispatch | null;
  status: IssueStatus;
  type: IssueType;
  title: string;
  description: string;
  priority: number;
  triage: IssueTriage;
  ac: IssueAcItem[];
  comments: Required<IssueComment>[];
  retro: {
    good: string;
    bad: string;
    action_item_ids: string[];
    commits: string[];
  };
  waiting_on: { reason: string; timestamp: string; by: string[] } | null;
  blocked: { reason: string; timestamp: string } | null;
  requires_human: RequiresHuman | null;
  conflict_on: { id: string; reason: string }[];
  effort_level: import("../../issue-tracker/interface.js").EffortLevelName | null;
  labels: ManagedLabels;
}

/**
 * In-memory IssueTracker for tests.
 *
 * Records every method call into a request log, exposes a `failNextWrite` hook
 * for forcing rejection on the next mutating call, and lets tests seed initial
 * cards via the constructor.
 */
export class FakeTracker implements IssueTracker {
  private cards = new Map<string, StoredCard>();
  private nextExternalId = 1;
  private nextCheckItemId = 1;
  private nextCommentId = 1;
  private requestLog: RequestLogEntry[] = [];
  private pendingWriteRejection: Error | null = null;
  private clock: () => string;

  constructor(opts: { seed?: Issue[]; clock?: () => string } = {}) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    if (opts.seed) {
      for (const issue of opts.seed) {
        this.cards.set(issue.external_id, this.cloneIssueAsStored(issue));
      }
    }
  }

  getRequestLog(): RequestLogEntry[] {
    return [...this.requestLog];
  }

  clearRequestLog(): void {
    this.requestLog = [];
  }

  /**
   * Queue a rejection on the next mutating call (createCard, updateCard,
   * moveToStatus, setLabels, addComment, AC mutations).
   * Read methods are unaffected.
   */
  failNextWrite(
    error: Error = new Error("FakeTracker forced write failure"),
  ): void {
    this.pendingWriteRejection = error;
  }

  async fetchOpenCards(): Promise<IssueRef[]> {
    this.log("fetchOpenCards");
    const open = new Set<IssueStatus>([
      "Review",
      "ToDo",
      "In Progress",
      "Blocked",
    ]);
    const refs: IssueRef[] = [];
    for (const card of this.cards.values()) {
      if (open.has(card.status)) {
        refs.push({
          id: card.id,
          external_id: card.external_id,
          title: card.title,
          status: card.status,
        });
      }
    }
    return refs;
  }

  async getCard(externalId: string): Promise<Issue> {
    this.log("getCard", externalId);
    const card = this.requireCard(externalId);
    return this.toIssue(card);
  }

  async createCard(input: CreateCardInput): Promise<{
    external_id: string;
    ac: { check_item_id: string }[];
  }> {
    this.consumeWriteRejection();
    const externalId = `mem-${this.nextExternalId++}`;
    const ac: IssueAcItem[] = input.ac.map((item) => ({
      check_item_id: this.allocCheckItemId(),
      title: item.title,
      checked: item.checked,
    }));
    const stored: StoredCard = {
      tracker: "memory",
      id: input.id,
      external_id: externalId,
      parent_id: input.parent_id,
      children: [...input.children],
      dispatch: null,
      status: input.status,
      type: input.type,
      title: input.title,
      description: input.description,
      priority: input.priority,
      triage: cloneTriage(input.triage),
      ac,
      comments: input.comments.map((c) => ({
        id: c.id ?? this.allocCommentId(),
        author: c.author,
        timestamp: c.timestamp,
        text: c.text,
      })),
      retro: {
        good: input.retro.good,
        bad: input.retro.bad,
        action_item_ids: [...input.retro.action_item_ids],
        commits: [...input.retro.commits],
      },
      waiting_on: null,
      blocked: null,
      requires_human: null,
      conflict_on: [],
      effort_level: null,
      labels: {
        type: input.type,
        blocked: input.status === "Blocked",
        // `createCard` always stamps `requires_human: null` on a fresh
        // card per the schema contract (the field is added via subsequent
        // saves), so the matching label boolean is `false` at create
        // time. DX-231 retired the legacy `needsApproval` derive here.
        requires_human: false,
        triaged: isTriaged(input.triage),
      },
    };
    this.cards.set(externalId, stored);
    this.log("createCard", externalId, { input });
    return {
      external_id: externalId,
      ac: ac.map((a) => ({ check_item_id: a.check_item_id })),
    };
  }

  async updateCard(
    externalId: string,
    patch: { title?: string; description?: string },
  ): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    if (patch.title !== undefined) card.title = patch.title;
    if (patch.description !== undefined) card.description = patch.description;
    this.log("updateCard", externalId, { patch });
  }

  async moveToStatus(externalId: string, status: IssueStatus): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    card.status = status;
    this.log("moveToStatus", externalId, { status });
  }

  async setLabels(
    externalId: string,
    labels: ManagedLabels,
  ): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    card.labels = { ...labels };
    card.type = labels.type;
    this.log("setLabels", externalId, { labels });
  }

  async addComment(
    externalId: string,
    text: string,
  ): Promise<{ id: string; timestamp: string }> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const id = this.allocCommentId();
    const timestamp = this.clock();
    card.comments.push({ id, author: "danxbot", timestamp, text });
    this.log("addComment", externalId, { text });
    return { id, timestamp };
  }

  async editComment(
    externalId: string,
    commentId: string,
    text: string,
  ): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const found = card.comments.find((c) => c.id === commentId);
    if (!found) {
      throw new Error(`Comment ${commentId} not found on card ${externalId}`);
    }
    found.text = text;
    this.log("editComment", externalId, { commentId, text });
  }

  async getComments(
    externalId: string,
  ): Promise<
    Array<{ id: string; author: string; timestamp: string; text: string }>
  > {
    this.log("getComments", externalId);
    const card = this.requireCard(externalId);
    return card.comments
      .map((c) => ({
        id: c.id,
        author: c.author,
        timestamp: c.timestamp,
        text: c.text,
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async addAcItem(
    externalId: string,
    item: { title: string; checked: boolean },
  ): Promise<{ check_item_id: string }> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const checkItemId = this.allocCheckItemId();
    card.ac.push({
      check_item_id: checkItemId,
      title: item.title,
      checked: item.checked,
    });
    this.log("addAcItem", externalId, { item });
    return { check_item_id: checkItemId };
  }

  async updateAcItem(
    externalId: string,
    checkItemId: string,
    patch: { title?: string; checked?: boolean },
  ): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const found = card.ac.find((a) => a.check_item_id === checkItemId);
    if (!found) {
      throw new Error(`AC item ${checkItemId} not found on card ${externalId}`);
    }
    if (patch.title !== undefined) found.title = patch.title;
    if (patch.checked !== undefined) found.checked = patch.checked;
    this.log("updateAcItem", externalId, { checkItemId, patch });
  }

  async deleteAcItem(externalId: string, checkItemId: string): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const idx = card.ac.findIndex((a) => a.check_item_id === checkItemId);
    if (idx === -1) {
      throw new Error(`AC item ${checkItemId} not found on card ${externalId}`);
    }
    card.ac.splice(idx, 1);
    this.log("deleteAcItem", externalId, { checkItemId });
  }

  private requireCard(externalId: string): StoredCard {
    const card = this.cards.get(externalId);
    if (!card) {
      throw new Error(`Card not found: ${externalId}`);
    }
    return card;
  }

  private consumeWriteRejection(): void {
    if (this.pendingWriteRejection) {
      const err = this.pendingWriteRejection;
      this.pendingWriteRejection = null;
      throw err;
    }
  }

  private log(
    method: string,
    externalId?: string,
    details?: Record<string, unknown>,
  ): void {
    const entry: RequestLogEntry = { method };
    if (externalId !== undefined) entry.externalId = externalId;
    if (details !== undefined) entry.details = details;
    this.requestLog.push(entry);
  }

  private allocCheckItemId(): string {
    return `chk-${this.nextCheckItemId++}`;
  }

  private allocCommentId(): string {
    return `cmt-${this.nextCommentId++}`;
  }

  private toIssue(card: StoredCard): Issue {
    return {
      schema_version: 9,
      tracker: card.tracker,
      id: card.id,
      external_id: card.external_id,
      parent_id: card.parent_id,
      children: [...card.children],
      dispatch: cloneDispatch(card.dispatch),
      status: card.status,
      type: card.type,
      title: card.title,
      description: card.description,
      priority: card.priority,
      position: null,
      triage: cloneTriage(card.triage),
      ac: card.ac.map((a) => ({ ...a })),
      comments: card.comments.map((c) => ({
        id: c.id,
        author: c.author,
        timestamp: c.timestamp,
        text: c.text,
      })),
      retro: {
        good: card.retro.good,
        bad: card.retro.bad,
        action_item_ids: [...card.retro.action_item_ids],
        commits: [...card.retro.commits],
      },
      // `assigned_agent` is local-only metadata (DX-200) — tracker.getCard
      // contract always emits null so the local YAML stays authoritative
      // for the persona claim. Mirrors the same pattern as `parent_id` /
      // `children` / `dispatch` / `history`.
      assigned_agent: null,
      waiting_on:
        card.waiting_on === null
          ? null
          : { ...card.waiting_on, by: [...card.waiting_on.by] },
      blocked:
        card.blocked === null
          ? null
          : { reason: card.blocked.reason, timestamp: card.blocked.timestamp },
      requires_human:
        card.requires_human === null
          ? null
          : {
              reason: card.requires_human.reason,
              steps: [...card.requires_human.steps],
              set_by: card.requires_human.set_by,
              set_at: card.requires_human.set_at,
            },
      conflict_on: card.conflict_on.map((c: { id: string; reason: string }) => ({ ...c })),
      effort_level: card.effort_level,
      // `history` is local-only audit; the tracker abstraction never sees it.
      // FakeTracker mirrors Trello's contract: always emit [] on read so
      // the local YAML stays authoritative for the audit log.
      history: [],
      labels: { ...card.labels },
      db_updated_at: "",
    };
  }

  private cloneIssueAsStored(issue: Issue): StoredCard {
    return {
      tracker: issue.tracker || "memory",
      id: issue.id,
      external_id: issue.external_id,
      parent_id: issue.parent_id,
      children: [...issue.children],
      dispatch: cloneDispatch(issue.dispatch),
      status: issue.status,
      type: issue.type,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      triage: cloneTriage(issue.triage),
      ac: issue.ac.map((a) => ({ ...a })),
      comments: issue.comments.map((c) => ({
        id: c.id ?? this.allocCommentId(),
        author: c.author,
        timestamp: c.timestamp,
        text: c.text,
      })),
      retro: {
        good: issue.retro.good,
        bad: issue.retro.bad,
        action_item_ids: [...issue.retro.action_item_ids],
        commits: [...issue.retro.commits],
      },
      waiting_on:
        issue.waiting_on === null
          ? null
          : { ...issue.waiting_on, by: [...issue.waiting_on.by] },
      blocked:
        issue.blocked === null
          ? null
          : { reason: issue.blocked.reason, timestamp: issue.blocked.timestamp },
      requires_human:
        issue.requires_human === null
          ? null
          : {
              reason: issue.requires_human.reason,
              steps: [...issue.requires_human.steps],
              set_by: issue.requires_human.set_by,
              set_at: issue.requires_human.set_at,
            },
      conflict_on: issue.conflict_on.map((c: { id: string; reason: string }) => ({ ...c })),
      effort_level: issue.effort_level,
      labels: {
        type: issue.type,
        blocked: issue.status === "Blocked",
        // Mirrors `createCard`: a stored seed reflects whether the seed
        // YAML carries a non-null `requires_human` record.
        requires_human: issue.requires_human !== null,
        triaged: isTriaged(issue.triage),
      },
    };
  }
}
