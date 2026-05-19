import { computed } from "vue";
import type { ComputedRef, Ref } from "vue";
import { fetchLists } from "../api";
import type { StreamEvent } from "./useStream";
import { createKeyedStreamCache } from "./streamCache";
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
 * **Per-repo shared instance with refcount (DX-682, factored over the
 * DX-689 `createKeyedStreamCache` factory).** Every call to
 * `useListColors(repo)` for the same `repo` returns a facade backed by
 * ONE shared per-repo cache. The card-detail drawer mounts three
 * components that each call `useListColors(repo)` (CardTimeline,
 * DrawerHeader, DispatchGatesSection) — pre-DX-682 each instance fired
 * its own `GET /api/lists?repo=...`. The shared cache fires ONE fetch
 * per repo regardless of how many components mount, refcounting the
 * underlying SSE subscription so the connection survives any single
 * component unmounting and only tears down when the last consumer
 * detaches. Different repos still get independent fetches +
 * subscriptions.
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
 * half-filled file silently. Enforce the minimum shape the reducer
 * accesses; drop with `console.warn` on a mismatch instead of
 * half-rendering.
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

function applyOne(state: List[], event: StreamEvent, repo: string): List[] {
  if (event.topic !== "lists:updated") return state;
  if (!isListsUpdatedPayload(event.data)) {
    // eslint-disable-next-line no-console
    console.warn("useListColors: malformed lists:updated event", event);
    return state;
  }
  if (event.data.repoName !== repo) return state;
  return event.data.file.lists;
}

const cacheFactory = createKeyedStreamCache<List[], string>({
  topic: "lists:updated",
  initialState: () => [],
  fetchFn: async (repo) => (await fetchLists(repo)).lists,
  applyOne,
});

// Per-repo computed index cache. Each repo gets its own ComputedRef<Map>
// derived off the shared cache's `state` ref so colorFor is O(1) and the
// computed memoization survives across facade instances for the same repo.
const indexByRepo = new Map<string, ComputedRef<Map<string, string>>>();

function getIndex(
  repo: string,
  lists: Ref<List[]>,
): ComputedRef<Map<string, string>> {
  const cached = indexByRepo.get(repo);
  if (cached) return cached;
  const idx = computed<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const l of lists.value) map.set(l.name, l.color);
    return map;
  });
  indexByRepo.set(repo, idx);
  return idx;
}

/**
 * Test-only: drop every shared per-repo instance. Tests call this in
 * `beforeEach` so refcount / cached lists / streams do not leak across
 * cases.
 */
export function __resetSharedListColorsForTesting(): void {
  cacheFactory.__resetForTesting();
  indexByRepo.clear();
}

export function useListColors(repo: string): UseListColorsReturn {
  const cache = cacheFactory(repo);
  const indexByName = getIndex(repo, cache.state);

  function colorFor(listName: string): string {
    return indexByName.value.get(listName) ?? NEUTRAL_LIST_COLOR;
  }

  return {
    lists: cache.state,
    loading: cache.loading,
    error: cache.error,
    colorFor,
    refresh: cache.hydrate,
    init: cache.init,
    destroy: cache.destroy,
  };
}
