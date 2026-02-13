import { App } from "@slack/bolt";
import { config } from "../config.js";
import { markdownToSlackMrkdwn, splitMessage } from "./formatter.js";
import {
  runRouter,
  runAgent,
  generateHeartbeatMessage,
  buildActivitySummary,
} from "../agent/agent.js";
import { createEvent, updateEvent } from "../dashboard/events.js";
import type {
  AgentLogEntry,
  HeartbeatSnapshot,
  HeartbeatUpdate,
} from "../types.js";
import {
  getOrCreateThread,
  addMessageToThread,
  updateSessionId,
  isBotParticipant,
} from "../threads.js";

let app: App;

export async function startSlackListener(): Promise<void> {
  app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  app.message(async ({ message, client }) => {
    // Type guard: only handle regular messages
    if (message.subtype) return;
    if (!("text" in message) || !message.text) return;
    if ("bot_id" in message && message.bot_id) return;

    // Only process messages from the configured channel
    if (message.channel !== config.slack.channelId) return;

    const threadTs = message.thread_ts || message.ts;
    const isThreadReply = !!message.thread_ts;

    // Track in dashboard
    const dashEvent = createEvent({
      threadTs,
      messageTs: message.ts,
      channelId: message.channel,
      user: message.user || "unknown",
      text: message.text,
    });

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
        user: message.user || "unknown",
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
        routerRequest: routerResult.request,
        routerRawResponse: routerResult.rawResponse,
      });
      console.log(
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
        updateEvent(dashEvent.id, { status: "agent_running" });

        // Add thinking reaction while agent works
        await client.reactions
          .add({
            channel: message.channel,
            timestamp: message.ts,
            name: "brain",
          })
          .catch(() => {});

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

        // Heartbeat state: conversational orchestrator with full memory
        const agentLog: AgentLogEntry[] = [];
        const heartbeatStart = Date.now();
        let lastSnapshotEntryCount = 0;
        let heartbeatCycle = 0;
        let orchestratorPending = false;
        const previousSnapshots: HeartbeatSnapshot[] = [];
        let latestHeartbeat: HeartbeatUpdate = {
          emoji: ":hourglass_flowing_sand:",
          color: "#6c5ce7",
          text: "Dispatching the agent now, hang tight...",
          stop: false,
        };

        const onLogEntry = (entry: AgentLogEntry) => {
          agentLog.push(entry);
        };

        // Throttled streaming state: update Slack at most every 500ms
        let lastFlushTime = 0;
        let pendingTimer: ReturnType<typeof setTimeout> | null = null;
        let latestStreamText = "";

        const flushToSlack = () => {
          if (!latestStreamText) return;
          const preview = markdownToSlackMrkdwn(latestStreamText);
          const truncated =
            preview.length > 3900
              ? preview.slice(0, 3900) + "\n\n_...still generating..._"
              : preview;

          client.chat
            .update({
              channel: message.channel,
              ts: placeholderTs,
              text: truncated,
              attachments: [
                {
                  color: latestHeartbeat.color,
                  blocks: [
                    {
                      type: "context",
                      elements: [
                        {
                          type: "mrkdwn",
                          text: `${latestHeartbeat.emoji} *${latestHeartbeat.text}* (${Math.round((Date.now() - heartbeatStart) / 1000)}s)`,
                        },
                      ],
                    },
                  ],
                },
              ],
            })
            .catch((err: unknown) =>
              console.error("Stream update failed:", err),
            );

          lastFlushTime = Date.now();
        };

        const onStream = (accumulatedText: string) => {
          latestStreamText = accumulatedText;
          const now = Date.now();
          const elapsed = now - lastFlushTime;

          if (elapsed >= 500) {
            if (pendingTimer) {
              clearTimeout(pendingTimer);
              pendingTimer = null;
            }
            flushToSlack();
          } else if (!pendingTimer) {
            pendingTimer = setTimeout(() => {
              pendingTimer = null;
              flushToSlack();
            }, 500 - elapsed);
          }
        };

        const updateHeartbeatSlack = (hb: HeartbeatUpdate) => {
          const elapsed = Math.round(
            (Date.now() - heartbeatStart) / 1000,
          );
          client.chat
            .update({
              channel: message.channel,
              ts: placeholderTs,
              text: latestStreamText
                ? markdownToSlackMrkdwn(latestStreamText)
                : " ",
              attachments: [
                {
                  color: hb.color,
                  blocks: [
                    {
                      type: "context",
                      elements: [
                        {
                          type: "mrkdwn",
                          text: `${hb.emoji} *${hb.text}* (${elapsed}s)`,
                        },
                      ],
                    },
                  ],
                },
              ],
            })
            .catch((err: unknown) =>
              console.error("Heartbeat update failed:", err),
            );
        };

        const heartbeatInterval = setInterval(() => {
          heartbeatCycle++;

          // Update Slack every tick (5s) with cached heartbeat
          updateHeartbeatSlack(latestHeartbeat);

          // Call orchestrator every other tick (10s)
          if (heartbeatCycle % 2 === 0 && !orchestratorPending) {
            orchestratorPending = true;
            const elapsed = Math.round(
              (Date.now() - heartbeatStart) / 1000,
            );

            // Build and store the activity summary for this cycle
            const activitySummary = buildActivitySummary(
              agentLog,
              lastSnapshotEntryCount,
              elapsed,
            );

            generateHeartbeatMessage(activitySummary, previousSnapshots)
              .then((update) => {
                latestHeartbeat = update;
                previousSnapshots.push({ activitySummary, update });
                lastSnapshotEntryCount = agentLog.length;
                orchestratorPending = false;

                if (update.stop) {
                  // Orchestrator detected the agent is dead
                  clearInterval(heartbeatInterval);
                  console.error(
                    `Orchestrator signaled stop in thread ${threadTs}: ${update.text}`,
                  );
                  updateHeartbeatSlack(update);
                } else {
                  updateHeartbeatSlack(update);
                }
              })
              .catch(() => {
                orchestratorPending = false;
              });
          }
        }, 5000);

        // Race the agent against a wall-clock timeout
        const timeoutMs = config.agent.timeoutMs;
        const agentPromise = runAgent(
          message.text,
          thread.sessionId,
          onStream,
          onLogEntry,
          thread.messages,
        );
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), timeoutMs),
        );

        try {
          const response = await Promise.race([agentPromise, timeoutPromise]);

          if (response === null) {
            // Agent timed out
            const elapsed = Math.round(timeoutMs / 1000);
            console.error(
              `Agent timed out after ${elapsed}s in thread ${threadTs}`,
            );

            updateEvent(dashEvent.id, {
              status: "error",
              error: `Agent timed out after ${elapsed}s`,
            });

            await client.chat.update({
              channel: message.channel,
              ts: placeholderTs,
              text: " ",
              attachments: [
                {
                  color: "#e74c3c",
                  blocks: [
                    {
                      type: "context",
                      elements: [
                        {
                          type: "mrkdwn",
                          text: `:x: *Timed out after ${elapsed}s.* I wasn't able to find an answer in time. Want me to try again?`,
                        },
                      ],
                    },
                  ],
                },
              ],
            });

            // Swap reactions: remove thinking, add warning
            await client.reactions
              .remove({
                channel: message.channel,
                timestamp: message.ts,
                name: "brain",
              })
              .catch(() => {});
            await client.reactions
              .add({
                channel: message.channel,
                timestamp: message.ts,
                name: "warning",
              })
              .catch(() => {});
          } else {
            updateEvent(dashEvent.id, {
              status: "complete",
              agentResponseAt: Date.now(),
              agentResponse: response.text,
              agentCostUsd: response.costUsd,
              agentTurns: response.turns,
              agentConfig: response.config,
              agentLog: response.log,
            });

            // Update session ID for conversation continuity
            if (response.sessionId) {
              updateSessionId(thread, response.sessionId);
            }

            // Final update: replace placeholder with formatted response
            const slackText = markdownToSlackMrkdwn(response.text);
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

            // Swap reactions: remove thinking, add done
            await client.reactions
              .remove({
                channel: message.channel,
                timestamp: message.ts,
                name: "brain",
              })
              .catch(() => {});
            await client.reactions
              .add({
                channel: message.channel,
                timestamp: message.ts,
                name: "white_check_mark",
              })
              .catch(() => {});

            console.log(
              `Agent responded in thread ${threadTs} (cost: $${response.costUsd.toFixed(4)}, turns: ${response.turns})`,
            );
          }
        } catch (agentError) {
          // Agent crashed — update Slack with error message
          const elapsed = Math.round(
            (Date.now() - heartbeatStart) / 1000,
          );
          const errorMsg =
            agentError instanceof Error
              ? agentError.message
              : String(agentError);
          console.error(
            `Agent crashed after ${elapsed}s in thread ${threadTs}:`,
            errorMsg,
          );

          updateEvent(dashEvent.id, {
            status: "error",
            error: errorMsg,
          });

          await client.chat.update({
            channel: message.channel,
            ts: placeholderTs,
            text: " ",
            attachments: [
              {
                color: "#e74c3c",
                blocks: [
                  {
                    type: "context",
                    elements: [
                      {
                        type: "mrkdwn",
                        text: `:x: *The agent crashed after ${elapsed}s.* I wasn't able to look that up. Want me to try again?`,
                      },
                    ],
                  },
                ],
              },
            ],
          });

          await client.reactions
            .remove({
              channel: message.channel,
              timestamp: message.ts,
              name: "brain",
            })
            .catch(() => {});
          await client.reactions
            .add({
              channel: message.channel,
              timestamp: message.ts,
              name: "x",
            })
            .catch(() => {});
        } finally {
          // Always clean up heartbeat and pending throttle timer
          clearInterval(heartbeatInterval);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
          }
        }
      } else {
        // Router-only response, mark complete
        updateEvent(dashEvent.id, { status: "complete" });
      }
    } catch (error) {
      console.error(`Error handling message in thread ${threadTs}:`, error);
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
    }
  });

  await app.start();
  console.log("Flytebot is running (Socket Mode)");
}
