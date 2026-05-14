import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ref } from "vue";
import { cloneTriage } from "@backend/issue-tracker/interface.js";
import { fetchIssueDetail, fetchIssues, patchIssue } from "../api";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";
import type {
  Issue,
  IssueDetail,
  IssueListChild,
  IssueListItem,
  IssueStatus,
} from "../types";

/**
 * Discriminated payload of the `issue:updated` SSE topic — mirrored from
 * the backend's `IssueUpdatedPayload`. Re-declared here (not imported from
 * `../types`) because the backend type uses the full `Issue` graph; this
 * one matches the projection the reducer needs without dragging the
 * backend's narrowing helpers in.
 */
type IssueUpdatedData =
  | { repoName: string; id: string; issue: Issue; removed?: false }
  | { repoName: string; id: string; removed: true };

/** Type guard for the upsert variant. */
function isUpsertEvent(
  data: IssueUpdatedData,
): data is { repoName: string; id: string; issue: Issue; removed?: false } {
  return !("removed" in data) || data.removed !== true;
}

/**
 * Single source of truth for parsing + shape-validating an `issue:updated`
 * SSE event. Both the pure reducer (`applyIssueEvent`) and the composable's
 * repo-filtered wrapper (`useIssues.applyEvent`) call this so the cast
 * + null-guards live in one place. Returns `null` if the event is not
 * `issue:updated`, has a non-object payload, or is missing required keys.
 */
function parseIssueEvent(event: StreamEvent): IssueUpdatedData | null {
  if (event.topic !== "issue:updated") return null;
  const data = event.data as IssueUpdatedData | null | undefined;
  if (!data || typeof data !== "object" || typeof data.id !== "string") {
    return null;
  }
  if ("removed" in data && data.removed === true) return data;
  if (!("issue" in data) || !data.issue || typeof data.issue !== "object") {
    return null;
  }
  return data;
}

