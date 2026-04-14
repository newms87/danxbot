import { getEvents } from "./events.js";
import { isSlackConnected, getQueueStats, getTotalQueuedCount } from "../slack/listener.js";
import { getPool } from "../db/connection.js";

export interface HealthStatus {
  status: "ok" | "degraded";
  uptime_seconds: number;
  slack_connected: boolean;
  db_connected: boolean;
  events_count: number;
  memory_usage_mb: number;
  queued_messages: number;
  queue_by_thread: Record<string, number>;
}

const DB_PING_TIMEOUT_MS = 2000;

export async function getHealthStatus(): Promise<HealthStatus> {
  const slackConnected = isSlackConnected();

  let dbConnected = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const pool = getPool();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("DB ping timeout")), DB_PING_TIMEOUT_MS);
    });
    await Promise.race([pool.query("SELECT 1"), timeoutPromise]);
    dbConnected = true;
  } catch {
    // DB unreachable or timed out
  } finally {
    if (timer) clearTimeout(timer);
  }

  const allHealthy = slackConnected && dbConnected;

  return {
    status: allHealthy ? "ok" : "degraded",
    uptime_seconds: Math.round(process.uptime()),
    slack_connected: slackConnected,
    db_connected: dbConnected,
    events_count: getEvents().length,
    memory_usage_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    queued_messages: getTotalQueuedCount(),
    queue_by_thread: getQueueStats(),
  };
}
