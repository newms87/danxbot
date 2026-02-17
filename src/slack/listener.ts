import { App } from "@slack/bolt";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { markdownToSlackMrkdwn, splitMessage } from "./formatter.js";
import { swapReaction, postErrorAttachment } from "./helpers.js";
import { HeartbeatManager } from "./heartbeat-manager.js";
import { isRateLimited, recordAgentRun } from "./rate-limiter.js";
import { resolveUserName } from "./user-cache.js";
import { runRouter } from "../agent/router.js";
import { runAgent } from "../agent/agent.js";
import { processResponseWithAttachments, extractSqlBlocks } from "../agent/sql-executor.js";
import type { SqlAttachment } from "../agent/sql-executor.js";
import type { ApiCallUsage } from "../types.js";
import { notifyError } from "../errors/trello-notifier.js";
import { createEvent, updateEvent, findEventByResponseTs } from "../dashboard/events.js";
import {
  getOrCreateThread,
  addMessageToThread,
  updateSessionId,
  clearSessionId,
  isBotParticipant,
} from "../threads.js";

const log = createLogger("slack");

let app: App;
let botUserId: string | null = null;
let slackConnected = false;
let isShuttingDown = false;

import { isOperationalError } from "../errors/patterns.js";

// Track in-flight agent placeholders for graceful shutdown
interface InFlightPlaceholder {
  channel: string;
  ts: string;
  threadTs: string;
}
const inFlightPlaceholders = new Set<string>();
const placeholderData = new Map<string, InFlightPlaceholder>();

export function isSlackConnected(): boolean {
  return slackConnected;
}

export function stopSlackListener(): void {
  isShuttingDown = true;
}

export function getInFlightPlaceholders(): InFlightPlaceholder[] {
  return Array.from(placeholderData.values());
}

export function getSlackClient() {
  return app?.client;
}

/**
 * Resets shutdown state for testing. Exported for test isolation only.
 */
