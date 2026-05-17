import type { TrelloConfig } from "../types.js";
import {
  isOpen as circuitIsOpen,
  openUntilMs as circuitOpenUntilMs,
  recordFailure as circuitRecordFailure,
  recordSuccess as circuitRecordSuccess,
  TrelloCircuitOpen,
} from "./circuit-breaker.js";
import {
  isTriaged,
  type CreateCardInput,
  type Issue,
  type IssueRef,
  type IssueStatus,
  type IssueTracker,
  type IssueType,
  type ManagedLabels,
} from "./interface.js";

const TRELLO_BASE = "https://api.trello.com/1";

const AC_CHECKLIST_NAME = "Acceptance Criteria";

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
  // Maps external_id -> { ac: checklistId } so callbacks for AC mutations
  // don't re-walk the card.
  private checklistIdCache = new Map<string, { ac?: string }>();

  constructor(private readonly trello: TrelloConfig) {}

  // ---------- Public API ----------

  async fetchOpenCards(): Promise<IssueRef[]> {
    // Two list ids map to `status: "Review"` (review + Action Items) —
    // see `listIdToStatus` for the rationale.
    const openLists: Array<{ status: IssueStatus; listId: string }> = [
      { status: "Review", listId: this.trello.reviewListId },
      { status: "ToDo", listId: this.trello.todoListId },
      { status: "In Progress", listId: this.trello.inProgressListId },
      { status: "Blocked", listId: this.trello.needsHelpListId },
      { status: "Review", listId: this.trello.actionItemsListId },
    ];
    const refs: IssueRef[] = [];
    for (const entry of openLists) {
      // `loadTrelloIds` requires every list id, so a non-empty value is
      // an invariant by the time the request reaches this loop.
      if (!entry.listId) continue;
      const cards = await this.fetchListCards(entry.listId);
      for (const card of cards) {
        const { id, title } = parseCardTitle(card.name);
        refs.push({
          id,
          external_id: card.id,
          title,
          status: entry.status,
        });
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
    const card = await this.requestJson<
      TrelloCardDto & { checklists: TrelloChecklistDto[] }
    >(cardUrl, { method: "GET" }, `GET /cards/${externalId}`);

    const status = this.listIdToStatus(card.idList);
    const type = await this.deriveType(card.idLabels);
    const labels = await this.projectLabels(card.idLabels, type);
    const checklists = card.checklists ?? [];
    const acChecklist = checklists.find((c) => c.name === AC_CHECKLIST_NAME);

    if (acChecklist) {
      this.checklistIdCache.set(externalId, { ac: acChecklist.id });
    }

    const ac = (acChecklist?.checkItems ?? []).map((item) => ({
      check_item_id: item.id,
      title: item.name,
      checked: item.state === "complete",
    }));

    // `getCard` does NOT auto-fetch comments — callers that want comments
    // must call `getComments` separately. This avoids a redundant
    // `/actions` round-trip every time `syncIssue` runs (which already
    // calls `getComments` itself for the merge step).
    const parsed = parseCardTitle(card.name);
    return {
      schema_version: 10,
      tracker: "trello",
      // Internal id is parsed from the `#<PREFIX>-N: ` title prefix where
      // PREFIX is any 2-4 uppercase letters (Phase 2 of ISS-99 — supports
      // every per-repo prefix the operator has provisioned). Cards
      // pre-dating the id epoch (or human-created without the prefix)
      // surface here with `id: ""` — sync.ts and higher-level callers are
      // responsible for handling that case (typically by ignoring or by
      // flipping the prefix via the dashboard route).
      id: parsed.id,
      external_id: card.id,
      // `parent_id` and `children` are local-only metadata. Trello has no
      // native parent concept, so the tracker always emits null/[] here;
      // higher layers (poller hydrate, danx-epic-link skill) populate them
      // on the local YAML.
      parent_id: null,
      children: [],
      dispatch: null,
      status,
      type,
      title: parsed.title,
      description: card.desc ?? "",
      // Trello has no native priority field. Outbound mirror never edits
      // it; inbound hydrate emits the schema default. Local YAML is
      // authoritative for `priority` (operator edits it directly).
      priority: 3.0,
      position: null,
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      ac,
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      // `assigned_agent` is local-only metadata (DX-200) — Trello has no
      // native field for the persona claim. Always emit null on read so
      // the local YAML stays authoritative.
      assigned_agent: null,
      // `waiting_on` (dep-chain queue), `blocked` (self-block reason),
      // and `requires_human` (orthogonal "needs human action" indicator,
      // DX-231) are all local-only metadata managed by the agent + worker.
      // Trello has no native field for any of them — labels carry the
      // boolean projection only. Always emit null on read so the local
      // YAML stays authoritative for the structured records.
      waiting_on: null,
      blocked: null,
      requires_human: null,
      conflict_on: [],
      effort_level: null,
      // `history` is local-only audit; Trello has no native field for it.
      // Phase 1 of DX-138 (DX-145) lands the schema; the tracker abstraction
      // never sees history, so `getCard` always emits [] here.
      history: [],
      // `db_updated_at` (v9 / DX-545) — Trello has no native field; the
      // tracker emits "" so the inbound hydrate landing on disk shows
      // the canonical "never-mirrored" sentinel until a save passes
      // through the DB-mirror upsert (Phase 2 wires that path).
      db_updated_at: "",
      // v10 (DX-592) — Trello has no native field for the lifecycle
      // timestamp projections. Always emit null on read so the local
      // YAML stays authoritative once it gets stamped downstream of
      // DX-575.
      archived_at: null,
      ready_at: null,
      completed_at: null,
      cancelled_at: null,
      list_name: null,
      // DX-618 — surface the Trello-side `idList` so syncIssue step 4b
      // can idempotency-check a `moveToList(destinationTrelloListId)`
      // without a second `GET /cards/<id>` round-trip.
      tracker_list_id: card.idList,
      labels,
    };
  }

  async createCard(input: CreateCardInput): Promise<{
    external_id: string;
    ac: { check_item_id: string }[];
  }> {
    const listId = this.statusToListId(input.status);
    // `requires_human: false` on every fresh card — the field is null on
    // create per the schema; agents/operators populate it later via
    // subsequent saves. Phase 3 of DX-231 wires the actual Trello label
    // id into `resolveLabelIds`; today the label is provisioned but
    // unwired here, so passing the boolean is a no-op until then.
    const labelIds = await this.resolveLabelIds({
      type: input.type,
      blocked: input.status === "Blocked",
      requires_human: false,
      triaged: isTriaged(input.triage),
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
      const acChecklistId = await this.createChecklist(
        created.id,
        AC_CHECKLIST_NAME,
      );
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
    for (const c of input.comments) {
      // Push any pre-existing comments through; no special marker handling here
      // — the worker prepends DANXBOT_COMMENT_MARKER in sync.ts.
      await this.addComment(created.id, c.text);
    }
    return { external_id: created.id, ac: acIds };
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
      body.name = patch.id
        ? formatCardTitle(patch.id, patch.title)
        : patch.title;
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

  async moveToList(externalId: string, trelloListId: string): Promise<void> {
    const url = `${TRELLO_BASE}/cards/${externalId}?${this.auth()}`;
    await this.requestVoid(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idList: trelloListId, pos: "top" }),
      },
      `PUT /cards/${externalId} (moveToList)`,
    );
  }

  async setLabels(externalId: string, labels: ManagedLabels): Promise<void> {
    // Eagerly resolve the Triaged label id regardless of `labels.triaged` so
    // the managed-set is always complete. Without this, a stale Triaged
    // label cannot be stripped on `triaged: false` when the cache is cold,
    // because the lookup only fires when triaged is true. If the board has
    // no Triaged label configured, throw — silently degrading would let
    // stale labels persist forever.
    const triagedLabelId = await this.resolveTriagedLabelId();

    const desiredIds = await this.resolveLabelIds(labels);
    const getUrl = this.buildUrl(`/cards/${externalId}`, {
      fields: "idLabels",
    });
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
    // Content-identity short-circuit. Skip the PUT when the resolved
    // next idLabels match the current set exactly. The dominant case
    // this guards is the un-provisioned-requires-human-label scenario
    // (DX-234): the sync diff predicate fires `setLabels` because local
    // `requires_human` is non-null but `projectLabels` returned `false`
    // (no provisioned label id to match) — the resolveLabelIds +
    // managed-set filter collapse `next` back to the existing idLabels
    // because the empty id short-circuits at every layer. Without this
    // guard the sync layer issues 1 no-op PUT/tick per such card
    // (~1440/day per card), reintroducing the exact Trello-quota churn
    // Phase 1 of DX-231 was built to prevent. Sync's `remoteWriteCount`
    // still increments per intent; the actual API mutation is what we
    // suppress.
    const currentSet = new Set<string>(card.idLabels ?? []);
    const sameMembership =
      next.length === currentSet.size && next.every((id) => currentSet.has(id));
    if (sameMembership) return;
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

  /**
   * Project a card's `idLabels` array onto the ManagedLabels shape. Inverse
   * of `resolveLabelIds`. Reused by `getCard` so the returned Issue carries
   * the remote-side label state inline — `syncIssue`'s outbound label diff
   * compares against these without an extra HTTP round-trip.
   */
  private async projectLabels(
    idLabels: string[],
    type: IssueType,
  ): Promise<ManagedLabels> {
    const triagedLabelId = await this.resolveTriagedLabelId();
    return {
      type,
      // status === "Blocked" → mapped to the existing Trello "Blocked"
      // label. The operator-named "Blocked" Trello label / list still
      // exist on the board for now (operator-renamed later); the data
      // layer is fully repurposed to the new "Blocked" status name.
      blocked: idLabels.includes(this.trello.blockedLabelId),
      // `requires_human` (DX-231) is the orthogonal "needs human action"
      // indicator. DX-234 (Phase 3 of DX-231) wires the Trello label id
      // through `TrelloConfig.requiresHumanLabelId`. When the operator
      // has provisioned the label, the projection reads its membership
      // on the card; when the slot is the empty-string fallback (label
      // not yet provisioned), the projection short-circuits to `false`.
      // The sync diff predicate then mismatches against a flagged local
      // card and fires `setLabels` — but the tracker's setLabels detects
      // the content-identical idLabels and skips the PUT, so no API
      // quota is consumed until the operator pastes in the label id and
      // runs the next dispatch.
      requires_human: this.trello.requiresHumanLabelId
        ? idLabels.includes(this.trello.requiresHumanLabelId)
        : false,
      triaged: idLabels.includes(triagedLabelId),
    };
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

  async getComments(
    externalId: string,
  ): Promise<
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
      author: a.memberCreator?.username ?? a.memberCreator?.fullName ?? "",
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
    const ci = await this.createCheckItem(
      checklistId,
      item.title,
      item.checked,
    );
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
      case "Blocked":
        return this.trello.needsHelpListId;
      case "Backlog":
        // Transitional: DX-589 (Phase 9 of DX-575) will wire a real
        // Backlog list. Until then Backlog cards visually live in
        // Review on the tracker — the derived status carries the real
        // signal on the dashboard.
        return this.trello.reviewListId;
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
    if (listId === this.trello.needsHelpListId) return "Blocked";
    if (listId === this.trello.doneListId) return "Done";
    if (listId === this.trello.cancelledListId) return "Cancelled";
    // Phase 4 of ISS-90 collapsed the Action Items list into
    // `status: "Review"` so the per-card triage agent picks them up
    // alongside the Review list. The list itself stays on the Trello
    // board (no rename), but the sync layer remaps it on hydration.
    if (listId === this.trello.actionItemsListId) return "Review";
    throw new Error(`Trello list id ${listId} is not mapped to a status`);
  }

  private async deriveType(idLabels: string[]): Promise<IssueType> {
    if (idLabels.includes(this.trello.epicLabelId)) return "Epic";
    if (idLabels.includes(this.trello.bugLabelId)) return "Bug";
    return "Feature";
  }

  private async resolveLabelIds(labels: ManagedLabels): Promise<string[]> {
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
      case "Chore":
        break;
    }
    // status === "Blocked" → existing Trello "Blocked" label.
    if (labels.blocked) ids.push(this.trello.blockedLabelId);
    // `requires_human` (DX-231 Phase 3 / DX-234) → the orthogonal
    // "needs human action" Trello label provisioned by the setup skill.
    // Skip when the label id is the empty-string fallback (operator has
    // not yet provisioned the label on a not-yet-upgraded board; not
    // schema-legacy — refers to label provisioning state) — `setLabels`
    // becomes a no-op on the boolean. Strip-on-`false` is handled by the
    // managed-set filter in `allManagedLabelIdsForFiltering` (the id is
    // in the managed set when non-empty, so an existing label is filtered
    // out of `preserved` and dropped from the next state).
    if (labels.requires_human && this.trello.requiresHumanLabelId) {
      ids.push(this.trello.requiresHumanLabelId);
    }
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
  // DX-231 Phase 3 (DX-234) wires `requiresHumanLabelId` into the
  // managed set when the operator has provisioned the matching label.
  // The empty-string fallback (not-yet-upgraded boards where the
  // operator has not provisioned the requires-human label; not
  // schema-legacy) is excluded so the filter
  // never collapses an empty id into the managed set — that would let
  // the operator's blank slot accidentally strip every non-managed
  // label whose id happens to compare empty.
  private allManagedLabelIdsForFiltering(triagedLabelId: string): string[] {
    const ids = [
      this.trello.bugLabelId,
      this.trello.featureLabelId,
      this.trello.epicLabelId,
      this.trello.needsHelpLabelId,
      this.trello.blockedLabelId,
      triagedLabelId,
    ];
    if (this.trello.requiresHumanLabelId) {
      ids.push(this.trello.requiresHumanLabelId);
    }
    return ids;
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
    kind: "ac",
    checklistId: string,
  ): void {
    const existing = this.checklistIdCache.get(cardId) ?? {};
    existing[kind] = checklistId;
    this.checklistIdCache.set(cardId, existing);
  }

  private async ensureChecklistId(
    externalId: string,
    kind: "ac",
  ): Promise<string> {
    const cached = this.checklistIdCache.get(externalId);
    if (cached?.[kind]) return cached[kind] as string;
    const url = this.buildUrl(`/cards/${externalId}/checklists`, {
      fields: "id,name",
    });
    const checklists = await this.requestJson<
      Array<{ id: string; name: string }>
    >(url, { method: "GET" }, `GET /cards/${externalId}/checklists`);
    const wantedName = AC_CHECKLIST_NAME;
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

  // ----- HTTP helpers with circuit-breaker gating (DX-300) -----
  //
  // Every Trello-bound call funnels through `requestRaw`, which carries
  // the pre-call circuit check + post-call recordSuccess/recordFailure.
  // The pre-call check short-circuits with `TrelloCircuitOpen` when the
  // breaker is open, so 20 concurrent callers don't all hit Trello after
  // the first 429 trips the breaker. The post-call branch records
  // success/failure; only 429s actually trip the breaker (other failures
  // are pass-through). Side-effects are contained here so callers
  // (`syncIssue`, retry-queue, reconcile) don't need to know the breaker
  // exists. Network-level failures (DNS, TCP reset, fetch abort) bubble
  // up as-is — they are NOT 429s and do not trip the breaker.
  //
  // `requestJson` and `requestVoid` are thin shape-adapters over
  // `requestRaw`: they decide how to read the response body, nothing else.

  private async requestRaw(
    url: string,
    init: RequestInit,
    endpoint: string,
  ): Promise<Response> {
    if (circuitIsOpen()) {
      throw new TrelloCircuitOpen(circuitOpenUntilMs());
    }
    const response = await fetch(url, init);
    if (!response.ok) {
      const err = new Error(
        `Trello API error: ${response.status} ${response.statusText} (${endpoint})`,
      );
      circuitRecordFailure(err, { endpoint });
      throw err;
    }
    circuitRecordSuccess();
    return response;
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    endpoint: string,
  ): Promise<T> {
    const response = await this.requestRaw(url, init, endpoint);
    return (await response.json()) as T;
  }

  private async requestVoid(
    url: string,
    init: RequestInit,
    endpoint: string,
  ): Promise<void> {
    await this.requestRaw(url, init, endpoint);
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
 * `{ id, title }`. Cards without the `#<PREFIX>-N: ` shape (human-created,
 * pre-id-epoch legacy titles — refers to pre-Phase-1-ISS-99 cards on a
 * connected board, not schema-legacy) return `id: ""` and the entire name
 * as `title` — sync layers must handle that case explicitly (typically by
 * skipping the card or flipping the prefix via the dashboard route).
 *
 * Phase 2 of ISS-99 broadened the prefix from a hardcoded `ISS` to any
 * 2-4 uppercase ASCII letters so connected repos with prefixes like
 * `DX` (danxbot), `SG` (gpt-manager), or `FD` (platform) parse identically
 * to pre-prefix-rollout `ISS-` titles (the historical default before
 * ISS-99 — not schema-legacy). The shape mirrors `ISSUE_PREFIX_SHAPE` in
 * `src/issue-tracker/yaml.ts`. Per-card prefix validation against the
 * repo's configured `issue_prefix` happens at YAML parse time
 * (`parseIssue` with `expectedPrefix`), not here — this function is
 * the cross-repo inbound parser, so it accepts every valid shape.
 */
export function parseCardTitle(name: string): { id: string; title: string } {
  const m = /^#([A-Z]{2,4}-\d+):\s*(.*)$/.exec(name);
  if (!m) return { id: "", title: name };
  return { id: m[1], title: m[2] };
}

