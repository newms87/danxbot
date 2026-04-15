import { getEvents } from "./events.js";
import { checkDbConnection } from "../db/health.js";

export interface HealthStatus {
  status: "ok" | "degraded";
  uptime_seconds: number;
  db_connected: boolean;
  events_count: number;
  memory_usage_mb: number;
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const dbConnected = await checkDbConnection();

  return {
    status: dbConnected ? "ok" : "degraded",
    uptime_seconds: Math.round(process.uptime()),
    db_connected: dbConnected,
    events_count: getEvents().length,
    memory_usage_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
  };
}
