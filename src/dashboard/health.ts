import { getEvents } from "./events.js";
import { isSlackConnected } from "../slack/listener.js";

export interface HealthStatus {
  status: "ok" | "degraded";
  uptime_seconds: number;
  slack_connected: boolean;
  events_count: number;
  memory_usage_mb: number;
}

export function getHealthStatus(): HealthStatus {
  const connected = isSlackConnected();

  return {
    status: connected ? "ok" : "degraded",
    uptime_seconds: Math.round(process.uptime()),
    slack_connected: connected,
    events_count: getEvents().length,
    memory_usage_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
  };
}
