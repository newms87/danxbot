import { isSlackConnected, getQueueStats, getTotalQueuedCount } from "../slack/listener.js";
import { checkDbConnection } from "../db/health.js";
import type { RepoContext } from "../types.js";

export async function getHealthStatus(repo: RepoContext) {
  const slackConnected = isSlackConnected();
  const dbConnected = await checkDbConnection();

  const slackExpected = repo.slack.enabled;
  const allHealthy = dbConnected && (!slackExpected || slackConnected);

  return {
    status: allHealthy ? "ok" : "degraded",
    repo: repo.name,
    uptime_seconds: Math.round(process.uptime()),
    slack_connected: slackConnected,
    slack_expected: slackExpected,
    db_connected: dbConnected,
    memory_usage_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    queued_messages: getTotalQueuedCount(),
    queue_by_thread: getQueueStats(),
  };
}
