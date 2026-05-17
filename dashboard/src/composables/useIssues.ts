import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ref } from "vue";
import { fetchIssueDetail, fetchIssues, patchIssue } from "../api";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";
import { LIST_TYPE_LABELS, type IssueDetail, type IssueListItem, type IssueStatus, type ListType } from "../types";

/**
 * Project the derived `IssueStatus` a card will land at after moving
 * into a list of the given `ListType`. Used for the optimistic UI
 * update — the server's `applyListMove` is the authoritative source,
 * and the SSE `issue:updated` event re-affirms within ~50ms.
 *
 * `LIST_TYPE_LABELS` maps `archived → "Backlog"`, etc. The values are
 * already `IssueStatus` literals; the cast is for the `Backlog` /
 * `Review` / `ToDo` / `In Progress` / `Blocked` / `Done` / `Cancelled`
 * surface (one IssueStatus value per ListType).
 */
function statusForListType(type: ListType): IssueStatus {
  // LIST_TYPE_LABELS values: Backlog | Review | Ready | Blocked | In Progress | Completed | Cancelled
  // IssueStatus values:      Backlog | Review | ToDo  | Blocked | In Progress | Done      | Cancelled
  // Translate the two labels that differ.
  const label = LIST_TYPE_LABELS[type];
  if (label === "Ready") return "ToDo";
  if (label === "Completed") return "Done";
  return label as IssueStatus;
}

/**
 * Discriminated payload of the `issue:updated` SSE topic. Mirrored from
 * the backend's `IssueUpdatedPayload` — the wire shape is canonical:
 * the upsert variant carries the fully-projected `item: IssueListItem`,
 * built by the server-side `projectIssue` from the same projector that
 * powers the REST `/api/issues` endpoint. The client reducer never
 * derives cross-card state; this composable is a dumb id-keyed upsert.
 */
type IssueUpdatedData =
  | { repoName: string; id: string; item: IssueListItem; removed?: false }
  | { repoName: string; id: string; removed: true };

function isUpsertEvent(
  data: IssueUpdatedData,
): data is { repoName: string; id: string; item: IssueListItem; removed?: false } {
  return !("removed" in data) || data.removed !== true;
}

function parseIssueEvent(event: StreamEvent): IssueUpdatedData | null {
  if (event.topic !== "issue:updated") return null;
  const data = event.data as IssueUpdatedData | null | undefined;
  if (!data || typeof data !== "object" || typeof data.id !== "string") {
    return null;
  }
  if ("removed" in data && data.removed === true) return data;
  if (!("item" in data) || !data.item || typeof data.item !== "object") {
    return null;
  }
  return data;
}

export interface MoveIssueListOptions {
  /**
   * Pair with INTO-blocked or OUT-of-blocked moves.
   *
   *  - `{reason}` — INTO-blocked dialog submit; the server stamps
   *    `blocked: {at: now, reason}` and skips the rest of the ladder
   *    sweep (caller MUST pair this with a destination whose type is
   *    `blocked`, else server returns 400).
   *  - `null` — explicit unblock confirmation (OUT-of-blocked dialog).
   *  - `undefined` — default ladder semantics; a leftward move out of
   *    a Blocked card auto-clears `blocked`.
   */
  blocked?: { reason: string } | null;
}

