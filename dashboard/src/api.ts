import type { MessageEvent, AnalyticsSummary } from "./types";

export async function fetchEvents(): Promise<MessageEvent[]> {
  const res = await fetch("/api/events");
  return res.json();
}

export async function fetchAnalytics(): Promise<AnalyticsSummary> {
  const res = await fetch("/api/analytics");
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
