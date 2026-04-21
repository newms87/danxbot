import type {
  AgentSnapshot,
  Dispatch,
  DispatchDetail,
  DispatchFilters,
  Feature,
  JsonlBlock,
} from "./types";
import { useAuth } from "./composables/useAuth";

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
 * Parse one `text/event-stream` buffer slice into complete events. Each
 * event ends with a blank line; within an event, `data:` lines accumulate
 * into a single payload. Returns the leftover tail that hasn't finished
 * yet so the caller can prepend it to the next chunk.
 */
export function splitEvents(buffer: string): { events: string[]; tail: string } {
  const parts = buffer.split("\n\n");
  const tail = parts.pop() ?? "";
  const events: string[] = [];
  for (const part of parts) {
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length) events.push(dataLines.join("\n"));
  }
  return { events, tail };
}

/**
 * Live-follow a dispatch. Uses `fetch` with a streaming response body so
 * we can send `Authorization: Bearer <token>` — `EventSource` can't set
 * headers, which would force the bearer into a query-string where server
 * access logs + Caddy logs would persist it.
 *
 * Callbacks: `onBlock` per parsed JSONL entry; `onError` once the stream
 * ends unexpectedly. The returned teardown aborts the in-flight fetch.
 */
export function followDispatch(
  id: string,
  onBlock: (block: JsonlBlock) => void,
  onError: () => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetchWithAuth(
        `/api/dispatches/${encodeURIComponent(id)}/follow`,
        { signal: controller.signal, headers: { Accept: "text/event-stream" } },
      );
      if (!res.ok || !res.body) {
        onError();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          onError();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const { events, tail } = splitEvents(buffer);
        buffer = tail;
        for (const evt of events) {
          try {
            onBlock(JSON.parse(evt) as JsonlBlock);
          } catch {
            // Malformed payload: skip the event, keep streaming.
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") onError();
    }
  })();

  return () => controller.abort();
}
