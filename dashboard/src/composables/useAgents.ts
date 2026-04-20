import { ref, onMounted, onBeforeUnmount } from "vue";
import type { Ref } from "vue";
import { fetchAgents, patchToggle, type ToggleError } from "../api";
import type { AgentSnapshot, Feature } from "../types";

/**
 * 10s refresh cadence while the tab is visible — long enough to avoid
 * hammering the backend, short enough that worker-down pills turn red
 * soon after the worker stops responding.
 */
const REFRESH_INTERVAL_MS = 10_000;

export interface UseAgents {
  agents: Ref<AgentSnapshot[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  toggle: (repo: string, feature: Feature, enabled: boolean | null) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Build the Agents tab state: periodic refresh (visibility-paused) and
 * optimistic toggles with rollback on failure. Auth flows through
 * `fetchWithAuth`, so the user's bearer is attached automatically — no
 * per-toggle token prompt needed.
 */
export function useAgents(): UseAgents {
  const agents = ref<AgentSnapshot[]>([]);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let visibilityHandler: (() => void) | null = null;

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      agents.value = await fetchAgents();
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function startTimer(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (
        typeof document === "undefined" ||
        document.visibilityState !== "hidden"
      ) {
        refresh().catch(() => {});
      }
    }, REFRESH_INTERVAL_MS);
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function handleVisibility(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      stopTimer();
    } else {
      refresh().catch(() => {});
      startTimer();
    }
  }

  onMounted(() => {
    refresh();
    startTimer();
    if (typeof document !== "undefined") {
      visibilityHandler = handleVisibility;
      document.addEventListener("visibilitychange", visibilityHandler);
    }
  });

  onBeforeUnmount(() => {
    stopTimer();
    if (visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
  });

  /**
   * Optimistic flip: update local state first, then PATCH. On 4xx/5xx we
   * roll the override back and surface the error. A 401 falls through to
   * `fetchWithAuth`'s `auth:expired` event, which App.vue handles by
   * kicking the user back to Login.
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

  return { agents, loading, error, toggle, refresh };
}
