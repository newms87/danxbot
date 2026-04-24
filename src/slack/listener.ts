import { App } from "@slack/bolt";
import type { SlackBoltClient } from "./types.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { swapReaction } from "./helpers.js";
import {
  isProcessing,
  markProcessing,
  markIdle,
  enqueue,
  dequeue,
  getQueueStats,
  getTotalQueuedCount,
  resetQueue,
} from "./message-queue.js";
import { resolveUserName } from "./user-cache.js";
import { isFeatureEnabled } from "../settings-file.js";
import { runRouter } from "../agent/router.js";
import type { RepoContext, ThreadMessage } from "../types.js";
import { notifyError } from "../errors/trello-notifier.js";
import { dispatchWithWorkspace } from "../dispatch/core.js";
import { findLatestDispatchBySlackThread } from "../dashboard/dispatches-db.js";
import type { SlackTriggerMetadata } from "../dashboard/dispatches.js";
import type { AgentJob } from "../agent/launcher.js";
import {
  getOrCreateThread,
  addMessageToThread,
  isBotParticipant,
  trimThreadMessages,
} from "../threads.js";
import { isTransientError } from "../errors/patterns.js";

const log = createLogger("slack");

/** Per-repo listener state. Each repo with Slack gets its own independent entry. */
interface ListenerState {
  repo: RepoContext;
  app: App;
  botUserId: string | null;
  connected: boolean;
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

/**
 * Return the bolt client for a specific repo, or undefined when no
 * listener is running for that repo or it has not yet connected.
 *
 * Used by the worker's `/api/slack/{reply,update}/:dispatchId` handlers
 * to route the `danxbot_slack_*` MCP tool calls back to the originating
 * repo's Slack workspace — a dispatched agent must never post into a
 * different repo's channel.
 */
export function getSlackClientForRepo(
  repoName: string,
): SlackBoltClient | undefined {
  const state = listeners.get(repoName);
  if (!state || !state.connected) return undefined;
  return state.app.client;
}

/**
 * Resets shutdown state for testing. Exported for test isolation only.
 */
export function resetListenerState(): void {
  isShuttingDown = false;
  listeners.clear();
  resetQueue();
}

export { getQueueStats, getTotalQueuedCount } from "./message-queue.js";

/**
 * Drains queued messages for a thread by re-injecting them into the handler.
 * Runs asynchronously (fire-and-forget) so the current handler can return.
 */
function drainQueue(
  ls: ListenerState,
  threadTs: string,
  client: SlackBoltClient | undefined,
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

/**
 * Slack-specific prompt shaping: prepend trimmed thread history when there
 * is more than one message in the thread and the dispatch is NOT resuming
 * a prior session. When resuming, the Claude session already contains the
 * full conversation history — prepending it again doubles the context and
 * breaks `--resume` semantics.
 */
function buildSlackAgentPrompt(
  text: string,
  messages: ThreadMessage[],
): string {
  const trimmed = trimThreadMessages(messages, config.agent.maxThreadMessages);
  if (trimmed.length <= 1) return text;
  const history = trimmed
    .slice(0, -1) // Exclude the current message (passed separately as text)
    .map((m) => `${m.isBot ? "Bot" : "User"}: ${m.text}`)
    .join("\n");
  return `[Thread context]\n${history}\n\n[Current message]\n${text}`;
}

async function postFailureIntoThread(
  client: SlackBoltClient | undefined,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  if (!client) return;
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
    });
  } catch (err) {
    // This post is the user's ONLY signal that the agent failed (the
    // old heartbeat + placeholder UI are gone in Phase 2), so a broken
    // Slack client here needs to be a loud error — not a warn — and
    // surfaced to the operator via Trello.
    log.error("Failed to post failure message into Slack thread", err);
  }
}

/**
 * Produce a user-facing failure line for a non-completed terminal
 * `AgentJob.status`. The listener needs this because the dispatched
 * agent may have exited BEFORE calling `danxbot_slack_reply`, which
 * leaves the thread with no explanation. Each status maps to a
 * phrase that accurately describes what happened — collapsing them
 * into a single "the agent stopped without a reply" line is wrong for
 * `canceled` (user-initiated stop) and misleading for `timeout`.
 */
