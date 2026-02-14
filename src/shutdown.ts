import { stopSlackListener, getInFlightPlaceholders } from "./slack/listener.js";
import { stopThreadCleanup } from "./threads.js";
import { persistToDisk } from "./dashboard/events.js";
import { closePool } from "./db/connection.js";
import { createLogger } from "./logger.js";
import type { WebClient } from "@slack/web-api";

const log = createLogger("shutdown");

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

interface ShutdownOptions {
  exitProcess?: boolean;
  threadCleanupInterval?: NodeJS.Timeout;
  slackClient?: WebClient;
}

export async function shutdown(options: ShutdownOptions = {}): Promise<void> {
  const { exitProcess = true, threadCleanupInterval, slackClient } = options;

  log.info("Shutdown signal received, stopping new message processing...");

  // Stop accepting new messages
  stopSlackListener();

  // Get in-flight placeholders and update them with restart message
  const placeholders = getInFlightPlaceholders();
  if (placeholders.length > 0 && slackClient) {
    log.info(`Updating ${placeholders.length} in-flight placeholder(s)...`);

    // Update all placeholders
    const results = await Promise.allSettled(
      placeholders.map((ph) =>
        slackClient.chat.update({
          channel: ph.channel,
          ts: ph.ts,
          text: "Bot is restarting, I'll respond when I'm back.",
          attachments: [],
        }),
      ),
    );

    // Log any errors
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        log.error(`Failed to update placeholder ${placeholders[idx].ts}`, result.reason);
      }
    });
  }

  // Wait up to 30 seconds for in-flight agents to complete
  log.info("Waiting for in-flight agents to complete (max 30s)...");
  const startTime = Date.now();
  while (getInFlightPlaceholders().length > 0) {
    if (Date.now() - startTime > SHUTDOWN_TIMEOUT_MS) {
      log.warn("Shutdown timeout reached, forcing shutdown...");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Stop thread cleanup interval
  if (threadCleanupInterval) {
    stopThreadCleanup(threadCleanupInterval);
  }

  // Persist events to disk
  log.info("Persisting events to disk...");
  await persistToDisk();

  // Close database connection pool
  await closePool();

  log.info("Shutdown complete");

  if (exitProcess) {
    process.exit(0);
  }
}

export function initShutdownHandlers(options: {
  threadCleanupInterval: NodeJS.Timeout;
  slackClient?: WebClient;
}): void {
  const handleShutdown = () => {
    shutdown({
      exitProcess: true,
      threadCleanupInterval: options.threadCleanupInterval,
      slackClient: options.slackClient,
    }).catch((error) => {
      log.error("Error during shutdown", error);
      process.exit(1);
    });
  };

  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);
}