export interface UseIssues {
  issues: Ref<IssueListItem[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  refresh: () => Promise<void>;
  fetchDetail: (id: string) => Promise<IssueDetail>;
  /**
   * Optimistically move a card between columns. Mutates `issues` immediately
   * so the UI re-renders, then PATCHes `/api/issues/:id`. On failure the
   * local state reverts to the prior status and the caller receives the
   * server error (also surfaced via the `error` ref).
   *
   * The watcher-backed `issue:updated` SSE feed (DX-226) reconciles
   * server-side derived fields the optimistic update did not carry
   * within ~50ms of the YAML write.
   */
  moveIssueStatus: (id: string, toStatus: IssueStatus) => Promise<void>;
  /**
   * DX-264 — optimistically write a new `position` for a card (intra-
   * column reorder). The backend sort tier honors position ASC; the
   * SPA does NOT re-sort locally (the post-write `issue:updated` SSE
   * event re-affirms the canonically sorted list). On PATCH failure
   * the local position is reverted and `error` carries the server
   * message.
   */
  moveIssuePosition: (id: string, position: number | null) => Promise<void>;
  /**
   * Apply a server-confirmed Issue snapshot to local state — drops the
   * detail cache entry and merges the patchable fields into the matching
   * IssueListItem. Used by the drawer's inline edit affordances after
   * every successful PATCH; the same projection runs inside the SSE
   * reducer so optimistic + push paths produce identical state.
   */
  applyIssueUpdate: (updated: Issue) => void;
}

/**
 * Project a server-confirmed Issue into an IssueListItem row, preserving
 * the IssueListItem-only fields (`children_detail`, `has_retro`,
 * `created_at`) from the prior row. Shared between the drawer's
 * `applyIssueUpdate` path and the SSE reducer so both produce the
 * same projection.
 */
function mergeIntoListItem(
  item: IssueListItem,
  updated: Issue,
): IssueListItem {
  const acDone = updated.ac.filter((a) => a.checked).length;
  return {
    ...item,
    title: updated.title,
    description: updated.description,
    status: updated.status,
    type: updated.type,
    priority: updated.priority,
    position: updated.position,
    parent_id: updated.parent_id,
    children: [...updated.children],
    ac_done: acDone,
    ac_total: updated.ac.length,
    comments_count: updated.comments.length,
    waiting_on: updated.waiting_on !== null,
    waiting_on_reason: updated.waiting_on?.reason ?? null,
    waiting_on_by: updated.waiting_on?.by ?? [],
    assigned_agent: updated.assigned_agent,
    triage: cloneTriage(updated.triage),
    updated_at: Date.now(),
  };
}

/**
 * Build a brand-new IssueListItem from an Issue when the SSE feed
 * reports an id we have not seen before (a watcher `add` for a freshly-
 * created card). Computed projection fields the backend derives from
 * cross-card walks (`children_detail`, `has_retro`,
 * `requires_human_child_count`, `conflict_on_active_count`) are
 * impossible to reconstruct from one Issue — they fill in to safe
 * zero/empty defaults. The next REST hydrate (which carries the
 * canonical backend projection) re-affirms the proper values.
 */
function projectIssueToListItem(
  updated: Issue,
  fallbackCreatedAt: number,
): IssueListItem {
  const acDone = updated.ac.filter((a) => a.checked).length;
  return {
    id: updated.id,
    type: updated.type,
    title: updated.title,
    description: updated.description,
    status: updated.status,
    parent_id: updated.parent_id,
    children: [...updated.children],
    ac_total: updated.ac.length,
    ac_done: acDone,
    children_detail: [] as IssueListChild[],
    waiting_on: updated.waiting_on !== null,
    waiting_on_reason: updated.waiting_on?.reason ?? null,
    waiting_on_by: updated.waiting_on?.by ?? [],
    comments_count: updated.comments.length,
    has_retro: false,
    updated_at: fallbackCreatedAt,
    created_at: fallbackCreatedAt,
    priority: updated.priority,
    position: updated.position,
    assigned_agent: updated.assigned_agent,
    requires_human: updated.requires_human,
    requires_human_child_count: 0,
    blocked: updated.blocked,
    conflict_on: updated.conflict_on,
    conflict_on_active_count: 0,
    triage: cloneTriage(updated.triage),
  };
}

/**
 * Single-event reducer over an IssueListItem[]. Three outcomes:
 *
 *   - `removed: true` → drop the matching id (no-op if absent).
 *   - upsert variant with a known id → merge via `mergeIntoListItem`.
 *   - upsert variant with an unknown id → append a freshly-projected row.
 *
 * Returns the same array reference when the event causes no observable
 * change (e.g. a `removed` for an id we don't have, or a wrong-repo
 * filter caller-side that still reached this reducer). The wrapper
 * upstream is expected to gate by repo BEFORE calling this — the
 * `repo` filter is enforced at the subscription boundary, not here.
 */
export function applyIssueEvent(
  state: IssueListItem[],
  event: StreamEvent,
): IssueListItem[] {
  const data = parseIssueEvent(event);
  if (!data) return state;
  if (!isUpsertEvent(data)) {
    const idx = state.findIndex((i) => i.id === data.id);
    if (idx === -1) return state;
    return [...state.slice(0, idx), ...state.slice(idx + 1)];
  }
  const idx = state.findIndex((i) => i.id === data.id);
  if (idx === -1) {
    return [...state, projectIssueToListItem(data.issue, Date.now())];
  }
  return [
    ...state.slice(0, idx),
    mergeIntoListItem(state[idx], data.issue),
    ...state.slice(idx + 1),
  ];
}

/**
 * Issues-tab state: REST hydrate on mount / repo change, then push
 * updates via the SSE `issue:updated` topic (DX-226). The 30s
 * `setInterval` loop the original implementation used is retired —
 * the dashboard's per-repo chokidar publishes within ~50ms of any
 * YAML write so the polling cadence is no longer load-bearing.
 *
 * Concurrency: each REST hydrate captures a monotonic `reqId`; only
 * the latest outstanding request commits results. Optimistic
 * mutations (`moveIssueStatus` / `moveIssuePosition`) replay the
 * pending status onto every fresh hydrate so a SSE upsert mid-flight
 * doesn't snap back.
 */
export function useIssues(repo: Ref<string>): UseIssues {
  const issues = ref<IssueListItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let cancelled = false;
  let currentReq = 0;
  const detailCache = new Map<string, IssueDetail>();
  // Optimistic `moveIssueStatus` mutations awaiting their PATCH to
  // resolve. The SSE upsert (or a manual refresh) would otherwise
  // overwrite the optimistic state with the still-stale server
  // snapshot — replay these onto every fresh REST commit + every SSE
  // event so the column doesn't snap back.
  const pendingMoves = new Map<string, IssueStatus>();

  let stream: UseStreamReturn | null = null;
  let buffer: HydrationBuffer<IssueListItem[]> | null = null;

  async function fetchDetail(id: string): Promise<IssueDetail> {
    const requestRepo = repo.value;
    const cacheKey = `${requestRepo}:${id}`;
    const cached = detailCache.get(cacheKey);
    if (cached) return cached;
    const detail = await fetchIssueDetail(requestRepo, id);
    detailCache.set(cacheKey, detail);
    return detail;
  }

  /**
   * Apply one SSE event. Repo filter is enforced here so unrelated
   * repos' events are dropped before they reach the pure reducer.
   * Detail-cache invalidation runs ONLY when the reducer actually
   * mutated state — a `removed: true` for an unknown id (or a
   * no-op event) leaves the cache intact so a re-opened drawer
   * remains instant.
   */
  function applyEvent(
    state: IssueListItem[],
    event: StreamEvent,
  ): IssueListItem[] {
    const data = parseIssueEvent(event);
    if (!data || data.repoName !== repo.value) return state;

    const next = applyIssueEvent(state, event);
    if (next === state) return state;

    // Real state change → drop the cached detail so the next drawer
    // open re-fetches the post-mutation YAML. Deferred until after
    // the reducer call so no-op events don't churn the cache.
    detailCache.delete(`${repo.value}:${data.id}`);

    // Replay pendingMoves so an in-flight optimistic status doesn't
    // get clobbered by a SSE upsert that lands before the PATCH ack.
    if (pendingMoves.size === 0) return next;
    return next.map((i) => {
      const pending = pendingMoves.get(i.id);
      return pending && pending !== i.status ? { ...i, status: pending } : i;
    });
  }

  async function hydrate(): Promise<void> {
    if (!buffer) return;
    if (!repo.value) {
      issues.value = [];
      error.value = null;
      return;
    }
    const reqId = ++currentReq;
    const requestRepo = repo.value;
    loading.value = true;
    try {
      const next = await buffer.hydrate(async () => {
        const result = await fetchIssues(requestRepo);
        if (cancelled || reqId !== currentReq) return issues.value;
        // Invalidate cached detail entries whose underlying mtime has
        // advanced. Mirrors pre-DX-226 polling behavior: re-open same
        // drawer is instant when the YAML is unchanged, fresh when
        // the YAML has moved on.
        for (const item of result) {
          const cacheKey = `${requestRepo}:${item.id}`;
          const cached = detailCache.get(cacheKey);
          if (cached && cached.updated_at !== item.updated_at) {
            detailCache.delete(cacheKey);
          }
        }
        return pendingMoves.size === 0
          ? result
          : result.map((i) => {
              const pending = pendingMoves.get(i.id);
              return pending && pending !== i.status
                ? { ...i, status: pending }
                : i;
            });
      }, applyEvent);
      if (cancelled || reqId !== currentReq) return;
      issues.value = next;
      error.value = null;
    } catch (err) {
      if (cancelled || reqId !== currentReq) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (reqId === currentReq) loading.value = false;
    }
  }

  function startStream(): void {
    if (buffer) return;
    if (!stream) stream = useStream();
    buffer = createHydrationBuffer<IssueListItem[]>(stream, "issue:updated");
    buffer.onLiveEvent((event) => {
      issues.value = applyEvent(issues.value, event);
    });
  }

  function stopStream(): void {
    buffer?.close();
    buffer = null;
    stream?.disconnect();
    stream = null;
  }

  onMounted(() => {
    startStream();
    void hydrate();
  });

  watch(repo, () => {
    detailCache.clear();
    void hydrate();
  });

  onBeforeUnmount(() => {
    cancelled = true;
    stopStream();
  });

  async function moveIssueStatus(
    id: string,
    toStatus: IssueStatus,
  ): Promise<void> {
    const requestRepo = repo.value;
    if (!requestRepo) throw new Error("No repo selected");
    const idx = issues.value.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`Unknown issue ${id}`);
    const original = issues.value[idx];
    if (original.status === toStatus) return;
    detailCache.delete(`${requestRepo}:${id}`);
    pendingMoves.set(id, toStatus);
    issues.value = issues.value.map((i, j) =>
      j === idx ? { ...i, status: toStatus } : i,
    );
    try {
      await patchIssue(requestRepo, id, { status: toStatus });
    } catch (err) {
      issues.value = issues.value.map((i) => (i.id === id ? original : i));
      const message = err instanceof Error ? err.message : String(err);
      error.value = message;
      throw err;
    } finally {
      pendingMoves.delete(id);
    }
  }

