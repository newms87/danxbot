import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { fetchTodoCards } from "./trello-client.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let teamRunning = false;
let childProcess: ChildProcess | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

function log(message: string): void {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[POLLER ${time}] ${message}`);
}

async function poll(): Promise<void> {
  if (teamRunning) {
    return;
  }

  log("Checking ToDo list...");

  let cards;
  try {
    cards = await fetchTodoCards();
  } catch (error) {
    log(`Error fetching cards: ${error instanceof Error ? error.message : error}`);
    return;
  }

  if (cards.length === 0) {
    log("No cards in ToDo — waiting");
    return;
  }

  log(`Found ${cards.length} card${cards.length > 1 ? "s" : ""} — starting team`);
  cards.forEach((card, i) => log(`  ${i + 1}. ${card.name}`));

  teamRunning = true;
  log('Spawning: claude -p "/start-team"');

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE")) {
      delete env[key];
    }
  }

  childProcess = spawn("claude", ["-p", "/start-team", "--dangerously-skip-permissions"], {
    cwd: projectRoot,
    stdio: "inherit",
    env,
  });

  childProcess.on("exit", (code) => {
    log(`Team exited (code ${code ?? "unknown"}) — resuming polling`);
    teamRunning = false;
    childProcess = null;
  });

  childProcess.on("error", (error) => {
    log(`Failed to spawn claude: ${error.message}`);
    teamRunning = false;
    childProcess = null;
  });
}

function shutdown(): void {
  log("Shutting down...");

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  if (childProcess) {
    childProcess.kill("SIGTERM");
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const intervalSeconds = config.pollerIntervalMs / 1000;
log(`Started — polling every ${intervalSeconds}s`);

poll();
intervalId = setInterval(poll, config.pollerIntervalMs);
