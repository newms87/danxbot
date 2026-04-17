import { App } from "@slack/bolt";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { markdownToSlackMrkdwn, splitMessage } from "./formatter.js";
import { swapReaction, postErrorAttachment } from "./helpers.js";
import { HeartbeatManager } from "./heartbeat-manager.js";
import { isProcessing, markProcessing, markIdle, enqueue, dequeue, getQueueStats, getTotalQueuedCount, resetQueue } from "./message-queue.js";
import { resolveUserName } from "./user-cache.js";
import { runRouter } from "../agent/router.js";
import { runAgent } from "../agent/agent.js";
import { processResponseWithAttachments, extractSqlBlocks } from "../agent/sql-executor.js";
import type { SqlAttachment } from "../agent/sql-executor.js";
import type {
  AgentLogEntry,
  AgentUsageSummary,
  RepoContext,
} from "../types.js";
import { notifyError } from "../errors/trello-notifier.js";
import { insertDispatch, updateDispatch } from "../dashboard/dispatches-db.js";
import { countToolCallsFromLog } from "../dashboard/dispatch-tracker.js";
import type {
  Dispatch,
  DispatchStatus,
  SlackTriggerMetadata,
} from "../dashboard/dispatches.js";
import { getDanxbotCommit } from "../agent/danxbot-commit.js";
import {
  getOrCreateThread,
  addMessageToThread,
  updateSessionId,
  clearSessionId,
  isBotParticipant,
} from "../threads.js";
import { isOperationalError } from "../errors/patterns.js";

const log = createLogger("slack");

// Track in-flight agent placeholders for graceful shutdown
interface InFlightPlaceholder {
  channel: string;
  ts: string;
  threadTs: string;
}

/** Per-repo listener state. Each repo with Slack gets its own independent entry. */
interface ListenerState {
  repo: RepoContext;
  app: App;
  botUserId: string | null;
  connected: boolean;
  inFlightPlaceholders: Set<string>;
  placeholderData: Map<string, InFlightPlaceholder>;
}

const listeners = new Map<string, ListenerState>();
let isShuttingDown = false;

export function isSlackConnected(): boolean {
  for (const state of listeners.values()) {
    if (state.connected) return true;
  }
  return false;
}

export function stopSlackListener(): void {
  isShuttingDown = true;
}

export function getInFlightPlaceholders(): InFlightPlaceholder[] {
  const all: InFlightPlaceholder[] = [];
  for (const state of listeners.values()) {
    all.push(...state.placeholderData.values());
  }
  return all;
}

export function getSlackClient() {
  // Return the first connected listener's client (for shutdown cleanup)
  for (const state of listeners.values()) {
    if (state.connected) return state.app.client;
  }
  return undefined;
}

/**
 * Resets shutdown state for testing. Exported for test isolation only.
 */
export function resetListenerState(): void {
  isShuttingDown = false;
  listeners.clear();
  resetQueue();
}

/**
 * Process sql:execute blocks in agent response text.
 * Returns processed text and CSV attachments for Slack file upload.
 * Falls back to raw text with no attachments if processing fails.
 */
async function processSqlInResponse(text: string): Promise<{ text: string; attachments: SqlAttachment[] }> {
  try {
    return await processResponseWithAttachments(text);
  } catch (err) {
    log.warn("SQL processing failed, using raw response", err);
    return { text, attachments: [] };
  }
}

/**
 * Upload CSV attachments to a Slack thread.
 */
async function uploadCsvAttachments(
  client: ReturnType<typeof getSlackClient>,
  channel: string,
  threadTs: string,
  attachments: SqlAttachment[],
): Promise<void> {
  if (!client || attachments.length === 0) return;

  for (const attachment of attachments) {
    try {
      await client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        filename: attachment.filename,
        content: attachment.csv,
        title: attachment.filename,
        initial_comment: "",
      });
    } catch (err) {
      log.warn(`Failed to upload CSV attachment ${attachment.filename}`, err);
    }
  }
}

export { getQueueStats, getTotalQueuedCount } from "./message-queue.js";

/**
 * Drains queued messages for a thread by re-injecting them into the handler.
 * Runs asynchronously (fire-and-forget) so the current handler can return.
 */
