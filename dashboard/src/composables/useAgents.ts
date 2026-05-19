import type { Ref } from "vue";
import {
  clearCriticalFailure as clearCriticalFailureApi,
  fetchAgent,
  fetchAgents,
  patchToggle,
  putIssuePrefix,
  type ToggleError,
} from "../api";
import type { StreamEvent } from "./useStream";
import { createStreamCache } from "./streamCache";
import type { AgentSnapshot, Feature } from "../types";

export interface UseAgents {
  agents: Ref<AgentSnapshot[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  toggle: (repo: string, feature: Feature, enabled: boolean | null) => Promise<void>;
  clearCriticalFailure: (repo: string) => Promise<void>;
  saveIssuePrefix: (repo: string, prefix: string) => Promise<void>;
  refresh: () => Promise<void>;
  init: () => void;
  destroy: () => void;
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

// Module-singleton (DX-687, re-implemented over DX-689 factory). N callers
// share ONE fetch, ONE SSE subscription, ONE reducer. App.vue owns the
// lifecycle via init() / destroy().
const cache = createStreamCache<AgentSnapshot[]>({
  topic: "agent:updated",
  initialState: () => [],
  fetchFn: () => fetchAgents(),
  applyOne,
});

/** Replace one row in agents.value by name; no-op when the row is gone. */
function replaceAgentByName(
  repo: string,
  replacement: AgentSnapshot,
): void {
  const idx = cache.state.value.findIndex((a) => a.name === repo);
  if (idx === -1) return;
  cache.state.value = [
    ...cache.state.value.slice(0, idx),
    replacement,
    ...cache.state.value.slice(idx + 1),
  ];
}

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
  const index = cache.state.value.findIndex((a) => a.name === repo);
  if (index === -1) {
    cache.error.value = `Unknown repo: ${repo}`;
    return;
  }
  const snapshot = cache.state.value[index];
  const previous = snapshot.settings.overrides[feature].enabled;

  cache.state.value = [
    ...cache.state.value.slice(0, index),
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
    ...cache.state.value.slice(index + 1),
  ];

  try {
    const refreshed = await patchToggle(repo, feature, enabled);
    replaceAgentByName(repo, refreshed);
    cache.error.value = null;
  } catch (err) {
    const te = err as ToggleError;
    rollback(repo, index, previous, feature);
    cache.error.value = te?.serverMessage ?? te?.message ?? "Toggle failed.";
  }
}

function rollback(
  repo: string,
  indexHint: number,
  previous: boolean | null,
  feature: Feature,
): void {
  const idx =
    cache.state.value[indexHint]?.name === repo
      ? indexHint
      : cache.state.value.findIndex((a) => a.name === repo);
  if (idx === -1) return;
  const snap = cache.state.value[idx];
  cache.state.value = [
    ...cache.state.value.slice(0, idx),
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
    ...cache.state.value.slice(idx + 1),
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
    replaceAgentByName(repo, refreshed);
    cache.error.value = null;
  } catch (err) {
    const te = err as ToggleError;
    cache.error.value =
      te?.serverMessage ?? te?.message ?? "Clear critical failure failed.";
  }
}

/**
 * DX-103: PUT a repo's `issue_prefix` and refresh that repo's
 * snapshot so the input + Issues tab pick up the new value. The
 * `issue-prefix:changed` SSE event also broadcasts to other clients
 * — `useStream` already routes that into `agent:updated` if the
 * backend re-emits a snapshot; on this client we re-fetch directly
 * to keep the round-trip deterministic.
 */
async function saveIssuePrefix(repo: string, prefix: string): Promise<void> {
  try {
    await putIssuePrefix(repo, prefix);
    const refreshed = await fetchAgent(repo);
    replaceAgentByName(repo, refreshed);
    cache.error.value = null;
  } catch (err) {
    const te = err as ToggleError;
    cache.error.value =
      te?.serverMessage ?? te?.message ?? "Save issue prefix failed.";
  }
}

/**
 * Build the Agents tab state. Module-scoped singleton (DX-687, factored
 * over the DX-689 `createStreamCache` factory) — N callers share ONE
 * fetch, ONE SSE subscription, ONE reducer. Lifecycle is owned by
 * App.vue's `init()` / `destroy()` calls in `loadDashboard` /
 * `onAuthExpired` / `onUnmounted`.
 *
 * ### Wire contract
 *
 * Backend emits exactly ONE agent topic: `agent:updated`, carrying a
 * full `AgentSnapshot` as the payload. Producer:
 * `src/dashboard/agents-toggles.ts` `handlePatchToggle` publishes after
 * a successful settings write. The `DELETE /critical-failure` route does
 * NOT publish — `clearCriticalFailure` re-fetches the single repo via
 * `fetchAgent` afterward.
 */
export function useAgents(): UseAgents {
  return {
    agents: cache.state,
    loading: cache.loading,
    error: cache.error,
    toggle,
    clearCriticalFailure,
    saveIssuePrefix,
    refresh: cache.hydrate,
    init: cache.init,
    destroy: cache.destroy,
  };
}
