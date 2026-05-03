import { createLogger } from "../logger.js";
import type { TrelloConfig } from "../types.js";
import {
  type CreateCardInput,
  type Issue,
  type IssueRef,
  type IssueStatus,
  type IssueTracker,
  type IssueType,
  type PhaseStatus,
} from "./interface.js";

const TRELLO_BASE = "https://api.trello.com/1";

const AC_CHECKLIST_NAME = "Acceptance Criteria";
const PHASES_CHECKLIST_NAME = "Implementation Phases";

/**
 * Encoding for Phase items inside Trello checklist items.
 *
 * Trello check-items have only `name` (string) and `state` (`"complete" |
 * "incomplete"`). Phase items carry richer state — title, status (Pending /
 * Complete / Blocked), and free-form notes. We pack all three into the
 * check-item's `name` using a deterministic header line plus a notes block:
 *
 *   <STATUS>: <TITLE>
 *   <NOTES>     (omitted entirely when notes are empty)
 *
 * The check-item's `state` mirrors `status === "Complete"` so the Trello UI
 * shows expected check-marks, but `status` is the source of truth on read.
 *
 * The encoder writes `phase.status` directly into the header; the decoder
 * exhausts the `PhaseStatus` discriminated union explicitly. Adding a new
 * status value will fail TypeScript's exhaustiveness check in
 * `decodePhaseItemName` and force an update here — no identity-map needed.
 */

interface TrelloLabelDto {
  id: string;
  name: string;
  color: string | null;
}

interface TrelloCheckItemDto {
  id: string;
  name: string;
  state: "complete" | "incomplete";
}

interface TrelloChecklistDto {
  id: string;
  name: string;
  checkItems: TrelloCheckItemDto[];
}

interface TrelloCardDto {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idLabels: string[];
  labels?: TrelloLabelDto[];
  idChecklists?: string[];
}

interface TrelloActionDto {
  id: string;
  date: string;
  memberCreator?: { username?: string; fullName?: string };
  data: { text: string };
}

export class TrelloTracker implements IssueTracker {
  private triagedLabelIdCache: string | null = null;
  // Maps external_id -> { ac: checklistId, phases: checklistId } so callbacks
  // for AC/phase mutations don't re-walk the card.
  private checklistIdCache = new Map<
    string,
    { ac?: string; phases?: string }
  >();

  constructor(private readonly trello: TrelloConfig) {}

  // ---------- Public API ----------

  async fetchOpenCards(): Promise<IssueRef[]> {
    const openLists: Array<[IssueStatus, string]> = [
      ["Review", this.trello.reviewListId],
      ["ToDo", this.trello.todoListId],
      ["In Progress", this.trello.inProgressListId],
      ["Needs Help", this.trello.needsHelpListId],
    ];
    const refs: IssueRef[] = [];
    for (const [status, listId] of openLists) {
      const cards = await this.fetchListCards(listId);
      for (const card of cards) {
        const { id, title } = parseCardTitle(card.name);
        refs.push({ id, external_id: card.id, title, status });
      }
    }
    return refs;
  }

  async getCard(externalId: string): Promise<Issue> {
    const cardUrl = this.buildUrl(`/cards/${externalId}`, {
      fields: "id,name,desc,idList,idLabels",
      checklists: "all",
      checklist_fields: "name",
    });
    const card = await this.requestJson<TrelloCardDto & { checklists: TrelloChecklistDto[] }>(
      cardUrl,
      { method: "GET" },
      `GET /cards/${externalId}`,
    );

    const status = this.listIdToStatus(card.idList);
    const type = await this.deriveType(card.idLabels);
    const checklists = card.checklists ?? [];
    const acChecklist = checklists.find((c) => c.name === AC_CHECKLIST_NAME);
    const phasesChecklist = checklists.find((c) => c.name === PHASES_CHECKLIST_NAME);

    if (acChecklist || phasesChecklist) {
      this.checklistIdCache.set(externalId, {
        ac: acChecklist?.id,
        phases: phasesChecklist?.id,
      });
    }

    const ac = (acChecklist?.checkItems ?? []).map((item) => ({
      check_item_id: item.id,
      title: item.name,
      checked: item.state === "complete",
    }));
    const phases = (phasesChecklist?.checkItems ?? []).map((item) => {
      const decoded = decodePhaseItemName(item.name);
      return {
        check_item_id: item.id,
        title: decoded.title,
        status: decoded.status,
        notes: decoded.notes,
      };
    });

    // `getCard` does NOT auto-fetch comments — callers that want comments
    // must call `getComments` separately. This avoids a redundant
    // `/actions` round-trip every time `syncIssue` runs (which already
    // calls `getComments` itself for the merge step).
    const parsed = parseCardTitle(card.name);
    return {
      schema_version: 2,
      tracker: "trello",
      // Internal id is parsed from the `#ISS-N: ` title prefix. Cards
      // pre-dating the id epoch (or human-created without the prefix)
      // surface here with `id: ""` — sync.ts and higher-level callers
      // are responsible for handling that case (typically by ignoring or
      // running the migration script).
      id: parsed.id,
      external_id: card.id,
      parent_id: null,
      dispatch_id: null,
      status,
      type,
      title: parsed.title,
      description: card.desc ?? "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac,
      phases,
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    };
  }