function drainQueue(
  ls: ListenerState,
  threadTs: string,
  client: ReturnType<typeof getSlackClient>,
): void {
  const next = dequeue(threadTs);
  if (!next || !client) return;

  const syntheticMessage = {
    user: next.userId,
    text: next.text,
    ts: next.messageTs,
    channel: next.channelId,
    thread_ts: threadTs,
    type: "message" as const,
  };

  handleMessage(ls, syntheticMessage, client).catch((err) => {
    log.error(`Error processing queued message in thread ${threadTs}`, err);
  });
}

interface SlackMessage {
  subtype?: string;
  text?: string;
  bot_id?: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  type: string;
}

interface SlackDispatchHandle {
  id: string;
  finalize: (
    status: DispatchStatus,
    details: {
      sessionId?: string | null;
      summary?: string | null;
      error?: string | null;
      usage?: AgentUsageSummary | null;
      log?: AgentLogEntry[];
    },
  ) => Promise<void>;
}

function createSlackDispatch(
  repoName: string,
  meta: SlackTriggerMetadata,
): SlackDispatchHandle {
  const id = randomUUID();
  const row: Dispatch = {
    id,
    repoName,
    trigger: "slack",
    triggerMetadata: meta,
    sessionUuid: null,
    jsonlPath: null,
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: config.isHost ? "host" : "docker",
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: getDanxbotCommit(),
  };
  insertDispatch(row).catch((err) =>
    log.error(`[${repoName}] Failed to insert slack dispatch row`, err),
  );

  return {
    id,
    finalize: async (status, details) => {
      const { toolCallCount, subagentCount } = countToolCallsFromLog(
        details.log ?? [],
      );
      const tokensIn = details.usage?.inputTokens ?? 0;
      const tokensOut = details.usage?.outputTokens ?? 0;
      const cacheRead = details.usage?.cacheReadInputTokens ?? 0;
      const cacheWrite = details.usage?.cacheCreationInputTokens ?? 0;
      try {
        await updateDispatch(id, {
          status,
          sessionUuid: details.sessionId ?? null,
          summary: details.summary ?? null,
          error: details.error ?? null,
          completedAt: Date.now(),
          tokensIn,
          tokensOut,
          cacheRead,
          cacheWrite,
          tokensTotal: tokensIn + tokensOut + cacheRead + cacheWrite,
          toolCallCount,
          subagentCount,
        });
      } catch (err) {
        log.error(`[${repoName}] Failed to finalize slack dispatch ${id}`, err);
      }
    },
  };
}

