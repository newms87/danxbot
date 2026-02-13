import { readFile, writeFile, readdir, unlink, mkdir } from "fs/promises";
import { join } from "path";
import type { WebClient } from "@slack/web-api";
import { config } from "./config.js";
import type { ThreadState, ThreadMessage } from "./types.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_THREAD_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function threadPath(threadTs: string): string {
  return join(config.threadsDir, `${threadTs}.json`);
}

async function ensureThreadsDir(): Promise<void> {
  await mkdir(config.threadsDir, { recursive: true });
}

/**
 * Loads a thread from disk, or returns null if it doesn't exist.
 */
async function loadThread(threadTs: string): Promise<ThreadState | null> {
  try {
    const data = await readFile(threadPath(threadTs), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Saves a thread to disk.
 */
async function saveThread(thread: ThreadState): Promise<void> {
  await ensureThreadsDir();
  thread.updatedAt = new Date().toISOString();
  await writeFile(threadPath(thread.threadTs), JSON.stringify(thread, null, 2));
}

/**
 * Hydrates a thread from Slack's conversation history.
 */
async function hydrateFromSlack(
  threadTs: string,
  channelId: string,
  client: WebClient,
): Promise<ThreadState> {
  const thread: ThreadState = {
    threadTs,
    channelId,
    sessionId: null,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
    });

    if (result.messages) {
      thread.messages = result.messages.map((msg) => ({
        user: msg.user || msg.bot_id || "unknown",
        text: msg.text || "",
        ts: msg.ts || "",
        isBot: !!msg.bot_id,
      }));
    }
  } catch (error) {
    console.error(`Failed to hydrate thread ${threadTs} from Slack:`, error);
  }

  return thread;
}

/**
 * Gets or creates a thread state. Hydrates from Slack if the local file is missing.
 */
export async function getOrCreateThread(
  threadTs: string,
  channelId: string,
  client: WebClient,
): Promise<ThreadState> {
  const existing = await loadThread(threadTs);
  if (existing) return existing;

  const thread = await hydrateFromSlack(threadTs, channelId, client);
  await saveThread(thread);
  return thread;
}

/**
 * Adds a message to the thread state and persists it.
 */
export function addMessageToThread(
  thread: ThreadState,
  message: ThreadMessage,
): void {
  thread.messages.push(message);
  // Fire-and-forget save
  saveThread(thread).catch((err) =>
    console.error("Failed to save thread:", err),
  );
}

/**
 * Updates the session ID for a thread and persists it.
 */
export function updateSessionId(
  thread: ThreadState,
  sessionId: string,
): void {
  thread.sessionId = sessionId;
  saveThread(thread).catch((err) =>
    console.error("Failed to save thread:", err),
  );
}

/**
 * Checks if the bot has previously responded in a thread.
 */
export async function isBotParticipant(threadTs: string): Promise<boolean> {
  const thread = await loadThread(threadTs);
  if (!thread) return false;
  return thread.messages.some((msg) => msg.isBot);
}

/**
 * Deletes thread files older than 7 days.
 */
async function cleanupOldThreads(): Promise<void> {
  try {
    await ensureThreadsDir();
    const files = await readdir(config.threadsDir);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const filePath = join(config.threadsDir, file);
        const data = await readFile(filePath, "utf-8");
        const thread: ThreadState = JSON.parse(data);
        const updatedAt = new Date(thread.updatedAt).getTime();

        if (now - updatedAt > MAX_THREAD_AGE_MS) {
          await unlink(filePath);
          console.log(`Cleaned up old thread: ${file}`);
        }
      } catch {
        // Skip files that can't be parsed
      }
    }
  } catch (error) {
    console.error("Thread cleanup error:", error);
  }
}

/**
 * Starts the periodic thread cleanup.
 */
export function startThreadCleanup(): void {
  setInterval(cleanupOldThreads, CLEANUP_INTERVAL_MS);
  // Run once on startup
  cleanupOldThreads();
}