  async createCard(input: CreateCardInput): Promise<{
    external_id: string;
    ac: { check_item_id: string }[];
    phases: { check_item_id: string }[];
  }> {
    const listId = this.statusToListId(input.status);
    const labelIds = await this.resolveLabelIds({
      type: input.type,
      needsHelp: input.status === "Needs Help",
      triaged: input.triaged.timestamp !== "",
    });
    const url = `${TRELLO_BASE}/cards?${this.auth()}`;
    // The Trello card title carries the internal id prefix `#<id>: ` so
    // humans on the Trello UI can correlate cards back to local YAMLs at
    // a glance. `parseCardTitle` is the inverse on read.
    const created = await this.requestJson<TrelloCardDto>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idList: listId,
          name: formatCardTitle(input.id, input.title),
          desc: input.description,
          idLabels: labelIds.join(","),
          pos: "top",
        }),
      },
      "POST /cards",
    );

    const acIds: { check_item_id: string }[] = [];
    if (input.ac.length > 0) {
      const acChecklistId = await this.createChecklist(created.id, AC_CHECKLIST_NAME);
      this.rememberChecklist(created.id, "ac", acChecklistId);
      for (const item of input.ac) {
        const checkItem = await this.createCheckItem(
          acChecklistId,
          item.title,
          item.checked,
        );
        acIds.push({ check_item_id: checkItem.id });
      }
    }
    const phaseIds: { check_item_id: string }[] = [];
    if (input.phases.length > 0) {
      const phChecklistId = await this.createChecklist(created.id, PHASES_CHECKLIST_NAME);
      this.rememberChecklist(created.id, "phases", phChecklistId);
      for (const p of input.phases) {
        const checkItem = await this.createCheckItem(
          phChecklistId,
          encodePhaseItemName(p),
          p.status === "Complete",
        );
        phaseIds.push({ check_item_id: checkItem.id });
      }
    }
    for (const c of input.comments) {
      // Push any pre-existing comments through; no special marker handling here
      // — the worker prepends DANXBOT_COMMENT_MARKER in sync.ts.
      await this.addComment(created.id, c.text);
    }
    return { external_id: created.id, ac: acIds, phases: phaseIds };
  }

  async updateCard(
    externalId: string,
    patch: { title?: string; description?: string; id?: string },
  ): Promise<void> {
    if (patch.title === undefined && patch.description === undefined) return;
    const url = `${TRELLO_BASE}/cards/${externalId}?${this.auth()}`;
    const body: Record<string, string> = {};
    if (patch.title !== undefined) {
      // Preserve the `#<id>: ` title prefix on every title update. Sync
      // passes the local issue's `id` through `patch.id` so we can
      // reformat without a round-trip to read the existing card name.
      body.name = patch.id ? formatCardTitle(patch.id, patch.title) : patch.title;
    }
    if (patch.description !== undefined) body.desc = patch.description;
    await this.requestVoid(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      `PUT /cards/${externalId}`,
    );
  }

  async moveToStatus(externalId: string, status: IssueStatus): Promise<void> {
    const listId = this.statusToListId(status);
    const url = `${TRELLO_BASE}/cards/${externalId}?${this.auth()}`;
    await this.requestVoid(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idList: listId, pos: "top" }),
      },
      `PUT /cards/${externalId} (moveToStatus)`,
    );
  }

  async setLabels(
    externalId: string,
    labels: { type: IssueType; needsHelp: boolean; triaged: boolean },
  ): Promise<void> {
    // Eagerly resolve the Triaged label id regardless of `labels.triaged` so
    // the managed-set is always complete. Without this, a stale Triaged
    // label cannot be stripped on `triaged: false` when the cache is cold,
    // because the lookup only fires when triaged is true. If the board has
    // no Triaged label configured, throw — silently degrading would let
    // stale labels persist forever.
    const triagedLabelId = await this.resolveTriagedLabelId();

    const desiredIds = await this.resolveLabelIds(labels);
    const getUrl = this.buildUrl(`/cards/${externalId}`, { fields: "idLabels" });
    // Read current labels so we can preserve any non-danxbot-managed labels.
    const card = await this.requestJson<TrelloCardDto>(
      getUrl,
      { method: "GET" },
      `GET /cards/${externalId} (setLabels)`,
    );
    const managedSet = new Set<string>(
      this.allManagedLabelIdsForFiltering(triagedLabelId),
    );
    const preserved = (card.idLabels ?? []).filter((id) => !managedSet.has(id));
    const next = Array.from(new Set([...preserved, ...desiredIds]));
    const putUrl = this.buildUrl(`/cards/${externalId}`);
    await this.requestVoid(
      putUrl,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idLabels: next.join(",") }),
      },
      `PUT /cards/${externalId} (setLabels)`,
    );
  }

  async addComment(
    externalId: string,
    text: string,
  ): Promise<{ id: string; timestamp: string }> {
    const url = `${TRELLO_BASE}/cards/${externalId}/actions/comments?${this.auth()}`;
    const action = await this.requestJson<TrelloActionDto>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
      `POST /cards/${externalId}/actions/comments`,
    );
    return { id: action.id, timestamp: action.date };
  }

  async editComment(
    externalId: string,
    commentId: string,
    text: string,
  ): Promise<void> {
    // Trello's edit-comment endpoint is card-scoped: PUT
    // /cards/{cardId}/actions/{actionId}/comments. The action id alone
    // (PUT /actions/{id}) also accepts the same body, but the
    // card-scoped form fails fast (404) when the comment doesn't belong
    // to the card — exactly the invariant the interface contract asks
    // implementations to enforce.
    const url = `${TRELLO_BASE}/cards/${externalId}/actions/${commentId}/comments?${this.auth()}`;
    await this.requestVoid(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
      `PUT /cards/${externalId}/actions/${commentId}/comments`,
    );
  }

  async getComments(externalId: string): Promise<
    Array<{ id: string; author: string; timestamp: string; text: string }>
  > {
    const url = this.buildUrl(`/cards/${externalId}/actions`, {
      filter: "commentCard",
      limit: "1000",
    });
    const actions = await this.requestJson<TrelloActionDto[]>(
      url,
      { method: "GET" },
      `GET /cards/${externalId}/actions`,
    );
    const comments = actions.map((a) => ({
      id: a.id,
      author:
        a.memberCreator?.username ?? a.memberCreator?.fullName ?? "",
      timestamp: a.date,
      text: a.data.text,
    }));
    comments.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return comments;
  }

  async addAcItem(
    externalId: string,
    item: { title: string; checked: boolean },
  ): Promise<{ check_item_id: string }> {
    const checklistId = await this.ensureChecklistId(externalId, "ac");
    const ci = await this.createCheckItem(checklistId, item.title, item.checked);
    return { check_item_id: ci.id };
  }

  async updateAcItem(
    externalId: string,
    checkItemId: string,
    patch: { title?: string; checked?: boolean },
  ): Promise<void> {
    if (patch.title === undefined && patch.checked === undefined) return;
    const url = `${TRELLO_BASE}/cards/${externalId}/checkItem/${checkItemId}?${this.auth()}`;
    const body: Record<string, string> = {};
    if (patch.title !== undefined) body.name = patch.title;
    if (patch.checked !== undefined) {
      body.state = patch.checked ? "complete" : "incomplete";
    }
    await this.requestVoid(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      `PUT /cards/${externalId}/checkItem/${checkItemId}`,
    );
  }

  async deleteAcItem(externalId: string, checkItemId: string): Promise<void> {
    const checklistId = await this.ensureChecklistId(externalId, "ac");
    await this.deleteCheckItem(checklistId, checkItemId);
  }

  async addPhaseItem(
    externalId: string,
    item: { title: string; status: PhaseStatus; notes: string },
  ): Promise<{ check_item_id: string }> {
    const checklistId = await this.ensureChecklistId(externalId, "phases");
    const ci = await this.createCheckItem(
      checklistId,
      encodePhaseItemName(item),
      item.status === "Complete",
    );
    return { check_item_id: ci.id };
  }

  async updatePhaseItem(
    externalId: string,
    checkItemId: string,
    patch: { title?: string; status?: PhaseStatus; notes?: string },
  ): Promise<void> {
    if (
      patch.title === undefined &&
      patch.status === undefined &&
      patch.notes === undefined
    ) return;
    // Need to fetch existing item to preserve fields the patch doesn't touch.
    const checklistId = await this.ensureChecklistId(externalId, "phases");
    const existing = await this.fetchCheckItem(checklistId, checkItemId);
    const decoded = decodePhaseItemName(existing.name);
    const next = {
      title: patch.title ?? decoded.title,
      status: patch.status ?? decoded.status,
      notes: patch.notes ?? decoded.notes,
    };
    const url = `${TRELLO_BASE}/cards/${externalId}/checkItem/${checkItemId}?${this.auth()}`;
    await this.requestVoid(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: encodePhaseItemName(next),
          state: next.status === "Complete" ? "complete" : "incomplete",
        }),
      },
      `PUT /cards/${externalId}/checkItem/${checkItemId}`,
    );
  }

  async deletePhaseItem(externalId: string, checkItemId: string): Promise<void> {
    const checklistId = await this.ensureChecklistId(externalId, "phases");
    await this.deleteCheckItem(checklistId, checkItemId);
  }

  async addLinkedActionItemCard(
    title: string,
  ): Promise<{ external_id: string }> {
    const url = `${TRELLO_BASE}/cards?${this.auth()}`;
    const created = await this.requestJson<TrelloCardDto>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idList: this.trello.actionItemsListId,
          name: title,
          pos: "top",
        }),
      },
      "POST /cards (action item)",
    );
    return { external_id: created.id };
  }

  // ---------- internals ----------

  private async fetchListCards(
    listId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const url = this.buildUrl(`/lists/${listId}/cards`, { fields: "id,name" });
    const cards = await this.requestJson<Array<{ id: string; name: string }>>(
      url,
      { method: "GET" },
      `GET /lists/${listId}/cards`,
    );
    return cards.map((c) => ({ id: c.id, name: c.name }));
  }

  private auth(): string {
    return `key=${this.trello.apiKey}&token=${this.trello.apiToken}`;
  }

  /**
   * Build a Trello URL with auth + extra query params using URLSearchParams,
   * so the order of params doesn't matter and string concatenation against
   * an already-trailing `auth()` qs is never required at call sites.
   */
  private buildUrl(path: string, extra?: Record<string, string>): string {
    const params = new URLSearchParams({
      key: this.trello.apiKey,
      token: this.trello.apiToken,
    });
    if (extra) {
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
    }
    return `${TRELLO_BASE}${path}?${params.toString()}`;
  }

  private statusToListId(status: IssueStatus): string {
    switch (status) {
      case "Review":
        return this.trello.reviewListId;
      case "ToDo":
        return this.trello.todoListId;
      case "In Progress":
        return this.trello.inProgressListId;
      case "Needs Help":
        return this.trello.needsHelpListId;
      case "Done":
        return this.trello.doneListId;
      case "Cancelled":
        return this.trello.cancelledListId;
    }
  }

  private listIdToStatus(listId: string): IssueStatus {
    if (listId === this.trello.reviewListId) return "Review";
    if (listId === this.trello.todoListId) return "ToDo";
    if (listId === this.trello.inProgressListId) return "In Progress";
    if (listId === this.trello.needsHelpListId) return "Needs Help";
    if (listId === this.trello.doneListId) return "Done";
    if (listId === this.trello.cancelledListId) return "Cancelled";
    throw new Error(`Trello list id ${listId} is not mapped to a status`);
  }

  private async deriveType(idLabels: string[]): Promise<IssueType> {
    if (idLabels.includes(this.trello.epicLabelId)) return "Epic";
    if (idLabels.includes(this.trello.bugLabelId)) return "Bug";
    return "Feature";
  }

  private async resolveLabelIds(labels: {
    type: IssueType;
    needsHelp: boolean;
    triaged: boolean;
  }): Promise<string[]> {
    const ids: string[] = [];
    switch (labels.type) {
      case "Epic":
        ids.push(this.trello.epicLabelId);
        break;
      case "Bug":
        ids.push(this.trello.bugLabelId);
        break;
      case "Feature":
        ids.push(this.trello.featureLabelId);
        break;
    }
    if (labels.needsHelp) ids.push(this.trello.needsHelpLabelId);
    if (labels.triaged) ids.push(await this.resolveTriagedLabelId());
    return ids;
  }

  private async resolveTriagedLabelId(): Promise<string> {
    if (this.trello.triagedLabelId) return this.trello.triagedLabelId;
    if (this.triagedLabelIdCache) return this.triagedLabelIdCache;
    const url = this.buildUrl(`/boards/${this.trello.boardId}/labels`);
    const labels = await this.requestJson<TrelloLabelDto[]>(
      url,
      { method: "GET" },
      `GET /boards/${this.trello.boardId}/labels`,
    );
    const found = labels.find((l) => l.name === "Triaged");
    if (!found) {
      throw new Error("Trello board has no Triaged label configured");
    }
    this.triagedLabelIdCache = found.id;
    return found.id;
  }

  /**
   * Returns the set of label IDs that this tracker considers managed (i.e.
   * controllable via setLabels). setLabels filters the card's existing
   * idLabels against this set so it preserves any non-managed labels.
   *
   * Caller passes the resolved triaged-label id explicitly so the managed
   * set always includes it — guaranteeing stale Triaged labels can be
   * stripped on `setLabels({triaged: false})` even when the cache is cold.
   */
  private allManagedLabelIdsForFiltering(triagedLabelId: string): string[] {
    return [
      this.trello.bugLabelId,
      this.trello.featureLabelId,
      this.trello.epicLabelId,
      this.trello.needsHelpLabelId,
      triagedLabelId,
    ];
  }

  private async createChecklist(cardId: string, name: string): Promise<string> {
    const url = `${TRELLO_BASE}/cards/${cardId}/checklists?${this.auth()}`;
    const checklist = await this.requestJson<{ id: string }>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
      `POST /cards/${cardId}/checklists`,
    );
    return checklist.id;
  }

  private async createCheckItem(
    checklistId: string,
    name: string,
    checked: boolean,
  ): Promise<{ id: string }> {
    const url = `${TRELLO_BASE}/checklists/${checklistId}/checkItems?${this.auth()}`;
    return await this.requestJson<{ id: string }>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          checked: checked ? "true" : "false",
        }),
      },
      `POST /checklists/${checklistId}/checkItems`,
    );
  }

  private async fetchCheckItem(
    checklistId: string,
    checkItemId: string,
  ): Promise<TrelloCheckItemDto> {
    const url = `${TRELLO_BASE}/checklists/${checklistId}/checkItems/${checkItemId}?${this.auth()}`;
    return await this.requestJson<TrelloCheckItemDto>(
      url,
      { method: "GET" },
      `GET /checklists/${checklistId}/checkItems/${checkItemId}`,
    );
  }

  private async deleteCheckItem(
    checklistId: string,
    checkItemId: string,
  ): Promise<void> {
    const url = `${TRELLO_BASE}/checklists/${checklistId}/checkItems/${checkItemId}?${this.auth()}`;
    await this.requestVoid(
      url,
      { method: "DELETE" },
      `DELETE /checklists/${checklistId}/checkItems/${checkItemId}`,
    );
  }

  private rememberChecklist(
    cardId: string,
    kind: "ac" | "phases",
    checklistId: string,
  ): void {
    const existing = this.checklistIdCache.get(cardId) ?? {};
    existing[kind] = checklistId;
    this.checklistIdCache.set(cardId, existing);
  }

  private async ensureChecklistId(
    externalId: string,
    kind: "ac" | "phases",
  ): Promise<string> {
    const cached = this.checklistIdCache.get(externalId);
    if (cached?.[kind]) return cached[kind] as string;
    const url = this.buildUrl(`/cards/${externalId}/checklists`, {
      fields: "id,name",
    });
    const checklists = await this.requestJson<Array<{ id: string; name: string }>>(
      url,
      { method: "GET" },
      `GET /cards/${externalId}/checklists`,
    );
    const wantedName = kind === "ac" ? AC_CHECKLIST_NAME : PHASES_CHECKLIST_NAME;
    const found = checklists.find((c) => c.name === wantedName);
    if (found) {
      this.rememberChecklist(externalId, kind, found.id);
      return found.id;
    }
    const created = await this.createChecklist(externalId, wantedName);
    this.rememberChecklist(externalId, kind, created);
    return created;
  }

  // ---------- HTTP helpers ----------

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    endpoint: string,
  ): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(
        `Trello API error: ${response.status} ${response.statusText} (${endpoint})`,
      );
    }
    return (await response.json()) as T;
  }

  private async requestVoid(
    url: string,
    init: RequestInit,
    endpoint: string,
  ): Promise<void> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(
        `Trello API error: ${response.status} ${response.statusText} (${endpoint})`,
      );
    }
  }
}

