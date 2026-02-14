import type { WebClient } from "@slack/web-api";
import { createLogger } from "./logger.js";
import {
  loadThreadFromDb,
  saveThreadToDb,
  deleteOldThreadsFromDb,
  isBotInThread,
} from "./db/threads-db.js";
import type { ThreadState, ThreadMessage } from "./types.js";

const log = createLogger("threads");

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_THREAD_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    log.error(`Failed to hydrate thread ${threadTs} from Slack`, error);
  }

  return thread;
}

/**
 * Trims thread messages to prevent token overflow.
 * Preserves the first message (original question) and the most recent messages.
 */
export function trimThreadMessages(
  messages: ThreadMessage[],
  limit: number,
): ThreadMessage[] {
  if (messages.length <= limit) return messages;
  if (limit <= 1) return messages.length > 0 ? [messages[0]] : [];
  return [messages[0], ...messages.slice(-(limit - 1))];
}

/**
 * Gets or creates a thread state. Hydrates from Slack if not in DB.
 */
export async function getOrCreateThread(
  threadTs: string,
  channelId: string,
  client: WebClient,
): Promise<ThreadState> {
  const existing = await loadThreadFromDb(threadTs);
  if (existing) return existing;

  const thread = await hydrateFromSlack(threadTs, channelId, client);
  await saveThreadToDb(thread);
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
  saveThreadToDb(thread);
}

/**
 * Updates the session ID for a thread and persists it.
 */
export function updateSessionId(
  thread: ThreadState,
  sessionId: string,
): void {
  thread.sessionId = sessionId;
  saveThreadToDb(thread);
}

/**
 * Clears the session ID for a thread (sets to null) and persists it.
 * Used when a session has expired or been deleted, so the next agent
 * run starts a fresh conversation instead of trying to resume.
 */
export function clearSessionId(thread: ThreadState): void {
  thread.sessionId = null;
  saveThreadToDb(thread);
}

/**
 * Checks if the bot has previously responded in a thread.
 */
export async function isBotParticipant(threadTs: string): Promise<boolean> {
  const result = await isBotInThread(threadTs);
  // null means thread not found — treat as false
  return result === true;
}

/**
 * Deletes threads older than 7 days from the database.
 */
export async function cleanupOldThreads(): Promise<void> {
  try {
    const deleted = await deleteOldThreadsFromDb(MAX_THREAD_AGE_MS);
    if (deleted > 0) {
      log.info(`Cleaned up ${deleted} old thread(s) from DB`);
    }
  } catch (error) {
    log.error("Thread cleanup error", error);
  }
}

/**
 * Starts the periodic thread cleanup.
 * Returns the interval reference for shutdown cleanup.
 */
export function startThreadCleanup(): NodeJS.Timeout {
  const interval = setInterval(cleanupOldThreads, CLEANUP_INTERVAL_MS);
  // Run once on startup
  cleanupOldThreads();
  return interval;
}

/**
 * Stops the periodic thread cleanup.
 */
export function stopThreadCleanup(interval: NodeJS.Timeout): void {
  clearInterval(interval);
}
