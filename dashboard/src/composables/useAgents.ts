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
const TOKEN_STORAGE_KEY = "danxbot.dispatchToken";

export interface UseAgents {
  agents: Ref<AgentSnapshot[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  toggle: (repo: string, feature: Feature, enabled: boolean | null) => Promise<void>;
  refresh: () => Promise<void>;
}

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    /* ignore — SSR / sandboxed */
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Prompt the operator for the dispatch bearer token. Returns null if they
 * cancel. In test environments `prompt` may be missing — callers can mock
 * this by overriding `globalThis.prompt`.
 */
function promptForToken(currentMessage?: string): string | null {
  if (typeof globalThis.prompt !== "function") return null;
  const msg =
    currentMessage ??
    "Enter the DANXBOT_DISPATCH_TOKEN to modify agent toggles:";
  const value = globalThis.prompt(msg);
  return value && value.trim() ? value.trim() : null;
}

/**
 * Build the Agents tab state: periodic refresh (visibility-paused),
 * optimistic toggles with rollback on failure, and a session-stored
 * bearer token that re-prompts on 401.
 *
 * This composable is constructed inside component setup so `onMounted` /
 * `onBeforeUnmount` tear the refresh timer down cleanly across HMR and
 * tab switches. Leaking the interval would cause the dashboard to fire
 * background requests forever.
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
      // Resume: kick a refresh immediately so the UI is fresh when the
      // user returns, then resume the interval.
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

  async function performPatch(
    repo: string,
    feature: Feature,
    enabled: boolean | null,
    token: string,
  ): Promise<AgentSnapshot> {
    return patchToggle(repo, feature, enabled, token);
  }

  /**
   * Optimistic flip: update local state first, then PATCH. On 4xx/5xx we
   * roll the override back and surface the error. 401 clears the cached
   * token and re-prompts on the next attempt.
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

    // Optimistic local update — replace the entry with a shallow clone
    // that mutates only the one override so Vue's reactivity picks it up.
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

    let token = readToken();
    if (!token) {
      const prompted = promptForToken();
      if (!prompted) {
        rollback(repo, index, previous, feature);
        error.value = "Toggle cancelled — no token provided.";
        return;
      }
      token = prompted;
      writeToken(token);
    }

    try {
      const refreshed = await performPatch(repo, feature, enabled, token);
      // Commit: replace with the server's authoritative response so
      // counts / worker / meta all refresh without a second fetch.
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
      if (te?.status === 401) {
        clearToken();
        // Retry once with a fresh prompt — mirrors the "wrong token"
        // path the spec describes without requiring a second click.
        const reprompt = promptForToken(
          "Token was rejected. Re-enter DANXBOT_DISPATCH_TOKEN:",
        );
        if (reprompt) {
          writeToken(reprompt);
          try {
            const refreshed = await performPatch(repo, feature, enabled, reprompt);
            const nextIndex = agents.value.findIndex((a) => a.name === repo);
            if (nextIndex !== -1) {
              agents.value = [
                ...agents.value.slice(0, nextIndex),
                refreshed,
                ...agents.value.slice(nextIndex + 1),
              ];
            }
            error.value = null;
            return;
          } catch (retryErr) {
            const re = retryErr as ToggleError;
            rollback(repo, index, previous, feature);
            error.value = re?.serverMessage ?? re?.message ?? "Toggle failed.";
            if (re?.status === 401) clearToken();
            return;
          }
        }
      }
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