export function resetListenerState(): void {
  isShuttingDown = false;
  inFlightPlaceholders.clear();
  placeholderData.clear();
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

export async function startSlackListener(): Promise<void> {
  app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  // Resolve the bot's own user ID so we can ignore its self-reactions
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id ?? null;

  app.message(async ({ message, client }) => {
    // Type guard: only handle regular messages
    if (message.subtype) return;
    if (!("text" in message) || !message.text) return;
    if ("bot_id" in message && message.bot_id) return;

    // Only process messages from the configured channel
    if (message.channel !== config.slack.channelId) return;

    // Reject new messages during shutdown
    if (isShuttingDown) return;

    const threadTs = message.thread_ts || message.ts;
    const isThreadReply = !!message.thread_ts;
    const userId = message.user || "unknown";
    const errorContext = { threadTs, user: userId, channelId: message.channel };

    // Track in dashboard
    const dashEvent = createEvent({
      threadTs,
      messageTs: message.ts,
      channelId: message.channel,
      user: userId,
      text: message.text,
    });

    // Resolve user display name asynchronously (fire-and-forget)
    resolveUserName(client, userId).then((name) => {
      updateEvent(dashEvent.id, { userName: name });
    }).catch(() => {});

    try {
      // For thread replies, only respond if Flytebot is already participating
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
      updateEvent(dashEvent.id, { status: "routing" });
      const routerResult = await runRouter(message.text, thread.messages);
      updateEvent(dashEvent.id, {
        status: "routed",
        routerResponseAt: Date.now(),
        routerResponse: routerResult.quickResponse,
        routerNeedsAgent: routerResult.needsAgent,
        routerComplexity: routerResult.complexity,
        routerRequest: routerResult.request,
        routerRawResponse: routerResult.rawResponse,
      });
      log.info(
        `Router: needsAgent=${routerResult.needsAgent}, reason="${routerResult.reason}"`,
      );

      // Send the quick response immediately
      if (routerResult.quickResponse) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: routerResult.quickResponse,
        });

        addMessageToThread(thread, {
          user: "flytebot",
          text: routerResult.quickResponse,
          ts: Date.now().toString(),
          isBot: true,
        });
      }

      // Step 2: If the router says we need the agent, run it
      if (routerResult.needsAgent) {
        // Check rate limit before starting agent
        if (isRateLimited(userId)) {
          await client.chat.postMessage({
            channel: message.channel,
            thread_ts: threadTs,
            text: "I'm still working on your previous question. I'll get to this one next.",
          });
          updateEvent(dashEvent.id, { status: "complete" });
          return;
        }
        recordAgentRun(userId);

        updateEvent(dashEvent.id, { status: "agent_running" });

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

            // Collect usage: router + agent (no heartbeat for very_low)
            const apiCalls: ApiCallUsage[] = [];
            if (routerResult.usage) apiCalls.push(routerResult.usage);
            const apiCostUsd = apiCalls.reduce((sum, c) => sum + c.costUsd, 0);

            // Count SQL blocks and process them before formatting
            const sqlBlockCount = extractSqlBlocks(response.text).length;
            const sqlResult = await processSqlInResponse(response.text);

            updateEvent(dashEvent.id, {
              status: "complete",
              agentResponseAt: Date.now(),
              agentResponse: response.text,
              subscriptionCostUsd: response.subscriptionCostUsd,
              agentTurns: response.turns,
              agentConfig: response.config,
              agentLog: response.log,
              apiCalls: apiCalls.length > 0 ? apiCalls : null,
              apiCostUsd: apiCostUsd > 0 ? apiCostUsd : null,
              agentUsage: response.usage,
              ...(sqlBlockCount > 0 ? { sqlQueriesProcessed: sqlBlockCount } : {}),
            });

            // Update session ID for conversation continuity
            if (response.sessionId) {
              updateSessionId(thread, response.sessionId);
            }

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
              user: "flytebot",
              text: response.text,
              ts: Date.now().toString(),
              isBot: true,
            });

            // Upload CSV attachments if any SQL results
            await uploadCsvAttachments(client, message.channel, threadTs, sqlResult.attachments);

            await swapReaction(client, message.channel, message.ts, "brain", "white_check_mark");

            updateEvent(dashEvent.id, { responseTs: fastPlaceholderTs });
            await client.reactions
              .add({ channel: message.channel, timestamp: fastPlaceholderTs, name: "thumbsup" })
              .catch(() => {});
            await client.reactions
              .add({ channel: message.channel, timestamp: fastPlaceholderTs, name: "thumbsdown" })
              .catch(() => {});

            log.info(
              `Agent (very_low) responded in thread ${threadTs} (cost: $${response.subscriptionCostUsd.toFixed(4)}, turns: ${response.turns})`,
            );
            return;
          } catch (fastError) {
            log.warn(
              `Agent (very_low) failed in thread ${threadTs}, escalating to medium: ${
                fastError instanceof Error ? fastError.message : String(fastError)
              }`,
            );
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
        inFlightPlaceholders.add(placeholderId);
        placeholderData.set(placeholderId, {
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
          let agentRetried = false;

          for (let attempt = 0; attempt < maxAttempts && !handled; attempt++) {
            try {
              const agentPromise = runAgent(
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
                  `Agent timed out after ${elapsed}s in thread ${threadTs}`,
                );

                updateEvent(dashEvent.id, {
                  status: "error",
                  error: `Agent timed out after ${elapsed}s`,
                });

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
                notifyError("Agent Timeout", `Agent timed out after ${elapsed}s`, errorContext).catch(() => {});
                handled = true;
              } else {
                // Agent succeeded — collect usage: router + heartbeats
                const apiCalls: ApiCallUsage[] = [];
                if (routerResult.usage) apiCalls.push(routerResult.usage);
                apiCalls.push(...hbManager.getApiCalls());
                const apiCostUsd = apiCalls.reduce((sum, c) => sum + c.costUsd, 0);

                // Count SQL blocks and process them before formatting
                const sqlBlockCount = extractSqlBlocks(response.text).length;
                const sqlResult = await processSqlInResponse(response.text);

                // Collect heartbeat snapshots for dashboard timeline
                const heartbeatSnapshots = hbManager.getSnapshots();

                updateEvent(dashEvent.id, {
                  status: "complete",
                  agentResponseAt: Date.now(),
                  agentResponse: response.text,
                  subscriptionCostUsd: response.subscriptionCostUsd,
                  agentTurns: response.turns,
                  agentConfig: response.config,
                  agentLog: response.log,
                  heartbeatSnapshots: heartbeatSnapshots.length > 0 ? heartbeatSnapshots : null,
                  apiCalls: apiCalls.length > 0 ? apiCalls : null,
                  apiCostUsd: apiCostUsd > 0 ? apiCostUsd : null,
                  agentUsage: response.usage,
                  ...(agentRetried ? { agentRetried: true } : {}),
                  ...(sqlBlockCount > 0 ? { sqlQueriesProcessed: sqlBlockCount } : {}),
                });

                // Update session ID for conversation continuity
                if (response.sessionId) {
                  updateSessionId(thread, response.sessionId);
                }

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
                  user: "flytebot",
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

                // Store responseTs and add feedback reactions
                updateEvent(dashEvent.id, { responseTs: placeholderTs });
                await client.reactions
                  .add({ channel: message.channel, timestamp: placeholderTs, name: "thumbsup" })
                  .catch(() => {});
                await client.reactions
                  .add({ channel: message.channel, timestamp: placeholderTs, name: "thumbsdown" })
                  .catch(() => {});

                log.info(
                  `Agent responded in thread ${threadTs} (cost: $${response.subscriptionCostUsd.toFixed(4)}, turns: ${response.turns})`,
                );
                handled = true;
              }
            } catch (agentError) {
              const errorMsg =
                agentError instanceof Error
                  ? agentError.message
                  : String(agentError);

              // Clear stale session ID so retry starts a fresh conversation
              if (errorMsg.includes("No conversation found")) {
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
                  `Agent crashed after ${elapsed}s in thread ${threadTs}: ${errorMsg}`,
                );

                updateEvent(dashEvent.id, {
                  status: "error",
                  error: errorMsg,
                });

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
                notifyError("Agent Crash", errorMsg, errorContext).catch(() => {});
                handled = true;
              } else {
                // Retry — update placeholder with retrying status
                agentRetried = true;
                log.warn(
                  `Agent crashed in thread ${threadTs} (attempt ${attempt + 1}/${maxAttempts}), retrying: ${errorMsg}`,
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
          inFlightPlaceholders.delete(placeholderId);
          placeholderData.delete(placeholderId);
        }
      } else if (routerResult.error) {
        // Router errored — still send the friendly message but mark as error
        updateEvent(dashEvent.id, {
          status: "error",
          error: routerResult.error,
        });

        await client.reactions
          .add({
            channel: message.channel,
            timestamp: message.ts,
            name: "x",
          })
          .catch(() => {});

        if (routerResult.isOperational) {
          notifyError("Router Error", routerResult.error, errorContext, {
            listId: config.trello.needsHelpListId,
            labelId: config.trello.needsHelpLabelId,
          }).catch(() => {});
        } else {
          notifyError("Router Error", routerResult.error, errorContext).catch(() => {});
        }
      } else {
        // Router-only response, mark complete — capture router API usage
        const routerApiCalls: ApiCallUsage[] = [];
        if (routerResult.usage) routerApiCalls.push(routerResult.usage);
        const routerApiCost = routerApiCalls.reduce((sum, c) => sum + c.costUsd, 0);
        updateEvent(dashEvent.id, {
          status: "complete",
          apiCalls: routerApiCalls.length > 0 ? routerApiCalls : null,
          apiCostUsd: routerApiCost > 0 ? routerApiCost : null,
        });
      }
    } catch (error) {
      log.error(`Error handling message in thread ${threadTs}`, error);
      updateEvent(dashEvent.id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });

      // Add error reaction
      await client.reactions
        .add({
          channel: message.channel,
          timestamp: message.ts,
          name: "x",
        })
        .catch(() => {});

      notifyError("Handler Error", error instanceof Error ? error.message : String(error), errorContext).catch(() => {});
    }
  });

  const positiveReactions = new Set(["thumbsup", "+1"]);
  const negativeReactions = new Set(["thumbsdown", "-1"]);

  app.event("reaction_added", async ({ event }) => {
    const isPositive = positiveReactions.has(event.reaction);
    const isNegative = negativeReactions.has(event.reaction);
    if (!isPositive && !isNegative) return;
    if (!("channel" in event.item) || event.item.channel !== config.slack.channelId) return;
    if (botUserId && event.user === botUserId) return;

    const dashEvent = findEventByResponseTs(event.item.ts);
    if (!dashEvent) return;

    const feedback = isPositive ? "positive" : "negative";
    updateEvent(dashEvent.id, { feedback });
    log.info(`Feedback recorded: ${feedback} for event ${dashEvent.id} (reaction: ${event.reaction})`);
  });

  await app.start();
  slackConnected = true;
  log.info("Flytebot is running (Socket Mode)");
}
