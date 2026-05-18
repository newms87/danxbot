import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import type { Ref } from "vue";
import { fetchAgentRuntimeState } from "../api";
import type { AgentRuntimeState } from "../types";
import { useStream } from "./useStream";

/**
 * DX-684 — read-side composable for `GET /api/agents/:repo/state`.
 *
 * Sources the per-repo `critical_failure` / `sync_state` /
 * `runtime_settings` from the new aggregated route so the Agents tab
 * renders directly from runtime-volume reads rather than a denormalized
 * snapshot field.
 *
 * Refresh model — REST hydrate on mount + SSE-driven invalidation per
 * the dashboard.md "Real-time Updates Are Mandatory" rule:
 *
 *   - `agent:updated`  — fires when a snapshot mutates (toggle, clear-
 *     critical-failure, settings change). The composable re-fetches its
 *     own endpoint when the event's `repoName` matches.
 *   - `repo-root-sync:error` / `repo-root-sync:clear` — fired by the
 *     dashboard's chokidar bridge on `<runtime-volume>/<repo>/sync-root-
 *     state.json` write / unlink. Updates the composable's `sync_state`
 *     slice without polling.
 *
 * No `setInterval`, no time-driven polling. `no-poll-imports.test.ts`
 * sweep enforces this at build time.
 */
export interface UseAgentRuntimeState {
  state: Ref<AgentRuntimeState | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  refresh: () => Promise<void>;
}

export function useAgentRuntimeState(
  repoName: Ref<string> | string,
): UseAgentRuntimeState {
  const state = ref<AgentRuntimeState | null>(null);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);
  let stream: ReturnType<typeof useStream> | null = null;
  const unsubscribers: Array<() => void> = [];

  function resolveName(): string {
    return typeof repoName === "string" ? repoName : repoName.value;
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      state.value = await fetchAgentRuntimeState(resolveName());
      error.value = null;
    } catch (err) {
      // Null the cached payload on fetch failure so the parent's
      // fallback path (snapshot field) renders the freshest known
      // truth — leaving stale state would wedge the banner when the
      // operator clears the flag and the very next refresh blips.
      state.value = null;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function matchesThisRepo(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as { name?: unknown; repoName?: unknown };
    const eventRepo =
      typeof obj.repoName === "string"
        ? obj.repoName
        : typeof obj.name === "string"
          ? obj.name
          : null;
    return eventRepo === resolveName();
  }

  function attachStream(): void {
    if (stream) return;
    stream = useStream();
    for (const topic of [
      "agent:updated",
      "repo-root-sync:error",
      "repo-root-sync:clear",
    ]) {
      const off = stream.subscribe(topic, (event) => {
        if (!matchesThisRepo(event.data)) return;
        void refresh();
      });
      unsubscribers.push(off);
    }
  }

  function detachStream(): void {
    for (const off of unsubscribers) off();
    unsubscribers.length = 0;
    stream?.disconnect();
    stream = null;
  }

  onMounted(() => {
    attachStream();
    void refresh();
  });

  onBeforeUnmount(() => {
    detachStream();
  });

  // Re-fetch when the repo identity changes (parent rebound the prop).
  if (typeof repoName !== "string") {
    watch(repoName, () => {
      void refresh();
    });
  }

  return { state, loading, error, refresh };
}
