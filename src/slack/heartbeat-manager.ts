import type { WebClient } from "@slack/web-api";
import { createLogger } from "../logger.js";
import { markdownToSlackMrkdwn } from "./formatter.js";
import { buildHeartbeatAttachment } from "./helpers.js";
import {
  generateHeartbeatMessage,
  buildActivitySummary,
} from "../agent/heartbeat.js";
import type {
  AgentLogEntry,
  ApiCallUsage,
  HeartbeatSnapshot,
  HeartbeatUpdate,
} from "../types.js";

const log = createLogger("heartbeat-manager");

const STREAM_TRUNCATE_LIMIT = 3900;
const STREAM_THROTTLE_MS = 500;
const HEARTBEAT_TICK_MS = 5000;
const ORCHESTRATOR_EVERY_N_TICKS = 2;

/**
 * Manages the heartbeat lifecycle during an agent run:
 * - Periodic Slack attachment updates with orchestrator-generated messages
 * - Throttled stream text flushing to the placeholder message
 * - Cleanup of intervals and timers
 */
export class HeartbeatManager {
  private client: WebClient;
  private channel: string;
  private placeholderTs: string;
  private threadTs: string;
  private heartbeatStart: number;

  private agentLog: AgentLogEntry[] = [];
  private heartbeatApiCalls: ApiCallUsage[] = [];
  private lastSnapshotEntryCount = 0;
  private heartbeatCycle = 0;
  private orchestratorPending = false;
  private previousSnapshots: HeartbeatSnapshot[] = [];
  latestHeartbeat: HeartbeatUpdate = {
    emoji: ":hourglass_flowing_sand:",
    color: "#6c5ce7",
    text: "Dispatching the agent now, hang tight...",
    stop: false,
  };

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastFlushTime = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private latestStreamText = "";

  constructor(
    client: WebClient,
    channel: string,
    placeholderTs: string,
    threadTs: string,
    heartbeatStart: number,
  ) {
    this.client = client;
    this.channel = channel;
    this.placeholderTs = placeholderTs;
    this.threadTs = threadTs;
    this.heartbeatStart = heartbeatStart;
  }

  /** Returns all API call usage records from heartbeat calls. */
  getApiCalls(): ApiCallUsage[] {
    return this.heartbeatApiCalls;
  }

  /** Appends a log entry from the agent for orchestrator consumption. */
  onLogEntry(entry: AgentLogEntry): void {
    this.agentLog.push(entry);
  }

  /** Handles throttled stream text flushing to Slack. */
  onStream(accumulatedText: string): void {
    this.latestStreamText = accumulatedText;
    const now = Date.now();
    const elapsed = now - this.lastFlushTime;

    if (elapsed >= STREAM_THROTTLE_MS) {
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      this.flushToSlack();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.flushToSlack();
      }, STREAM_THROTTLE_MS - elapsed);
    }
  }

  /** Starts the periodic heartbeat interval. */
  start(): void {
    this.heartbeatInterval = setInterval(() => {
      this.heartbeatCycle++;

      // Update Slack every tick with cached heartbeat
      this.updateHeartbeatSlack(this.latestHeartbeat);

      // Call orchestrator every N ticks
      if (
        this.heartbeatCycle % ORCHESTRATOR_EVERY_N_TICKS === 0 &&
        !this.orchestratorPending
      ) {
        this.orchestratorPending = true;
        const elapsed = Math.round(
          (Date.now() - this.heartbeatStart) / 1000,
        );

        const activitySummary = buildActivitySummary(
          this.agentLog,
          this.lastSnapshotEntryCount,
          elapsed,
        );

        generateHeartbeatMessage(activitySummary, this.previousSnapshots)
          .then(({ update, usage }) => {
            this.latestHeartbeat = update;
            if (usage) this.heartbeatApiCalls.push(usage);
            this.previousSnapshots.push({ activitySummary, update });
            if (this.previousSnapshots.length > 5) {
              this.previousSnapshots.shift();
            }
            this.lastSnapshotEntryCount = this.agentLog.length;
            this.orchestratorPending = false;

            if (update.stop) {
              this.clearInterval();
              log.error(
                `Orchestrator signaled stop in thread ${this.threadTs}: ${update.text}`,
              );
            }

            this.updateHeartbeatSlack(update);
          })
          .catch(() => {
            this.orchestratorPending = false;
          });
      }
    }, HEARTBEAT_TICK_MS);
  }

  /** Clears all timers and pending flushes. Call in a finally block. */
  stop(): void {
    this.clearInterval();
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private clearInterval(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private flushToSlack(): void {
    if (!this.latestStreamText) return;
    const preview = markdownToSlackMrkdwn(this.latestStreamText);
    const truncated =
      preview.length > STREAM_TRUNCATE_LIMIT
        ? preview.slice(0, STREAM_TRUNCATE_LIMIT) +
          "\n\n_...still generating..._"
        : preview;

    const elapsed = Math.round(
      (Date.now() - this.heartbeatStart) / 1000,
    );

    this.client.chat
      .update({
        channel: this.channel,
        ts: this.placeholderTs,
        text: truncated,
        attachments: buildHeartbeatAttachment(this.latestHeartbeat, elapsed),
      })
      .catch((err: unknown) =>
        log.error("Stream update failed", err),
      );

    this.lastFlushTime = Date.now();
  }

  private updateHeartbeatSlack(hb: HeartbeatUpdate): void {
    const elapsed = Math.round(
      (Date.now() - this.heartbeatStart) / 1000,
    );
    this.client.chat
      .update({
        channel: this.channel,
        ts: this.placeholderTs,
        text: this.latestStreamText
          ? markdownToSlackMrkdwn(this.latestStreamText)
          : " ",
        attachments: buildHeartbeatAttachment(hb, elapsed),
      })
      .catch((err: unknown) =>
        log.error("Heartbeat update failed", err),
      );
  }
}
