import type {
  Dispatch,
  DispatchDetail,
  DispatchFilters,
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