// ---------- Card-title id-prefix encode / decode (exported for tests) ----------

/**
 * Format a Trello card title with the `#<id>: ` prefix so humans on the
 * Trello UI can correlate cards back to local YAML files at a glance.
 *
 * Format: `#<id>: <title>` — example `#ISS-138: [Danxbot] Do stuff`.
 * Empty `id` is a programmer error (every card we create has an id by
 * the time it reaches this point); throws to surface the mistake loudly.
 */
export function formatCardTitle(id: string, title: string): string {
  if (!id) {
    throw new Error("formatCardTitle requires a non-empty id");
  }
  return `#${id}: ${title}`;
}

/**
 * Inverse of `formatCardTitle`. Splits a Trello card name into
 * `{ id, title }`. Cards without the `#ISS-N: ` prefix (human-created,
 * pre-migration legacy, etc.) return `id: ""` and the entire name as
 * `title` — sync layers must handle that case explicitly (typically by
 * skipping the card or running the migration script).
 */
export function parseCardTitle(name: string): { id: string; title: string } {
  const m = /^#(ISS-\d+):\s*(.*)$/.exec(name);
  if (!m) return { id: "", title: name };
  return { id: m[1], title: m[2] };
}

// ---------- Phase-name encode / decode (exported for tests) ----------

