import type {
  AgentSnapshot,
  Dispatch,
  DispatchDetail,
  DispatchFilters,
  Feature,
  JsonlBlock,
} from "./types";

export interface RepoInfo {
  name: string;
  url: string;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const res = await fetch("/api/repos");
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
  const res = await fetch(`/api/dispatches${filtersToQuery(filters)}`);
  return res.json();
}

export async function fetchDispatchDetail(id: string): Promise<DispatchDetail> {
  const res = await fetch(`/api/dispatches/${encodeURIComponent(id)}`);
  return res.json();
}

/**
 * Fetch the per-repo agent snapshot list rendered on the Agents tab.
 * Each entry combines settings, dispatch counts, and worker reachability
 * — see `src/dashboard/agents-routes.ts` for the response shape.
 */
export async function fetchAgents(): Promise<AgentSnapshot[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error(`fetchAgents failed: ${res.status}`);
  return res.json();
}

export async function fetchAgent(repo: string): Promise<AgentSnapshot> {
  const res = await fetch(`/api/agents/${encodeURIComponent(repo)}`);
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
 * can commit the optimistic update without a re-fetch. Throws a
 * `ToggleError` carrying the HTTP status so callers can distinguish
 * 401 (re-prompt token) from 500 (server not configured).
 */
export async function patchToggle(
  repo: string,
  feature: Feature,
  enabled: boolean | null,
  token: string,
): Promise<AgentSnapshot> {
  const res = await fetch(
    `/api/agents/${encodeURIComponent(repo)}/toggles`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
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

export function followDispatch(
  id: string,
  onBlock: (block: JsonlBlock) => void,
  onError: () => void,
): () => void {
  const es = new EventSource(
    `/api/dispatches/${encodeURIComponent(id)}/follow`,
  );
  es.onmessage = (e) => {
    try {
      onBlock(JSON.parse(e.data) as JsonlBlock);
    } catch {
      // Ignore malformed lines
    }
  };
  es.onerror = onError;
  return () => es.close();
}