function failureLineForStatus(
  status: AgentJob["status"],
  summary: string | null | undefined,
): string {
  const tail = summary?.trim();
  switch (status) {
    case "timeout":
      return tail
        ? `:x: Timed out before producing a reply — ${tail}`
        : ":x: Timed out before producing a reply.";
    case "canceled":
      return ":x: Cancelled.";
    case "failed":
      return tail
        ? `:x: ${tail}`
        : ":x: The agent failed without a reply.";
    case "running":
      // Not a terminal state — listener only calls this helper from a
      // resolved `onComplete`, but be explicit so a future contract
      // change doesn't silently render misleading text.
      return ":x: The agent exited in an unexpected state.";
    case "completed":
      // Caller should not reach here — completed takes the success
      // branch. Keep a defensive message so a future refactor doesn't
      // fall into an unreachable-default anti-pattern.
      return ":white_check_mark: Done.";
  }
}

/**
 * Launch the deep-agent dispatch for a Slack message and await its
 * terminal state. The dispatched agent posts its own replies via the
 * `danxbot_slack_reply` / `danxbot_slack_post_update` MCP tools, so the
 * listener's job is just to launch the dispatch, track the reaction
 * lifecycle on the user's message, and post a failure message into the
 * thread when the agent exits without having posted anything itself.
 */
async function launchSlackDispatch(
  ls: ListenerState,
  client: SlackBoltClient,
  slackMeta: SlackTriggerMetadata,
  threadMessages: ThreadMessage[],
): Promise<void> {
  // Thread continuity: a completed prior dispatch for this thread means
  // the Claude session MAY still be on disk and resumable. The DB
  // filters `status='completed'` at the query layer, but a completed
  // row can legitimately have `sessionUuid: null` (the JSONL was
  // purged under retention, or the prior dispatch finalized before
  // the watcher resolved a session ID). In that case there is nothing
  // to resume — we start a fresh session AND do not claim lineage
  // (a `parentJobId` without a `resumeSessionId` is an inconsistent
  // state: the dispatches row asserts a parent, but claude is
  // running fresh). Both fields derive from the same `priorSessionId`
  // gate so they always flow together.
  const prior = await findLatestDispatchBySlackThread(slackMeta.threadTs);
  const priorSessionId = prior?.sessionUuid ?? undefined;
  const resumeSessionId = priorSessionId;
  const parentJobId = priorSessionId ? prior?.id : undefined;

  const prompt = resumeSessionId
    ? slackMeta.messageText
    : buildSlackAgentPrompt(slackMeta.messageText, threadMessages);

  // Await the agent's terminal state so we can swap the reaction on the
  // user's message. `dispatchWithWorkspace` returns as soon as the claude
  // process is spawned; `onComplete` fires when it reaches a terminal
  // status. Errors thrown before spawn (workspace resolve / MCP init)
  // reject the outer promise and surface to the caller as operational
  // errors. The slack-worker workspace declares its own allowed-tools
  // (`Read`/`Glob`/`Grep`/`Bash` + the two `mcp__danxbot__danxbot_slack_*`
  // tools) and gates on `settings.slack.enabled ≠ false`; the overlay
  // below supplies the four per-dispatch placeholders the workspace
  // requires. `apiDispatchMeta.trigger: "slack"` is still persisted on
  // the dispatch row for dashboard analytics — it no longer drives tool
  // resolution (`buildResolveOptions`'s slack branch is transitional /
  // legacy-only, see `src/dispatch/core.ts`).
  const finalJob = await new Promise<AgentJob>((resolve, reject) => {
    dispatchWithWorkspace({
      repo: ls.repo,
      task: prompt,
      workspace: "slack-worker",
      // `DANXBOT_STOP_URL` + `DANXBOT_SLACK_*_URL` are auto-injected by
      // `dispatchWithWorkspace` from the dispatchId — the caller can't
      // pre-compute them. `DANXBOT_WORKER_PORT` is the only caller-
      // supplied placeholder the slack-worker workspace requires; the
      // workspace references it from its `.claude/settings.json` env
      // block so the dispatched agent's MCP subprocesses resolve
      // `${DANXBOT_WORKER_PORT}` at startup.
      overlay: {
        DANXBOT_WORKER_PORT: String(ls.repo.workerPort),
      },
      apiDispatchMeta: { trigger: "slack", metadata: slackMeta },
      resumeSessionId,
      parentJobId,
      onComplete: (job) => resolve(job),
    }).catch(reject);
  });

  const success = finalJob.status === "completed";
  await swapReaction(
    client,
    slackMeta.channelId,
    slackMeta.messageTs,
    "brain",
    success ? "white_check_mark" : "x",
  );

  if (!success) {
    // The dispatched agent may have crashed, been cancelled, or timed
    // out before calling `danxbot_slack_reply`, which would leave the
    // user staring at a brain-then-x reaction with no explanation.
    // Pick a failure phrase that accurately describes which terminal
    // status fired; `failureLineForStatus` owns the phrasing policy.
    const line = failureLineForStatus(finalJob.status, finalJob.summary);
    await postFailureIntoThread(
      client,
      slackMeta.channelId,
      slackMeta.threadTs,
      line,
    );
    // User-cancelled dispatches are NOT Trello-notifiable — they're an
    // intentional operator action, not an error the team needs to
    // investigate. Every other non-completed status is.
    if (finalJob.status !== "canceled") {
      notifyError(
        ls.repo.trello,
        "Slack Agent Failure",
        finalJob.summary?.trim() || `Agent exited with status ${finalJob.status}`,
        {
          threadTs: slackMeta.threadTs,
          user: slackMeta.user,
          channelId: slackMeta.channelId,
        },
      ).catch(() => {});
    }
  }
}

