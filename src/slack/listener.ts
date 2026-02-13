import { App } from "@slack/bolt";
import { config } from "../config.js";
import { markdownToSlackMrkdwn, splitMessage } from "./formatter.js";
import { runRouter, runAgent } from "../agent/agent.js";
import { createEvent, updateEvent } from "../dashboard/events.js";
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
      const routerResult = await runRouter(message.text);
      updateEvent(dashEvent.id, {
        status: "routed",
        routerResponseAt: Date.now(),
        routerResponse: routerResult.quickResponse,
        routerNeedsAgent: routerResult.needsAgent,
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

        const response = await runAgent(message.text, thread.sessionId);

        updateEvent(dashEvent.id, {
          status: "complete",
          agentResponseAt: Date.now(),
          agentResponse: response.text,
          agentCostUsd: response.costUsd,
          agentTurns: response.turns,
        });

        // Update session ID for conversation continuity
        if (response.sessionId) {
          updateSessionId(thread, response.sessionId);
        }

        // Format and send agent response
        const slackText = markdownToSlackMrkdwn(response.text);
        const chunks = splitMessage(slackText);

        for (const chunk of chunks) {
          await client.chat.postMessage({
            channel: message.channel,
            thread_ts: threadTs,
            text: chunk,
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
