import { startSlackListener } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";

async function main(): Promise<void> {
  console.log("Starting Flytebot...");

  // Start periodic thread file cleanup
  startThreadCleanup();

  // Start the monitoring dashboard
  await startDashboard();

  // Start Slack Socket Mode listener
  await startSlackListener();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