async function handleMessage(
  ls: ListenerState,
  message: SlackMessage,
  client: SlackBoltClient | undefined,
): Promise<void> {
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
  const errorContext = {
    threadTs,
    user: userId,
    channelId: message.channel,
  };

  // Resolve user display name asynchronously (fire-and-forget)
  resolveUserName(client, userId).catch(() => {});

  try {
    // For thread replies, only respond if Danxbot is already participating
    if (isThreadReply) {
      const participating = await isBotParticipant(threadTs);
      if (!participating) return;
    }

    // Runtime toggle — when Slack is disabled for this repo via the
    // settings file, react + reply so the user knows why there's no
    // response, then skip router and agent entirely. The three-valued
    // override (true/false/null) in `.danxbot/settings.json` wins over
    // the env default carried on RepoContext. See
    // `.claude/rules/settings-file.md`.
    if (!isFeatureEnabled(ls.repo, "slack")) {
      await client.reactions
        .add({
          channel: message.channel,
          timestamp: message.ts,
          name: "no_entry_sign",
        })
        .catch(() => {});
      await client.chat
        .postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: "Danxbot is currently disabled for this repo. Re-enable in the dashboard.",
        })
        .catch(() => {});
      return;
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

    // Step 2: If the router says we need the agent, dispatch it
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

      // Add thinking reaction while agent works. The dispatched agent
      // posts its own intermediate updates via
      // `danxbot_slack_post_update` and its final answer via
      // `danxbot_slack_reply` — the listener no longer owns a
      // placeholder message or a heartbeat UI. The brain reaction is
      // the one immediate "working" indicator the listener still
      // renders; it gets swapped to :white_check_mark: or :x: when the
      // dispatch reaches a terminal state (see `launchSlackDispatch`).
      await client.reactions
        .add({
          channel: message.channel,
          timestamp: message.ts,
          name: "brain",
        })
        .catch(() => {});

      const slackMeta: SlackTriggerMetadata = {
        channelId: message.channel,
        threadTs,
        messageTs: message.ts,
        user: userId,
        userName: null,
        messageText: message.text,
      };

      try {
        await launchSlackDispatch(ls, client, slackMeta, thread.messages);
      } catch (dispatchErr) {
        const errorMsg =
          dispatchErr instanceof Error
            ? dispatchErr.message
            : String(dispatchErr);
        log.error(
          `[${ls.repo.name}] Slack dispatch failed in thread ${threadTs}: ${errorMsg}`,
        );
        await swapReaction(
          client,
          message.channel,
          message.ts,
          "brain",
          "x",
        );
        await postFailureIntoThread(
          client,
          message.channel,
          threadTs,
          `:x: I couldn't launch the agent — ${errorMsg}`,
        );
        if (!isTransientError(errorMsg)) {
          notifyError(
            ls.repo.trello,
            "Slack Dispatch Failure",
            errorMsg,
            errorContext,
          ).catch(() => {});
        }
      } finally {
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
        notifyError(
          ls.repo.trello,
          "Router Error",
          routerResult.error,
          errorContext,
          {
            listId: ls.repo.trello.needsHelpListId,
            labelId: ls.repo.trello.needsHelpLabelId,
          },
        ).catch(() => {});
      } else {
        notifyError(
          ls.repo.trello,
          "Router Error",
          routerResult.error,
          errorContext,
        ).catch(() => {});
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`[${ls.repo.name}] Error handling message in thread ${threadTs}`, error);

    // Add error reaction
    await client.reactions
      .add({
        channel: message.channel,
        timestamp: message.ts,
        name: "x",
      })
      .catch(() => {});

    if (!isTransientError(errorMsg)) {
      notifyError(
        ls.repo.trello,
        "Handler Error",
        errorMsg,
        errorContext,
      ).catch(() => {});
    }
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
