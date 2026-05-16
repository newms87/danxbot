/**
 * DX-558 — SSE-subscribed composable for the root-clone sync banner.
 *
 * Mirrors `useBrokenAgents.ts`'s shape: one `ref` per state slice,
 * one stream subscription per topic, REST hydrate on mount, no
 * `setInterval` (DX-227 mandate).
 *
 * Two topics drive the reducer:
 *   - `repo-root-sync:error` — payload `{repoName, error}`. Replaces
 *     (or inserts) the entry for that repo.
 *   - `repo-root-sync:clear` — payload `{repoName}`. Removes the
 *     entry.
 *
 * The retry action sets a per-repo `retrying` flag for the duration
 * of the POST; the SSE feed re-asserts the post-sync state, so on
 * success the entry either disappears (sync succeeded) or is replaced
 * with fresh error detail (still dirty).
 */

import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Ref } from "vue";
import { fetchSyncRootStates, retrySyncRoot } from "../api";
import { useStream, type UseStreamReturn } from "./useStream";
import type { RepoRootSyncError, SyncRootStateEntry } from "../types";

/**
 * Local view-model row. `retrying` is local-only mutation state, not
 * stamped on the server — it goes true on click, false on the POST's
 * settle.
 */
export interface RepoRootSyncEntry {
  repoName: string;
  error: RepoRootSyncError;
  retrying: boolean;
}

export interface UseRepoRootSync {
  entries: Ref<RepoRootSyncEntry[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  retry: (repoName: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Pure reducer — apply one event to the entries array. Exported for
 * unit testing.
 */
export function applyEvent(
  state: RepoRootSyncEntry[],
  event:
    | { type: "error"; repoName: string; error: RepoRootSyncError }
    | { type: "clear"; repoName: string },
): RepoRootSyncEntry[] {
  if (event.type === "clear") {
    return state.filter((e) => e.repoName !== event.repoName);
  }
  const idx = state.findIndex((e) => e.repoName === event.repoName);
  if (idx === -1) {
    return [...state, { repoName: event.repoName, error: event.error, retrying: false }];
  }
  const next = [...state];
  next[idx] = { ...next[idx], error: event.error };
  return next;
}

/**
 * Inline guards for SSE payload shapes — the wire is `JSON.parse`d
 * untyped text, so a backend drift would otherwise render malformed
 * rows. Inner `error` shape validation delegates to the backend's
 * `isRepoRootSyncError` re-exported via the type bundle.
 */
import { isRepoRootSyncError } from "@backend/worker/sync-root.js";

function isErrorPayload(data: unknown): data is { repoName: string; error: RepoRootSyncError } {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.repoName === "string" && isRepoRootSyncError(d.error);
}

function isClearPayload(data: unknown): data is { repoName: string } {
  if (typeof data !== "object" || data === null) return false;
  return typeof (data as Record<string, unknown>).repoName === "string";
}

export function useRepoRootSync(): UseRepoRootSync {
  const entries = ref<RepoRootSyncEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let stream: UseStreamReturn | null = null;
  const unsubs: Array<() => void> = [];

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const fresh: SyncRootStateEntry[] = await fetchSyncRootStates();
      // Preserve in-flight `retrying` flags across hydrate so the
      // spinner doesn't flicker if a click is mid-POST.
      const flags = new Map(entries.value.map((e) => [e.repoName, e.retrying]));
      entries.value = fresh.map((s) => ({
        repoName: s.repoName,
        error: s.error,
        retrying: flags.get(s.repoName) ?? false,
      }));
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function startStream(): void {
    if (stream) return;
    stream = useStream();
    unsubs.push(
      stream.subscribe("repo-root-sync:error", (event) => {
        if (!isErrorPayload(event.data)) {
          // eslint-disable-next-line no-console
          console.warn("useRepoRootSync: malformed error event", event);
          return;
        }
        entries.value = applyEvent(entries.value, {
          type: "error",
          repoName: event.data.repoName,
          error: event.data.error,
        });
      }),
    );
    unsubs.push(
      stream.subscribe("repo-root-sync:clear", (event) => {
        if (!isClearPayload(event.data)) {
          // eslint-disable-next-line no-console
          console.warn("useRepoRootSync: malformed clear event", event);
          return;
        }
        entries.value = applyEvent(entries.value, {
          type: "clear",
          repoName: event.data.repoName,
        });
      }),
    );
  }

  function stopStream(): void {
    for (const u of unsubs) u();
    unsubs.length = 0;
    stream?.disconnect();
    stream = null;
  }

  function setRetrying(repoName: string, value: boolean): void {
    entries.value = entries.value.map((e) =>
      e.repoName === repoName ? { ...e, retrying: value } : e,
    );
  }

  async function retry(repoName: string): Promise<void> {
    if (!entries.value.some((e) => e.repoName === repoName)) return;
    setRetrying(repoName, true);
    try {
      await retrySyncRoot(repoName);
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      setRetrying(repoName, false);
    }
  }

  onMounted(() => {
    startStream();
    void refresh();
  });

  onBeforeUnmount(() => {
    stopStream();
  });

  return { entries, loading, error, retry, refresh };
}
