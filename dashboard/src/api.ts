import { watch } from "vue";
import type {
  AgentSnapshot,
  Dispatch,
  DispatchDetail,
  DispatchFilters,
  Feature,
  JsonlBlock,
} from "./types";
import { useAuth } from "./composables/useAuth";
import { useStream } from "./composables/useStream";

export interface RepoInfo {
  name: string;
  url: string;
}

const AUTH_EXPIRED_EVENT = "auth:expired";

function emitAuthExpired(): void {
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

/**
 * Inject the current user's bearer token on every dashboard API call.
 *
 * Contract: any 401 response dispatches the `auth:expired` window event
 * and returns the Response unchanged. App.vue listens for this and clears
 * local auth state, forcing a re-render to Login. The current auth model
 * is binary — authed or not — so 401 is the only failure mode. If
 * role-based authorization lands later, 403 will be the "authed but not
 * permitted" path and this function will need to distinguish; until
 * that requirement exists, keeping both collapsed to 401-only removes
 * a speculative branch.
 */
export async function fetchWithAuth(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const { token } = useAuth();
  const headers = new Headers(init.headers ?? {});
  if (token.value) headers.set("Authorization", `Bearer ${token.value}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) emitAuthExpired();
  return res;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const res = await fetchWithAuth("/api/repos");
  return res.json();
}

function filtersToQuery(filters: DispatchFilters): string {
  const params = new URLSearchParams();
  if (filters.trigger) params.set("trigger", filters.trigger);
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.status) params.set("status", filters.status);
  if (filters.since !== undefined) params.set("since", String(filters.since));
  if (filters.q) params.set("q", filters.q);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function fetchDispatches(
  filters: DispatchFilters = {},
): Promise<Dispatch[]> {
  const res = await fetchWithAuth(`/api/dispatches${filtersToQuery(filters)}`);
  return res.json();
}

export async function fetchDispatchDetail(id: string): Promise<DispatchDetail> {
  const res = await fetchWithAuth(
    `/api/dispatches/${encodeURIComponent(id)}`,
  );
  return res.json();
}

/**
 * Fetch the per-repo agent snapshot list rendered on the Agents tab.
 * Each entry combines settings, dispatch counts, and worker reachability
 * — see `src/dashboard/agents-routes.ts` for the response shape.
 */
export async function fetchAgents(): Promise<AgentSnapshot[]> {
  const res = await fetchWithAuth("/api/agents");
  if (!res.ok) throw new Error(`fetchAgents failed: ${res.status}`);
  return res.json();
}

export async function fetchAgent(repo: string): Promise<AgentSnapshot> {
  const res = await fetchWithAuth(`/api/agents/${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`fetchAgent failed: ${res.status}`);
  return res.json();
}

export interface ClearCriticalFailureResult {
  cleared: boolean;
}

/**
 * Clear the per-repo critical-failure flag. Delegates via the dashboard's
 * DELETE /api/agents/:repo/critical-failure proxy to the worker's
 * DELETE /api/poller/critical-failure. Idempotent: returns
 * `{cleared:true}` if the flag existed and was removed, `{cleared:false}`
 * if it was already absent. Caller should re-fetch the snapshot (via
 * `fetchAgent`) after a successful clear so the banner disappears.
 *
 * Auth: per-user bearer (NOT the dispatch token). Surfaces errors with
 * the same shape as `patchToggle` so the page can render them the same
 * way.
 */
export async function clearCriticalFailure(
  repo: string,
): Promise<ClearCriticalFailureResult> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/critical-failure`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw toggleError(res.status, message);
  }
  return res.json();
}

export interface ToggleError extends Error {
  status: number;
  serverMessage?: string;
}

function toggleError(status: number, serverMessage?: string): ToggleError {
  const err = new Error(
    serverMessage || `patchToggle failed: ${status}`,
  ) as ToggleError;
  err.status = status;
  err.serverMessage = serverMessage;
  return err;
}

/**
 * Toggle a feature on/off for a repo. `enabled` may be null to reset back
 * to the env default. Responds with the refreshed snapshot so the caller
 * can commit the optimistic update without a re-fetch. Auth flows through
 * `fetchWithAuth` — the PATCH route requires a user bearer token. A 401
 * fires the `auth:expired` event which App.vue handles by redirecting to
 * Login (see Phase 4 auth contract).
 */
export async function patchToggle(
  repo: string,
  feature: Feature,
  enabled: boolean | null,
): Promise<AgentSnapshot> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/toggles`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature, enabled }),
    },
  );
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw toggleError(res.status, message);
  }
  return res.json();
}

/**
 * Live-follow a dispatch via the multiplexed SSE stream. Subscribes to the
 * `dispatch:jsonl:<id>` topic and invokes `onBlock` once per parsed
 * `JsonlBlock` in each batch the backend publishes.
 *
 * Each call spawns its own `useStream()` instance — `disconnect()` on
 * teardown affects only this follow, not any sibling composable (useAgents,
 * useDispatches) that also talks to `/api/stream`.
 *
 * `onError` is invoked at most once, on the first transition from
 * `connecting`/`connected` back to `disconnected`. `useStream` will then
 * reconnect on its own with exponential backoff — this mirrors the original
 * "called once when stream terminates" contract from the pre-Phase-6
 * dedicated follow-route implementation so the existing `DispatchDetail.vue`
 * caller (which passes a no-op `onError`) stays unchanged.
 */
export function followDispatch(
  id: string,
  onBlock: (block: JsonlBlock) => void,
  onError: () => void,
): () => void {
  const stream = useStream();
  let errored = false;

  const unsub = stream.subscribe(`dispatch:jsonl:${id}`, (event) => {
    if (!Array.isArray(event.data)) {
      console.warn(
        `followDispatch(${id}): expected JsonlBlock[] payload, got`,
        event.data,
      );
      return;
    }
    for (const block of event.data as JsonlBlock[]) onBlock(block);
  });

  const stopWatch = watch(stream.connectionState, (state, prev) => {
    if (
      !errored &&
      state === "disconnected" &&
      (prev === "connecting" || prev === "connected")
    ) {
      errored = true;
      onError();
    }
  });

  return () => {
    stopWatch();
    unsub();
    stream.disconnect();
  };
}
