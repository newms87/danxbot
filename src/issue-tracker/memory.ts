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
} from "./interface.js";

/**
 * Prefix for `MemoryTracker`-minted external_ids. Both the mint
 * (`createCard`) and the format validator (`isValidExternalId`) MUST go
 * through this constant so a regression that drifts one without the other
 * is impossible — drift would make every freshly-minted card
 * self-heal-and-blank on the very next poll tick. Keep the name + shape
 * stable; the heal pass relies on this being a one-place edit.
 */
const MEMORY_EXTERNAL_ID_PREFIX = "mem-";
const MEMORY_EXTERNAL_ID_REGEX = new RegExp(
  `^${MEMORY_EXTERNAL_ID_PREFIX}\\d+$`,
);

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
  dispatch: IssueDispatch | null;
  status: IssueStatus;
  type: IssueType;
  title: string;
  description: string;
  triage: IssueTriage;
  ac: IssueAcItem[];
  comments: Required<IssueComment>[];
  retro: {
    good: string;
    bad: string;
    action_item_ids: string[];
    commits: string[];
  };
  blocked: { reason: string; timestamp: string; by: string[] } | null;
  labels: ManagedLabels;
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

  /**
   * Mirror of `createCard`'s mint format (`MEMORY_EXTERNAL_ID_PREFIX` +
   * sequence number). A YAML carrying a real `mem-N` round-trips as
   * valid; a foreign-tracker id (e.g. a 24-hex Trello id) is recognized
   * as invalid by the per-tick heal pass (DX-150). Both sides go through
   * the shared constant so the validate/mint pair never drift.
   */
  isValidExternalId(id: string): boolean {
    return MEMORY_EXTERNAL_ID_REGEX.test(id);
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
      "Needs Approval",
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
    const externalId = `${MEMORY_EXTERNAL_ID_PREFIX}${this.nextExternalId++}`;
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
      blocked: null,
      labels: {
        type: input.type,
        needsHelp: input.status === "Needs Help",
        needsApproval: input.status === "Needs Approval",
        triaged: isTriaged(input.triage),
        blocked: false,
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
      schema_version: 3,
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
      blocked:
        card.blocked === null
          ? null
          : { ...card.blocked, by: [...card.blocked.by] },
      // `history` is local-only audit; the tracker abstraction never sees it.
      // MemoryTracker mirrors Trello's contract: always emit [] on read so
      // the local YAML stays authoritative for the audit log.
      history: [],
      labels: { ...card.labels },
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
      blocked:
        issue.blocked === null
          ? null
          : { ...issue.blocked, by: [...issue.blocked.by] },
      labels: {
        type: issue.type,
        needsHelp: issue.status === "Needs Help",
        needsApproval: issue.status === "Needs Approval",
        triaged: isTriaged(issue.triage),
        blocked: issue.blocked !== null,
      },
    };
  }
}
