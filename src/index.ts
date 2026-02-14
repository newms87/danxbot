import { startSlackListener } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";
import { loadEvents } from "./dashboard/events.js";

async function main(): Promise<void> {
  console.log("Starting Flytebot...");

  // Start periodic thread file cleanup
  startThreadCleanup();

  // Load persisted events from disk before starting the dashboard
  await loadEvents();

  // Start the monitoring dashboard
  await startDashboard();

  // Start Slack Socket Mode listener
  await startSlackListener();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