async function handleMessage(ls: ListenerState, message: SlackMessage, client: ReturnType<typeof getSlackClient>): Promise<void> {
  if (!client) return;
    // Type guard: only handle regular messages
    if (message.subtype) return;
    if (!("text" in message) || !message.text) return;
    if ("bot_id" in message && message.bot_id) return;

    // Only process messages from this repo's configured channel
    if (message.channel !== ls.repo.slack.channelId) return;

    // Reject new messages during shutdown
    if (isShuttingDown) return;

    const threadTs = message.thread_ts || message.ts;
    const isThreadReply = !!message.thread_ts;
    const userId = message.user || "unknown";
    const errorContext = { threadTs, user: userId, channelId: message.channel };

    // Resolve user display name asynchronously (fire-and-forget)
    resolveUserName(client, userId).catch(() => {});

    try {
      // For thread replies, only respond if Danxbot is already participating
      if (isThreadReply) {
        const participating = await isBotParticipant(threadTs);
        if (!participating) return;
      }

      // Get or create thread state
      const thread = await getOrCreateThread(threadTs, message.channel, client);

      // Track the incoming message
      addMessageToThread(thread, {
        user: userId,
        text: message.text,
        ts: message.ts,
        isBot: false,
      });

      // Step 1: Router decides quick response + whether agent is needed
      const routerResult = await runRouter(message.text, thread.messages);
      log.info(
        `[${ls.repo.name}] Router: needsAgent=${routerResult.needsAgent}, reason="${routerResult.reason}"`,
      );

      // Send the quick response immediately
      if (routerResult.quickResponse) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: routerResult.quickResponse,
        });

        addMessageToThread(thread, {
          user: "danxbot",
          text: routerResult.quickResponse,
          ts: Date.now().toString(),
          isBot: true,
        });
      }

      // Step 2: If the router says we need the agent, run it
      if (routerResult.needsAgent) {
        // If an agent is already running for this thread, queue the message
        if (isProcessing(threadTs)) {
          enqueue({
            threadTs,
            messageTs: message.ts,
            channelId: message.channel,
            userId,
            text: message.text,
            queuedAt: Date.now(),
          });
          await client.chat.postMessage({
            channel: message.channel,
            thread_ts: threadTs,
            text: "I'll get to this after your current question.",
          });
          return;
        }
        markProcessing(threadTs);

        // Router-only messages are not dispatches (per the epic). We only
        // create a dispatch row now that the agent is about to run.
        const slackMeta: SlackTriggerMetadata = {
          channelId: message.channel,
          threadTs,
          messageTs: message.ts,
          user: userId,
          userName: null,
          messageText: message.text,
        };
        const slackDispatch = createSlackDispatch(ls.repo.name, slackMeta);

        // Add thinking reaction while agent works
        await client.reactions
          .add({
            channel: message.channel,
            timestamp: message.ts,
            name: "brain",
          })
          .catch(() => {});

        // very_low: No heartbeat, no timeout race, no retries. Escalate to medium on failure.
        if (routerResult.complexity === "very_low") {
          try {
            const response = await runAgent(
              ls.repo,
              message.text,
              thread.sessionId,
              undefined,
              undefined,
              thread.messages,
              "very_low",
            );

            // Post placeholder, update with response
            const placeholder = await client.chat.postMessage({
              channel: message.channel,
              thread_ts: threadTs,
              text: " ",
              attachments: [
                {
                  color: "#00b894",
                  blocks: [
                    {
                      type: "context",
                      elements: [
                        {
                          type: "mrkdwn",
                          text: ":zap: *Quick lookup in progress...*",
                        },
                      ],
                    },
                  ],
                },
              ],
            });
            const fastPlaceholderTs = placeholder.ts!;

            // Process SQL blocks before formatting
            const sqlResult = await processSqlInResponse(response.text);

            // Update session ID for conversation continuity
            if (response.sessionId) {
              updateSessionId(thread, response.sessionId);
            }

            await slackDispatch.finalize("completed", {
              sessionId: response.sessionId,
              summary: response.text,
              usage: response.usage,
              log: response.log,
            });

            const slackText = markdownToSlackMrkdwn(sqlResult.text);
            const chunks = splitMessage(slackText);

            await client.chat.update({
              channel: message.channel,
              ts: fastPlaceholderTs,
              text: chunks[0],
              attachments: [],
            });

            for (let i = 1; i < chunks.length; i++) {
              await client.chat.postMessage({
                channel: message.channel,
                thread_ts: threadTs,
                text: chunks[i],
              });
            }

            addMessageToThread(thread, {
              user: "danxbot",
              text: response.text,
              ts: Date.now().toString(),
              isBot: true,
            });

            // Upload CSV attachments if any SQL results
            await uploadCsvAttachments(client, message.channel, threadTs, sqlResult.attachments);

            await swapReaction(client, message.channel, message.ts, "brain", "white_check_mark");

            await client.reactions
              .add({ channel: message.channel, timestamp: fastPlaceholderTs, name: "thumbsup" })
              .catch(() => {});
            await client.reactions
              .add({ channel: message.channel, timestamp: fastPlaceholderTs, name: "thumbsdown" })
              .catch(() => {});

            log.info(
              `[${ls.repo.name}] Agent (very_low) responded in thread ${threadTs} (cost: $${response.subscriptionCostUsd.toFixed(4)}, turns: ${response.turns})`,
            );
            markIdle(threadTs);
            drainQueue(ls, threadTs, client);
            return;
          } catch (fastError) {
            const fastErrorMsg = fastError instanceof Error ? fastError.message : String(fastError);
            log.warn(
              `[${ls.repo.name}] Agent (very_low) failed in thread ${threadTs}, escalating to medium: ${fastErrorMsg}`,
            );
            // The very_low attempt failed; the medium retry below owns the
            // same dispatch row. No finalize here — the retry path will
            // either complete or fail the row.
            // Clear session if conversation got too long so escalated path starts fresh
            if (fastErrorMsg.includes("msg_too_long")) {
              clearSessionId(thread);
            }
            // Escalate: override complexity to medium for the full path below
            routerResult.complexity = "medium";
            // Remove brain reaction — will be re-added by full agent path below
            await client.reactions
              .remove({ channel: message.channel, timestamp: message.ts, name: "brain" })
              .catch(() => {});
            // Re-add brain for full agent path
            await client.reactions
              .add({ channel: message.channel, timestamp: message.ts, name: "brain" })
              .catch(() => {});
          }
        }

        // Post placeholder message with thinking indicator
        const placeholder = await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: " ",
          attachments: [
            {
              color: "#6c5ce7",
              blocks: [
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: ":hourglass_flowing_sand: *Researching your question...* The agent is exploring the codebase.",
                    },
                  ],
                },
              ],
            },
          ],
        });
        const placeholderTs = placeholder.ts!;

        // Track in-flight placeholder for shutdown cleanup
        const placeholderId = `${message.channel}-${placeholderTs}`;
        ls.inFlightPlaceholders.add(placeholderId);
        ls.placeholderData.set(placeholderId, {
          channel: message.channel,
          ts: placeholderTs,
          threadTs,
        });

        // Set up heartbeat manager for status updates during agent run
        const heartbeatStart = Date.now();
        const hbManager = new HeartbeatManager(
          client,
          message.channel,
          placeholderTs,
          threadTs,
          heartbeatStart,
        );
        hbManager.start();

        // Race the agent against a wall-clock timeout
        const timeoutMs = config.agent.timeoutMs;
        const maxAttempts = config.agent.maxRetries + 1;
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), timeoutMs),
        );

        try {
          let handled = false;

          for (let attempt = 0; attempt < maxAttempts && !handled; attempt++) {
            try {
              const agentPromise = runAgent(
                ls.repo,
                message.text,
                thread.sessionId,
                (text) => hbManager.onStream(text),
                (entry) => hbManager.onLogEntry(entry),
                thread.messages,
                routerResult.complexity,
              );
              const response = await Promise.race([agentPromise, timeoutPromise]);

              if (response === null) {
                // Agent timed out — do NOT retry
                const elapsed = Math.round(timeoutMs / 1000);
                log.error(
                  `[${ls.repo.name}] Agent timed out after ${elapsed}s in thread ${threadTs}`,
                );

                await postErrorAttachment(
                  client,
                  message.channel,
                  placeholderTs,
                  `:x: *Timed out after ${elapsed}s.* I wasn't able to find an answer in time. Want me to try again?`,
                );
                await swapReaction(
                  client,
                  message.channel,
                  message.ts,
                  "brain",
                  "warning",
                );
                notifyError(ls.repo.trello, "Agent Timeout", `Agent timed out after ${elapsed}s`, errorContext).catch(() => {});
                await slackDispatch.finalize("failed", {
                  error: `Agent timed out after ${elapsed}s`,
                });
                handled = true;
              } else {
                // Stop heartbeat BEFORE posting final response to prevent race conditions
                // where a late heartbeat flush overwrites the processed SQL result
                hbManager.stop();

                // Process SQL blocks before formatting
                const sqlResult = await processSqlInResponse(response.text);

                // Update session ID for conversation continuity
                if (response.sessionId) {
                  updateSessionId(thread, response.sessionId);
                }

                await slackDispatch.finalize("completed", {
                  sessionId: response.sessionId,
                  summary: response.text,
                  usage: response.usage,
                  log: response.log,
                });

                // Final update: replace placeholder with formatted response
                const slackText = markdownToSlackMrkdwn(sqlResult.text);
                const chunks = splitMessage(slackText);

                // Update the placeholder with the first chunk (remove thinking attachment)
                await client.chat.update({
                  channel: message.channel,
                  ts: placeholderTs,
                  text: chunks[0],
                  attachments: [],
                });

                // Post any additional chunks as new messages
                for (let i = 1; i < chunks.length; i++) {
                  await client.chat.postMessage({
                    channel: message.channel,
                    thread_ts: threadTs,
                    text: chunks[i],
                  });
                }

                addMessageToThread(thread, {
                  user: "danxbot",
                  text: response.text,
                  ts: Date.now().toString(),
                  isBot: true,
                });

                // Upload CSV attachments if any SQL results
                await uploadCsvAttachments(client, message.channel, threadTs, sqlResult.attachments);

                await swapReaction(
                  client,
                  message.channel,
                  message.ts,
                  "brain",
                  "white_check_mark",
                );

                await client.reactions
                  .add({ channel: message.channel, timestamp: placeholderTs, name: "thumbsup" })
                  .catch(() => {});
                await client.reactions
                  .add({ channel: message.channel, timestamp: placeholderTs, name: "thumbsdown" })
                  .catch(() => {});

                log.info(
                  `[${ls.repo.name}] Agent responded in thread ${threadTs} (cost: $${response.subscriptionCostUsd.toFixed(4)}, turns: ${response.turns})`,
                );
                handled = true;
              }
            } catch (agentError) {
              const errorMsg =
                agentError instanceof Error
                  ? agentError.message
                  : String(agentError);

              // Clear stale session ID so retry starts a fresh conversation
              if (errorMsg.includes("No conversation found") || errorMsg.includes("msg_too_long")) {
                clearSessionId(thread);
                log.warn("Cleared stale session ID, retrying with fresh session");
              }

              // Skip retries for non-retryable errors (billing, credit, etc.)
              const isNonRetryable = isOperationalError(errorMsg);

              const isLastAttempt = isNonRetryable || attempt >= maxAttempts - 1;

              if (isLastAttempt) {
                // All retries exhausted — show error
                const elapsed = Math.round(
                  (Date.now() - heartbeatStart) / 1000,
                );
                log.error(
                  `[${ls.repo.name}] Agent crashed after ${elapsed}s in thread ${threadTs}: ${errorMsg}`,
                );

                await postErrorAttachment(
                  client,
                  message.channel,
                  placeholderTs,
                  `:x: *The agent crashed after ${elapsed}s.* I wasn't able to look that up. Want me to try again?`,
                );
                await swapReaction(
                  client,
                  message.channel,
                  message.ts,
                  "brain",
                  "x",
                );
                notifyError(ls.repo.trello, "Agent Crash", errorMsg, errorContext).catch(() => {});
                await slackDispatch.finalize("failed", { error: errorMsg });
                handled = true;
              } else {
                // Retry — update placeholder with retrying status
                log.warn(
                  `[${ls.repo.name}] Agent crashed in thread ${threadTs} (attempt ${attempt + 1}/${maxAttempts}), retrying: ${errorMsg}`,
                );

                await client.chat.update({
                  channel: message.channel,
                  ts: placeholderTs,
                  text: " ",
                  attachments: [
                    {
                      color: "#e17055",
                      blocks: [
                        {
                          type: "context",
                          elements: [
                            {
                              type: "mrkdwn",
                              text: `:warning: *Retrying...* The agent hit an error, trying again (attempt ${attempt + 2}/${maxAttempts}).`,
                            },
                          ],
                        },
                      ],
                    },
                  ],
                });
              }
            }
          }
        } finally {
          hbManager.stop();
          // Remove from in-flight tracking
          ls.inFlightPlaceholders.delete(placeholderId);
          ls.placeholderData.delete(placeholderId);
          markIdle(threadTs);
          drainQueue(ls, threadTs, client);
        }
      } else if (routerResult.error) {
        // Router errored — still send the friendly message but mark as error
        await client.reactions
          .add({
            channel: message.channel,
            timestamp: message.ts,
            name: "x",
          })
          .catch(() => {});

        if (routerResult.isOperational) {
          notifyError(ls.repo.trello, "Router Error", routerResult.error, errorContext, {
            listId: ls.repo.trello.needsHelpListId,
            labelId: ls.repo.trello.needsHelpLabelId,
          }).catch(() => {});
        } else {
          notifyError(ls.repo.trello, "Router Error", routerResult.error, errorContext).catch(() => {});
        }
      }
    } catch (error) {
      log.error(`[${ls.repo.name}] Error handling message in thread ${threadTs}`, error);

      // Add error reaction
      await client.reactions
        .add({
          channel: message.channel,
          timestamp: message.ts,
          name: "x",
        })
        .catch(() => {});

      notifyError(ls.repo.trello, "Handler Error", error instanceof Error ? error.message : String(error), errorContext).catch(() => {});
    }
}

export async function startSlackListener(repo: RepoContext): Promise<void> {
  const app = new App({
    token: repo.slack.botToken,
    appToken: repo.slack.appToken,
    socketMode: true,
  });

  const ls: ListenerState = {
    repo,
    app,
    botUserId: null,
    connected: false,
    inFlightPlaceholders: new Set(),
    placeholderData: new Map(),
  };

  listeners.set(repo.name, ls);

  // Resolve the bot's own user ID so we can ignore its self-reactions
  const authResult = await app.client.auth.test();
  ls.botUserId = authResult.user_id ?? null;

  app.message(async ({ message, client }) => {
    await handleMessage(ls, message as SlackMessage, client);
  });

  await app.start();
  ls.connected = true;
  log.info(`[${repo.name}] Slack listener running (Socket Mode)`);
}
