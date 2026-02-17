import { spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config, TODO_LIST_ID } from "./config.js";
import { createLogger } from "../logger.js";
import { fetchTodoCards, fetchNeedsHelpCards, fetchLatestComment, moveCardToList, isUserResponse } from "./trello-client.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockFile = resolve(projectRoot, ".poller-running");

const log = createLogger("poller");

let teamRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let lockCheckId: ReturnType<typeof setInterval> | null = null;

/**
 * Check Needs Help cards for user responses. Cards where a user has replied
 * (latest comment lacks the flytebot marker) are moved to the top of ToDo
 * so they get higher priority than existing ToDo cards.
 */
async function checkNeedsHelp(): Promise<number> {
  let cards;
  try {
    cards = await fetchNeedsHelpCards();
  } catch (error) {
    log.error("Error fetching Needs Help cards", error);
    return 0;
  }

  if (cards.length === 0) return 0;

  let movedCount = 0;
  for (const card of cards) {
    try {
      const latestComment = await fetchLatestComment(card.id);
      if (isUserResponse(latestComment)) {
        log.info(`User responded on "${card.name}" — moving to ToDo`);
        await moveCardToList(card.id, TODO_LIST_ID, "top");
        movedCount++;
      }
    } catch (error) {
      log.error(`Error checking comments for card "${card.name}"`, error);
    }
  }

  return movedCount;
}

export async function poll(): Promise<void> {
  if (teamRunning) {
    return;
  }

  log.info("Checking Needs Help + ToDo lists...");

  // Check Needs Help first — user-responded cards get moved to ToDo top
  const movedFromNeedsHelp = await checkNeedsHelp();
  if (movedFromNeedsHelp > 0) {
    log.info(`Moved ${movedFromNeedsHelp} card${movedFromNeedsHelp > 1 ? "s" : ""} from Needs Help to ToDo`);
  }

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

  // Safety net: refuse to spawn if lock file already exists (race condition guard)
  if (existsSync(lockFile)) {
    log.error("Lock file exists but teamRunning was false — refusing to spawn");
    return;
  }

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
  startLockWatch();
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

  // Only remove lock file if no team is running — run-team.sh handles cleanup otherwise
  if (teamRunning) {
    log.info("Team is running — leaving lock file for run-team.sh to clean up");
  } else {
    try {
      if (existsSync(lockFile)) unlinkSync(lockFile);
    } catch (e) { log.warn("Failed to remove lock file", e); }
  }

  process.exit(0);
}

function startLockWatch(): void {
  lockCheckId = setInterval(() => {
    if (!existsSync(lockFile)) {
      clearInterval(lockCheckId!);
      lockCheckId = null;
      log.info("Team finished — resuming polling");
      teamRunning = false;
    }
  }, 5000);
}

export function start(): void {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const intervalSeconds = config.pollerIntervalMs / 1000;
  log.info(`Started — polling every ${intervalSeconds}s`);

  // Remove stale lock file from a previous run that shut down uncleanly.
  // Only one poller instance runs at a time, so a leftover lock is always stale.
  if (existsSync(lockFile)) {
    log.warn("Stale lock file found — removing");
    unlinkSync(lockFile);
  }

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
