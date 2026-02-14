import { spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { createLogger } from "../logger.js";
import { fetchTodoCards } from "./trello-client.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockFile = resolve(projectRoot, ".poller-running");

const log = createLogger("poller");

let teamRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let lockCheckId: ReturnType<typeof setInterval> | null = null;

export async function poll(): Promise<void> {
  if (teamRunning) {
    return;
  }

  log.info("Checking ToDo list...");

  let cards;
  try {
    cards = await fetchTodoCards();
  } catch (error) {
    log.error("Error fetching cards", error);
    return;
  }

  if (cards.length === 0) {
    log.info("No cards in ToDo — waiting");
    return;
  }

  log.info(`Found ${cards.length} card${cards.length > 1 ? "s" : ""} — starting team`);
  cards.forEach((card, i) => log.info(`  ${i + 1}. ${card.name}`));

  teamRunning = true;
  log.info("Spawning Claude in new terminal tab...");

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE")) {
      delete env[key];
    }
  }

  // Lock file signals that the team is running. The script removes it via EXIT trap.
  writeFileSync(lockFile, String(process.pid));

  const script = resolve(dirname(fileURLToPath(import.meta.url)), "run-team.sh");

  // wt.exe returns immediately — the Claude process runs in the new tab.
  spawn("wt.exe", ["-w", "0", "new-tab", "--title", "Flytebot Team", "wsl.exe", "-e", "bash", script], {
    cwd: projectRoot,
    stdio: "ignore",
    env,
    detached: true,
  }).unref();

  // Watch for lock file removal to detect completion.
  lockCheckId = setInterval(() => {
    if (!existsSync(lockFile)) {
      clearInterval(lockCheckId!);
      lockCheckId = null;
      log.info("Team finished — resuming polling");
      teamRunning = false;
    }
  }, 5000);
}

export function shutdown(): void {
  log.info("Shutting down...");

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  if (lockCheckId) {
    clearInterval(lockCheckId);
    lockCheckId = null;
  }

  // Clean up lock file if it still exists
  try {
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch { /* ignore */ }

  process.exit(0);
}

export function start(): void {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const intervalSeconds = config.pollerIntervalMs / 1000;
  log.info(`Started — polling every ${intervalSeconds}s`);

  poll();
  intervalId = setInterval(poll, config.pollerIntervalMs);
}

/** Reset module state for testing. Do not use in production. */
export function _resetForTesting(): void {
  teamRunning = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (lockCheckId) {
    clearInterval(lockCheckId);
    lockCheckId = null;
  }
}

// Auto-start when run as the direct entrypoint.
// First condition: standard Node.js ESM check.
// Second condition: tsx rewrites import.meta.url, so fall back to argv path match.
const isDirectEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/poller/index.ts");

if (isDirectEntrypoint) {
  start();
}