export interface PhaseEncodeInput {
  title: string;
  status: PhaseStatus;
  notes: string;
}

export function encodePhaseItemName(p: PhaseEncodeInput): string {
  const header = `${p.status}: ${p.title}`;
  if (!p.notes) return header;
  return `${header}\n${p.notes}`;
}

// Module-level cache of phase headers we've already warned about, so a
// malformed header in a long-running poller doesn't spam logs every tick.
const phaseDecodeWarnedHeaders = new Set<string>();
const phaseDecodeLogger = createLogger("issue-tracker.trello");

export function decodePhaseItemName(name: string): PhaseEncodeInput {
  const lines = name.split("\n");
  const header = lines[0] ?? "";
  const notes = lines.slice(1).join("\n");
  const statuses: readonly PhaseStatus[] = ["Pending", "Complete", "Blocked"];
  for (const status of statuses) {
    const prefix = `${status}: `;
    if (header.startsWith(prefix)) {
      return { status, title: header.slice(prefix.length), notes };
    }
  }
  // Fallback for items that pre-existed before this encoding (e.g. items
  // added by an older tool that wrote raw titles). Treat the entire header
  // as the title with `Pending` status — keeps the round-trip stable. Warn
  // once per unique header so operators see the drift without spam.
  if (!phaseDecodeWarnedHeaders.has(header)) {
    phaseDecodeWarnedHeaders.add(header);
    phaseDecodeLogger.warn(
      `phase decode fallback to Pending: ${header}`,
    );
  }
  return { status: "Pending", title: header, notes };
}
