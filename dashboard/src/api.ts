import type { MessageEvent, AnalyticsSummary } from "./types";

export interface RepoInfo {
  name: string;
  url: string;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const res = await fetch("/api/repos");
  return res.json();
}

export async function fetchEvents(repo?: string): Promise<MessageEvent[]> {
  const params = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  const res = await fetch(`/api/events${params}`);
  return res.json();
}

export async function fetchAnalytics(repo?: string): Promise<AnalyticsSummary> {
  const params = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  const res = await fetch(`/api/analytics${params}`);
  return res.json();
}

export function connectSSE(
  onEvent: (event: MessageEvent) => void,
  onConnect: () => void,
  onDisconnect: () => void,
): () => void {
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function connect() {
    if (stopped) return;
    eventSource = new EventSource("/api/stream");
    eventSource.onopen = () => onConnect();
    eventSource.onerror = () => {
      onDisconnect();
      eventSource?.close();
      reconnectTimer = setTimeout(connect, 3000);
    };
    eventSource.onmessage = (e) => {
      onEvent(JSON.parse(e.data));
    };
  }

  connect();

  return () => {
    stopped = true;
    eventSource?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}
