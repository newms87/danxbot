import {
  type CreateCardInput,
  type Issue,
  type IssueAcItem,
  type IssueComment,
  type IssuePhase,
  type IssueRef,
  type IssueStatus,
  type IssueTracker,
  type IssueType,
  type PhaseStatus,
} from "./interface.js";

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
   * so memory tracker round-trips preserve it. Empty string is permitted
   * for seeded fixtures that pre-date the id contract; tests touching
   * the schema are responsible for supplying a valid id.
   */
  id: string;
  external_id: string;
  parent_id: string | null;
  /**
   * Child issue ids (`ISS-N[]`). Mirrors `Issue.children`. Stored on the
   * card so seeded fixtures round-trip cleanly through the memory tracker.
   */
  children: string[];
  dispatch_id: string | null;
  status: IssueStatus;
  type: IssueType;
  title: string;
  description: string;
  triaged: { timestamp: string; status: string; explain: string };
  ac: IssueAcItem[];
  phases: IssuePhase[];
  comments: Required<IssueComment>[];
  retro: {
    good: string;
    bad: string;
    action_item_ids: string[];
    commits: string[];
  };
  blocked: { reason: string; timestamp: string; by: string[] } | null;
  labels: {
    type: IssueType;
    needsHelp: boolean;
    triaged: boolean;
    blocked: boolean;
  };
}

/**
 * In-memory IssueTracker for tests.
 *
 * Records every method call into a request log, exposes a `failNextWrite` hook
 * for forcing rejection on the next mutating call, and lets tests seed initial
 * cards via the constructor.
 */
export class MemoryTracker implements IssueTracker {
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
   * moveToStatus, setLabels, addComment, AC mutations, phase mutations).
   * Read methods are unaffected.
   */
  failNextWrite(
    error: Error = new Error("MemoryTracker forced write failure"),
  ): void {
    this.pendingWriteRejection = error;
  }

  async fetchOpenCards(): Promise<IssueRef[]> {
    this.log("fetchOpenCards");
    const open = new Set<IssueStatus>([
      "Review",
      "ToDo",
      "In Progress",
      "Needs Help",
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
    phases: { check_item_id: string }[];
  }> {
    this.consumeWriteRejection();
    const externalId = `mem-${this.nextExternalId++}`;
    const ac: IssueAcItem[] = input.ac.map((item) => ({
      check_item_id: this.allocCheckItemId(),
      title: item.title,
      checked: item.checked,
    }));
    const phases: IssuePhase[] = input.phases.map((p) => ({
      check_item_id: this.allocCheckItemId(),
      title: p.title,
      status: p.status,
      notes: p.notes,
    }));
    const stored: StoredCard = {
      tracker: "memory",
      id: input.id,
      external_id: externalId,
      parent_id: input.parent_id,
      children: [...input.children],
      dispatch_id: null,
      status: input.status,
      type: input.type,
      title: input.title,
      description: input.description,
      triaged: { ...input.triaged },
      ac,
      phases,
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
      blocked: null,
      labels: {
        type: input.type,
        needsHelp: input.status === "Needs Help",
        triaged: input.triaged.timestamp !== "",
        blocked: false,
      },
    };
    this.cards.set(externalId, stored);
    this.log("createCard", externalId, { input });
    return {
      external_id: externalId,
      ac: ac.map((a) => ({ check_item_id: a.check_item_id })),
      phases: phases.map((p) => ({ check_item_id: p.check_item_id })),
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
    labels: {
      type: IssueType;
      needsHelp: boolean;
      triaged: boolean;
      blocked: boolean;
    },
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

  async addPhaseItem(
    externalId: string,
    item: { title: string; status: PhaseStatus; notes: string },
  ): Promise<{ check_item_id: string }> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const checkItemId = this.allocCheckItemId();
    card.phases.push({
      check_item_id: checkItemId,
      title: item.title,
      status: item.status,
      notes: item.notes,
    });
    this.log("addPhaseItem", externalId, { item });
    return { check_item_id: checkItemId };
  }

  async updatePhaseItem(
    externalId: string,
    checkItemId: string,
    patch: { title?: string; status?: PhaseStatus; notes?: string },
  ): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const found = card.phases.find((p) => p.check_item_id === checkItemId);
    if (!found) {
      throw new Error(
        `Phase item ${checkItemId} not found on card ${externalId}`,
      );
    }
    if (patch.title !== undefined) found.title = patch.title;
    if (patch.status !== undefined) found.status = patch.status;
    if (patch.notes !== undefined) found.notes = patch.notes;
    this.log("updatePhaseItem", externalId, { checkItemId, patch });
  }

  async deletePhaseItem(
    externalId: string,
    checkItemId: string,
  ): Promise<void> {
    this.consumeWriteRejection();
    const card = this.requireCard(externalId);
    const idx = card.phases.findIndex((p) => p.check_item_id === checkItemId);
    if (idx === -1) {
      throw new Error(
        `Phase item ${checkItemId} not found on card ${externalId}`,
      );
    }
    card.phases.splice(idx, 1);
    this.log("deletePhaseItem", externalId, { checkItemId });
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
      schema_version: 3,
      tracker: card.tracker,
      id: card.id,
      external_id: card.external_id,
      parent_id: card.parent_id,
      children: [...card.children],
      dispatch_id: card.dispatch_id,
      status: card.status,
      type: card.type,
      title: card.title,
      description: card.description,
      triaged: { ...card.triaged },
      ac: card.ac.map((a) => ({ ...a })),
      phases: card.phases.map((p) => ({ ...p })),
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
      blocked:
        card.blocked === null
          ? null
          : { ...card.blocked, by: [...card.blocked.by] },
    };
  }

  private cloneIssueAsStored(issue: Issue): StoredCard {
    return {
      tracker: issue.tracker || "memory",
      id: issue.id,
      external_id: issue.external_id,
      parent_id: issue.parent_id,
      children: [...issue.children],
      dispatch_id: issue.dispatch_id,
      status: issue.status,
      type: issue.type,
      title: issue.title,
      description: issue.description,
      triaged: { ...issue.triaged },
      ac: issue.ac.map((a) => ({ ...a })),
      phases: issue.phases.map((p) => ({ ...p })),
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
      blocked:
        issue.blocked === null
          ? null
          : { ...issue.blocked, by: [...issue.blocked.by] },
      labels: {
        type: issue.type,
        needsHelp: issue.status === "Needs Help",
        triaged: issue.triaged.timestamp !== "",
        blocked: issue.blocked !== null,
      },
    };
  }
}