  async function moveIssuePosition(
    id: string,
    position: number | null,
  ): Promise<void> {
    const requestRepo = repo.value;
    if (!requestRepo) throw new Error("No repo selected");
    const idx = issues.value.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`Unknown issue ${id}`);
    const original = issues.value[idx];
    if (original.position === position) return;
    detailCache.delete(`${requestRepo}:${id}`);
    issues.value = issues.value.map((i, j) =>
      j === idx ? { ...i, position } : i,
    );
    try {
      await patchIssue(requestRepo, id, { position });
    } catch (err) {
      issues.value = issues.value.map((i) => (i.id === id ? original : i));
      const message = err instanceof Error ? err.message : String(err);
      error.value = message;
      throw err;
    }
  }

  function applyIssueUpdate(updated: Issue): void {
    const requestRepo = repo.value;
    if (!requestRepo) return;
    detailCache.delete(`${requestRepo}:${updated.id}`);
    const idx = issues.value.findIndex((i) => i.id === updated.id);
    if (idx === -1) return;
    issues.value = issues.value.map((i, j) =>
      j === idx ? mergeIntoListItem(i, updated) : i,
    );
  }

  return {
    issues,
    loading,
    error,
    refresh: hydrate,
    fetchDetail,
    moveIssueStatus,
    moveIssuePosition,
    applyIssueUpdate,
  };
}
