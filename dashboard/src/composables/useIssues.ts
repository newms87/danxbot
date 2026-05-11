import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ref } from "vue";
import { fetchIssueDetail, fetchIssues, patchIssue } from "../api";
import type { Issue, IssueDetail, IssueListItem, IssueStatus } from "../types";

const POLL_INTERVAL_MS = 30_000;

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
   * The next REST poll (or eventual `issue:updated` SSE event) reconciles
   * any server-side derived fields the optimistic update did not carry.
   */
  moveIssueStatus: (id: string, toStatus: IssueStatus) => Promise<void>;
  /**
   * DX-264 — optimistically write a new `position` for a card (intra-
   * column reorder). The backend sort tier honors position ASC; the
   * SPA does NOT re-sort locally (the next REST poll re-fetches the
   * canonically sorted list). On PATCH failure the local position is
   * reverted and `error` carries the server message.
   */
  moveIssuePosition: (id: string, position: number | null) => Promise<void>;
  /**
   * Apply a server-confirmed Issue snapshot to local state — drops the
   * detail cache entry and merges the patchable fields into the matching
   * IssueListItem so the board view reflects the change without waiting
   * for the next 30s poll. Callers (the drawer's inline edit affordances)
   * forward the post-PATCH issue here after every successful mutation.
   */
  applyIssueUpdate: (updated: Issue) => void;
}

/**
 * Issues-tab state: REST hydrate on mount + on `repo` change, then poll
 * every 30s. SSE push could replace polling later — for now polling is
 * fine because the issue file changes happen on a ~60s poller cycle.
 *
 * Concurrency: each load() captures a monotonic `reqId`; only the latest
 * outstanding request is allowed to commit results. Repo-switch drops the
 * old timer + starts fresh, so repo flips don't double-fire near the
 * existing tick boundary.
 */
export function useIssues(repo: Ref<string>): UseIssues {
  const issues = ref<IssueListItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;
  let currentReq = 0;
  const detailCache = new Map<string, IssueDetail>();
  // Optimistic `moveIssueStatus` mutations awaiting their PATCH to
  // resolve. The 30s poll's `load()` would otherwise overwrite the
  // optimistic state with the still-stale server snapshot — replay
  // these onto every fresh REST commit so the column doesn't snap back.
  const pendingMoves = new Map<string, IssueStatus>();

  async function fetchDetail(id: string): Promise<IssueDetail> {
    const requestRepo = repo.value;
    const cacheKey = `${requestRepo}:${id}`;
    const cached = detailCache.get(cacheKey);
    if (cached) return cached;
    const detail = await fetchIssueDetail(requestRepo, id);
    detailCache.set(cacheKey, detail);
    return detail;
  }

  async function load(): Promise<void> {
    if (!repo.value) {
      issues.value = [];
      error.value = null;
      return;
    }
    const reqId = ++currentReq;
    const requestRepo = repo.value;
    loading.value = true;
    try {
      const result = await fetchIssues(requestRepo);
      if (cancelled || reqId !== currentReq) return;
      // Invalidate cached detail entries whose underlying file mtime has
      // advanced. Keeps reopen-same-drawer instant while preventing stale
      // detail from sticking around after the YAML changes.
      for (const item of result) {
        const cacheKey = `${requestRepo}:${item.id}`;
        const cached = detailCache.get(cacheKey);
        if (cached && cached.updated_at !== item.updated_at) {
          detailCache.delete(cacheKey);
        }
      }
      issues.value = pendingMoves.size === 0
        ? result
        : result.map((i) => {
            const pending = pendingMoves.get(i.id);
            return pending && pending !== i.status
              ? { ...i, status: pending }
              : i;
          });
      error.value = null;
    } catch (err) {
      if (cancelled || reqId !== currentReq) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (reqId === currentReq) loading.value = false;
    }
  }

  function startTimer(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  onMounted(() => {
    void load();
    startTimer();
  });

  watch(repo, () => {
    detailCache.clear();
    void load();
    startTimer();
  });

  onBeforeUnmount(() => {
    cancelled = true;
    stopTimer();
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
    // Invalidate the detail cache so the next drawer-open re-fetches.
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
    refresh: load,
    fetchDetail,
    moveIssueStatus,
    moveIssuePosition,
    applyIssueUpdate,
  };
}

/**
 * Merge the patchable fields of a server-confirmed Issue into an existing
 * IssueListItem projection. Keeps board state consistent with the drawer's
 * just-completed edit without a full re-fetch. Fields the patch surface
 * cannot touch (`created_at`, `children_detail`, `has_retro`) are kept
 * verbatim from the prior projection — the 30s poll reconciles those.
 */
function mergeIntoListItem(item: IssueListItem, updated: Issue): IssueListItem {
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
    updated_at: Date.now(),
  };
}
