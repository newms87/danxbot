import { ref, computed } from "vue";
import type { Ref } from "vue";
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
 * One composable instance per (`useListColors` call), keyed by `repo`.
 * Multiple components in the same page share the same instance ONLY when
 * they import + call together — there is no module-scoped singleton
 * because the dashboard is multi-repo and the taxonomy diverges per repo
 * (operator-customizable). Tests cover the hydrate-then-patch race via
 * the `createHydrationBuffer` helper used by `useDispatches` / `useAgents`.
 *
 * Wire contract:
 * - `GET /api/lists?repo=` returns `{file: ListsFile}` (see `fetchLists`
 *   in `api.ts`). Composable extracts `file.lists` and stores it on
 *   `lists.value`.
 * - SSE topic `lists:updated` carries `{repoName, file}` (see
 *   `lists-routes.ts#publishUpdate`). Composable ignores events for
 *   other repos so a multi-repo SPA pulling `useListColors("danxbot")`
 *   and `useListColors("platform")` in different mounted views does not
 *   smear taxonomies. (The platform branch would create its own instance
 *   anyway — this is defense in depth.)
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
   * Open the SSE subscription + fire the initial hydrate. Idempotent across
   * repeated calls (matches `useDispatches.init`). Component mounts call
   * this from `onMounted` (or any equivalent lifecycle hook).
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

export function useListColors(repo: string): UseListColorsReturn {
  const lists = ref<List[]>([]);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  let stream: UseStreamReturn | null = null;
  let buffer: HydrationBuffer<List[]> | null = null;

  /** Index for synchronous lookup. Recomputed whenever `lists.value` changes. */
  const indexByName = computed<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const l of lists.value) map.set(l.name, l.color);
    return map;
  });

  function colorFor(listName: string): string {
    return indexByName.value.get(listName) ?? NEUTRAL_LIST_COLOR;
  }

  /**
   * Apply one SSE event to a snapshot. Drops events for OTHER repos
   * (defense in depth — the composable is per-repo and the typical caller
   * picks one repo, but the SSE topic is global). Replaces the whole list
   * for THIS repo because the producer always publishes the full file on
   * every write (`lists-routes.ts#publishUpdate`). Cheaper than a per-list
   * diff and avoids ordering bugs.
   */
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

  async function hydrate(): Promise<void> {
    if (!buffer) return;
    loading.value = true;
    error.value = null;
    try {
      const next = await buffer.hydrate(
        async () => (await fetchLists(repo)).lists,
        applyOne,
      );
      lists.value = next;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function init(): void {
    if (stream) return; // idempotent
    stream = useStream();
    buffer = createHydrationBuffer<List[]>(stream, ["lists:updated"]);
    buffer.onLiveEvent((event) => {
      lists.value = applyOne(lists.value, event);
    });
    void hydrate();
  }

  function destroy(): void {
    buffer?.close();
    buffer = null;
    stream?.disconnect();
    stream = null;
  }

  return { lists, loading, error, colorFor, refresh: hydrate, init, destroy };
}