export interface UseIssues {
  issues: Ref<IssueListItem[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  refresh: () => Promise<void>;
  fetchDetail: (id: string) => Promise<IssueDetail>;
  /**
   * DX-586 — optimistically move a card between list-driven columns.
   * Mutates `issues[i].list_name` (which the board groups by) AND
   * `issues[i].status` (projected from the dest list's type) immediately,
   * then PATCHes `/api/issues/:id` with `{list_name, [blocked]}`. On
   * failure the row reverts to its pre-move snapshot and the caller
   * receives the server error (also surfaced via the `error` ref).
   *
   * The watcher-backed `issue:updated` SSE feed (DX-226) reconciles
   * server-side derived fields the optimistic update did not carry
   * within ~50ms of the YAML write — `blocked`, `dispatch`, the
   * timestamp triggers are all overwritten by the server's
   * authoritative `IssueListItem` projection.
   */
  moveIssueList: (
    id: string,
    destList: { name: string; type: ListType },
    options?: MoveIssueListOptions,
  ) => Promise<void>;
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
   * Invalidate the cached detail entry for `id`. Called after the drawer's
   * inline edit affordances PATCH the server; the next `fetchDetail(id)`
   * re-fetches the post-mutation YAML. List-row updates flow through the
   * SSE `issue:updated` topic — the server is the only place that
   * projects to `IssueListItem`.
   */
  applyIssueUpdate: (id: string) => void;
}

/**
 * Single-event reducer over an `IssueListItem[]`. Three outcomes:
 *
 *   - `removed: true` → drop the matching id (no-op if absent).
 *   - upsert with a known id → replace the row with the server-projected item.
 *   - upsert with an unknown id → append the server-projected item.
 *
 * No client-side derivation. The wire is canonical. The reducer is dumb.
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
    return [...state, data.item];
  }
  return [
    ...state.slice(0, idx),
    data.item,
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
export function useIssues(
  repo: Ref<string>,
  includeClosed?: Ref<"recent" | "all">,
): UseIssues {
  const issues = ref<IssueListItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let cancelled = false;
  let currentReq = 0;
  const detailCache = new Map<string, IssueDetail>();
  // Optimistic `moveIssueList` mutations awaiting their PATCH to
  // resolve. The SSE upsert (or a manual refresh) would otherwise
  // overwrite the optimistic state with the still-stale server
  // snapshot — replay these onto every fresh REST commit + every SSE
  // event so the column doesn't snap back. The pending value carries
  // BOTH the dest list_name (the board's grouping key) AND the
  // projected derived status so column membership + status-dependent
  // chips both stay consistent during the in-flight window.
  const pendingMoves = new Map<string, { list_name: string; status: IssueStatus }>();

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

    // Replay pendingMoves so an in-flight optimistic move doesn't
    // get clobbered by a SSE upsert that lands before the PATCH ack.
    if (pendingMoves.size === 0) return next;
    return next.map((i) => {
      const pending = pendingMoves.get(i.id);
      if (!pending) return i;
      if (pending.list_name === i.list_name && pending.status === i.status) {
        return i;
      }
      return { ...i, list_name: pending.list_name, status: pending.status };
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
        const result = includeClosed
          ? await fetchIssues(requestRepo, { includeClosed: includeClosed.value })
          : await fetchIssues(requestRepo);
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
              if (!pending) return i;
              if (pending.list_name === i.list_name && pending.status === i.status) {
                return i;
              }
              return { ...i, list_name: pending.list_name, status: pending.status };
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

  // DX-523 — re-fetch the list whenever the include-closed scope flips.
  // Closed cards beyond the recent-50 cap are pull-on-demand: toggling
  // show-closed on the page widens the scope to "all"; toggling off
  // narrows back to "recent" so the default payload stays minimal.
  if (includeClosed) {
    watch(includeClosed, () => {
      void hydrate();
    });
  }

  onBeforeUnmount(() => {
    cancelled = true;
    stopStream();
  });

  async function moveIssueList(
    id: string,
    destList: { name: string; type: ListType },
    options: MoveIssueListOptions = {},
  ): Promise<void> {
    const requestRepo = repo.value;
    if (!requestRepo) throw new Error("No repo selected");
    const idx = issues.value.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`Unknown issue ${id}`);
    const original = issues.value[idx];
    const projectedStatus = statusForListType(destList.type);
    const sameList =
      original.list_name === destList.name &&
      original.status === projectedStatus;
    if (sameList && options.blocked === undefined) return;
    detailCache.delete(`${requestRepo}:${id}`);
    pendingMoves.set(id, { list_name: destList.name, status: projectedStatus });
    issues.value = issues.value.map((i, j) =>
      j === idx
        ? { ...i, list_name: destList.name, status: projectedStatus }
        : i,
    );
    try {
      const patch: { list_name: string; blocked?: { reason: string } | null } = {
        list_name: destList.name,
      };
      if (options.blocked !== undefined) patch.blocked = options.blocked;
      await patchIssue(requestRepo, id, patch);
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

  function applyIssueUpdate(id: string): void {
    const requestRepo = repo.value;
    if (!requestRepo) return;
    // Drop the cached detail so the next drawer open re-fetches the
    // post-mutation YAML. The list-row update arrives via SSE
    // (`issue:updated`) carrying the canonical projected item — no
    // local merge.
    detailCache.delete(`${requestRepo}:${id}`);
  }

  return {
    issues,
    loading,
    error,
    refresh: hydrate,
    fetchDetail,
    moveIssueList,
    moveIssuePosition,
    applyIssueUpdate,
  };
}
