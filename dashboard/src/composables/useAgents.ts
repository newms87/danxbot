import { ref, onMounted, onBeforeUnmount } from "vue";
import type { Ref } from "vue";
import {
  clearCriticalFailure as clearCriticalFailureApi,
  fetchAgent,
  fetchAgents,
  patchToggle,
  type ToggleError,
} from "../api";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";
import type { AgentSnapshot, Feature } from "../types";

export interface UseAgents {
  agents: Ref<AgentSnapshot[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  toggle: (repo: string, feature: Feature, enabled: boolean | null) => Promise<void>;
  clearCriticalFailure: (repo: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Runtime guard for `agent:updated` SSE payloads. `/api/stream` is `JSON.parse`
 * of untyped text — a backend schema drift would otherwise render a
 * half-filled row silently. Every field the reducer touches (`name`, the
 * entire snapshot it replaces) must exist; here we enforce the minimum
 * shape (`name: string`) and let the reducer trust the rest, same guard
 * philosophy as `useDispatches.isDispatchCreated`.
 */
export function isAgentSnapshot(data: unknown): data is AgentSnapshot {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as { name?: unknown; settings?: unknown };
  return (
    typeof obj.name === "string" &&
    typeof obj.settings === "object" &&
    obj.settings !== null
  );
}

/**
 * Pure reducer: apply one `agent:updated` snapshot to the agents list.
 *
 * Replaces the matching row by `snapshot.name` and preserves list order.
 * If the name is not in state, appends + warns — a new repo appearing
 * mid-session is rare (it requires a deploy) so we surface the mismatch
 * for debuggability rather than dropping silently. Returns a NEW array
 * so Vue's reactivity triggers; never mutates the input.
 */
export function applyAgentEvent(
  state: AgentSnapshot[],
  snapshot: AgentSnapshot,
): AgentSnapshot[] {
  const idx = state.findIndex((a) => a.name === snapshot.name);
  if (idx === -1) {
    // eslint-disable-next-line no-console
    console.warn(
      `useAgents: agent:updated for unknown repo "${snapshot.name}" — ` +
        `appending. Next REST hydrate will confirm the row is real.`,
    );
    return [...state, snapshot];
  }
  return [...state.slice(0, idx), snapshot, ...state.slice(idx + 1)];
}

/**
 * Build the Agents tab state: REST hydrate on mount + `agent:updated` SSE
 * subscription for live patches, with visibility-pause (stream disconnects
 * while the tab is hidden, re-subscribes + re-hydrates on show).
 *
 * ### Wire contract
 *
 * Backend emits exactly ONE agent topic: `agent:updated`, carrying a full
 * `AgentSnapshot` as the payload. Producer: `src/dashboard/agents-routes.ts`
 * `handlePatchToggle` publishes after a successful settings write. The
 * `DELETE /critical-failure` route does NOT publish — the SPA re-fetches
 * the single repo via `fetchAgent` afterward (see `clearCriticalFailure`
 * below). No per-repo subscription needed — one topic, server fans out.
 *
 * ### Hydrate-then-patch race
 *
 * Handled by `createHydrationBuffer` — the same physical subscription
 * stays open across the buffered→live boundary, so events arriving during
 * the REST fetch are replayed via applyEvent and post-hydrate events flow
 * to the live handler with no microtask gap. See `useStream.ts` for the
 * full helper contract.
 *
 * ### Preserved behavior
 *
 * Optimistic toggle + rollback and `clearCriticalFailure` are unchanged —
 * Phase 5 replaced the 10s polling with a push subscription, Phase 7
 * deletes the manual hydrating/pendingUpdates state in favor of the
 * shared buffer helper. Wire contract is identical.
 */
export function useAgents(): UseAgents {
  const agents = ref<AgentSnapshot[]>([]);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  let stream: UseStreamReturn | null = null;
  let buffer: HydrationBuffer<AgentSnapshot[]> | null = null;
  let visibilityHandler: (() => void) | null = null;

  function applyOne(
    state: AgentSnapshot[],
    event: StreamEvent,
  ): AgentSnapshot[] {
    if (!isAgentSnapshot(event.data)) {
      // eslint-disable-next-line no-console
      console.warn("useAgents: malformed agent:updated event", event);
      return state;
    }
    return applyAgentEvent(state, event.data);
  }

  async function hydrate(): Promise<void> {
    if (!buffer) return;
    loading.value = true;
    try {
      agents.value = await buffer.hydrate(() => fetchAgents(), applyOne);
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function startStream(): void {
    if (buffer) return; // idempotent
    if (!stream) stream = useStream();
    buffer = createHydrationBuffer<AgentSnapshot[]>(stream, "agent:updated");
    buffer.onLiveEvent((event) => {
      agents.value = applyOne(agents.value, event);
    });
  }

  function stopStream(): void {
    buffer?.close();
    buffer = null;
    stream?.disconnect();
    // Null the stream too so the next startStream() builds a fresh
    // useStream — symmetric with onBeforeUnmount and avoids relying on
    // useStream.disconnect leaving the instance reusable.
    stream = null;
  }

  /**
   * Visibility-pause (option A from Phase 4 notes): tear the TCP connection
   * down on hidden, re-open + re-hydrate on visible. Keeps idle tabs off
   * the SSE fleet and guarantees freshness on return (missed events during
   * the invisible window are reconciled by `hydrate()` at resume).
   */
  function handleVisibility(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      stopStream();
    } else {
      startStream();
      void hydrate();
    }
  }

  onMounted(() => {
    startStream();
    void hydrate();
    if (typeof document !== "undefined") {
      visibilityHandler = handleVisibility;
      document.addEventListener("visibilitychange", visibilityHandler);
    }
  });

  onBeforeUnmount(() => {
    stopStream();
    if (visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
  });

  /**
   * Optimistic flip: update local state first, then PATCH. On 4xx/5xx we
   * roll the override back and surface the error. A 401 falls through to
   * `fetchWithAuth`'s `auth:expired` event, which App.vue handles by
   * kicking the user back to Login. Server publishes `agent:updated`
   * after a successful write; the stream handler reconciles any drift.
   */
  async function toggle(
    repo: string,
    feature: Feature,
    enabled: boolean | null,
  ): Promise<void> {
    const index = agents.value.findIndex((a) => a.name === repo);
    if (index === -1) {
      error.value = `Unknown repo: ${repo}`;
      return;
    }
    const snapshot = agents.value[index];
    const previous = snapshot.settings.overrides[feature].enabled;

    agents.value = [
      ...agents.value.slice(0, index),
      {
        ...snapshot,
        settings: {
          ...snapshot.settings,
          overrides: {
            ...snapshot.settings.overrides,
            [feature]: { enabled },
          },
        },
      },
      ...agents.value.slice(index + 1),
    ];

    try {
      const refreshed = await patchToggle(repo, feature, enabled);
      const nextIndex = agents.value.findIndex((a) => a.name === repo);
      if (nextIndex !== -1) {
        agents.value = [
          ...agents.value.slice(0, nextIndex),
          refreshed,
          ...agents.value.slice(nextIndex + 1),
        ];
      }
      error.value = null;
    } catch (err) {
      const te = err as ToggleError;
      rollback(repo, index, previous, feature);
      error.value = te?.serverMessage ?? te?.message ?? "Toggle failed.";
    }
  }

  function rollback(
    repo: string,
    indexHint: number,
    previous: boolean | null,
    feature: Feature,
  ): void {
    const idx =
      agents.value[indexHint]?.name === repo
        ? indexHint
        : agents.value.findIndex((a) => a.name === repo);
    if (idx === -1) return;
    const snap = agents.value[idx];
    agents.value = [
      ...agents.value.slice(0, idx),
      {
        ...snap,
        settings: {
          ...snap.settings,
          overrides: {
            ...snap.settings.overrides,
            [feature]: { enabled: previous },
          },
        },
      },
      ...agents.value.slice(idx + 1),
    ];
  }

  /**
   * Clear the per-repo critical-failure flag via the dashboard's DELETE
   * proxy. The DELETE response body is `{cleared: boolean}` — it does
   * not carry the refreshed snapshot, so we re-fetch the repo's agent
   * snapshot afterward to swap in the fresh state (banner should then
   * disappear because `criticalFailure` flips to null). On failure the
   * banner stays visible and the top-of-page error surfaces the reason.
   */
  async function clearCriticalFailure(repo: string): Promise<void> {
    try {
      await clearCriticalFailureApi(repo);
      const refreshed = await fetchAgent(repo);
      const idx = agents.value.findIndex((a) => a.name === repo);
      if (idx !== -1) {
        agents.value = [
          ...agents.value.slice(0, idx),
          refreshed,
          ...agents.value.slice(idx + 1),
        ];
      }
      error.value = null;
    } catch (err) {
      const te = err as ToggleError;
      error.value =
        te?.serverMessage ?? te?.message ?? "Clear critical failure failed.";
    }
  }

  return { agents, loading, error, toggle, clearCriticalFailure, refresh: hydrate };
}
