import { ref, computed } from "vue";
import type { ComputedRef, Ref } from "vue";
import { fetchLists } from "../api";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";
import type { List, ListsFile } from "../types";

/**
 * DX-603 — `useListColors(repo)` exposes the per-repo list taxonomy as a
 * Vue-reactive cache + a synchronous `colorFor(list_name)` lookup, kept
 * live via the `lists:updated` SSE topic.
 *
 * Per `.claude/rules/dashboard.md`, server state composables MUST flow
 * through `/api/stream` — no `setInterval`. The repo-level sweep test in
 * `dashboard/src/__tests__/no-poll-imports.test.ts` enforces this; the
 * per-file source check in `useListColors.test.ts` is the tighter
 * fast-fail.
 *
 * **Per-repo shared instance with refcount (DX-682).** Every call to
 * `useListColors(repo)` for the same `repo` returns a facade backed by
 * ONE shared per-repo cache. The card-detail drawer mounts three
 * components that each call `useListColors(repo)` (CardTimeline,
 * DrawerHeader, DispatchGatesSection) — pre-DX-682 each instance fired
 * its own `GET /api/lists?repo=...`. The shared cache fires ONE fetch
 * per repo regardless of how many components mount, refcounting the
 * underlying SSE subscription so the connection survives any single
 * component unmounting and only tears down when the last consumer
 * detaches. The dashboard is multi-repo, so the cache is keyed by repo
 * — different repos still get independent fetches + subscriptions.
 *
 * Wire contract:
 * - `GET /api/lists?repo=` returns `{file: ListsFile}` (see `fetchLists`
 *   in `api.ts`). Composable extracts `file.lists` and stores it on
 *   `lists.value`.
 * - SSE topic `lists:updated` carries `{repoName, file}` (see
 *   `lists-routes.ts#publishUpdate`). The shared instance ignores events
 *   for other repos so cross-repo SPA panes don't smear taxonomies.
 */

/**
 * Neutral gray rendered when `colorFor(name)` is called with an unknown
 * list name (typo, stale reference from a deleted list, race between
 * the initial fetch resolving and the first synchronous render). Picked
 * to match the seed `archived` swatch tone family so the fallback reads
 * as "nothing semantic yet" rather than as a real status.
 */
export const NEUTRAL_LIST_COLOR = "#94a3b8" as const;

export interface UseListColorsReturn {
  lists: Ref<List[]>;
  /** True between mount and the resolved initial fetch. */
  loading: Ref<boolean>;
  /** Last fetch / SSE-decoded error; cleared on the next successful hydrate. */
  error: Ref<string | null>;
  /** Synchronous color lookup by list name; returns the neutral fallback for unknown names. */
  colorFor: (listName: string) => string;
  /** Manual re-hydrate; the DanxToggle on the Settings page reuses this for "retry on error". */
  refresh: () => Promise<void>;
  /**
   * Open the SSE subscription + fire the initial hydrate. Idempotent
   * across repeated calls AND across multiple facades for the same repo
   * (refcount). Component mounts call this from `onMounted` (or any
   * equivalent lifecycle hook).
   */
  init: () => void;
  /** Tear down the SSE subscription. Components MUST call this from `onBeforeUnmount`. */
  destroy: () => void;
}

/**
 * Runtime guard for `lists:updated` SSE payloads. The wire is `JSON.parse`
 * of untyped text — schema drift in the producer would otherwise smear a
 * half-filled file silently. Mirrors the philosophy of
 * `useAgents.isAgentSnapshot` / `useDispatches.isDispatchCreated`:
 * enforce the minimum shape the reducer accesses, drop with `console.warn`
 * on a mismatch instead of half-rendering.
 */
function isListsUpdatedPayload(
  data: unknown,
): data is { repoName: string; file: ListsFile } {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as { repoName?: unknown; file?: unknown };
  if (typeof obj.repoName !== "string") return false;
  if (typeof obj.file !== "object" || obj.file === null) return false;
  const file = obj.file as { lists?: unknown };
  return Array.isArray(file.lists);
}

interface SharedListColorsInstance {
  lists: Ref<List[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  indexByName: ComputedRef<Map<string, string>>;
  refresh: () => Promise<void>;
  applyOne: (state: List[], event: StreamEvent) => List[];
  /** Number of facades that have called init() and not yet destroy(). */
  refCount: number;
  /** Live SSE stream + hydration buffer; null when refCount === 0. */
  stream: UseStreamReturn | null;
  buffer: HydrationBuffer<List[]> | null;
}

const sharedByRepo = new Map<string, SharedListColorsInstance>();

function getOrCreateShared(repo: string): SharedListColorsInstance {
  const cached = sharedByRepo.get(repo);
  if (cached) return cached;

  const lists = ref<List[]>([]);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  const indexByName = computed<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const l of lists.value) map.set(l.name, l.color);
    return map;
  });

  function applyOne(state: List[], event: StreamEvent): List[] {
    if (event.topic !== "lists:updated") return state;
    if (!isListsUpdatedPayload(event.data)) {
      // eslint-disable-next-line no-console
      console.warn("useListColors: malformed lists:updated event", event);
      return state;
    }
    if (event.data.repoName !== repo) return state;
    return event.data.file.lists;
  }

  const instance: SharedListColorsInstance = {
    lists,
    loading,
    error,
    indexByName,
    applyOne,
    refresh: async () => {
      if (!instance.buffer) return;
      loading.value = true;
      error.value = null;
      try {
        const next = await instance.buffer.hydrate(
          async () => (await fetchLists(repo)).lists,
          applyOne,
        );
        lists.value = next;
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
      } finally {
        loading.value = false;
      }
    },
    refCount: 0,
    stream: null,
    buffer: null,
  };

  sharedByRepo.set(repo, instance);
  return instance;
}

/**
 * Test-only: drop every shared per-repo instance. Tests call this in
 * `beforeEach` so refcount / cached lists / streams do not leak across
 * cases.
 */
export function __resetSharedListColorsForTesting(): void {
  for (const inst of sharedByRepo.values()) {
    inst.buffer?.close();
    inst.stream?.disconnect();
  }
  sharedByRepo.clear();
}

export function useListColors(repo: string): UseListColorsReturn {
  const shared = getOrCreateShared(repo);
  // Each facade tracks whether IT called init() so destroy() decrements
  // exactly once even on double-destroy calls.
  let attached = false;

  function colorFor(listName: string): string {
    return shared.indexByName.value.get(listName) ?? NEUTRAL_LIST_COLOR;
  }

  function init(): void {
    if (attached) return; // idempotent per facade
    attached = true;
    shared.refCount++;
    if (shared.refCount === 1) {
      // First consumer for this repo — open the stream + fire initial hydrate.
      shared.stream = useStream();
      shared.buffer = createHydrationBuffer<List[]>(shared.stream, [
        "lists:updated",
      ]);
      shared.buffer.onLiveEvent((event) => {
        shared.lists.value = shared.applyOne(shared.lists.value, event);
      });
      void shared.refresh();
    }
  }

  function destroy(): void {
    if (!attached) return; // idempotent per facade
    attached = false;
    shared.refCount--;
    if (shared.refCount <= 0) {
      shared.refCount = 0;
      shared.buffer?.close();
      shared.buffer = null;
      shared.stream?.disconnect();
      shared.stream = null;
    }
  }

  return {
    lists: shared.lists,
    loading: shared.loading,
    error: shared.error,
    colorFor,
    refresh: shared.refresh,
    init,
    destroy,
  };
}
