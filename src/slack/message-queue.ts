/**
 * Per-thread message queue for the Slack listener.
 *
 * When an agent is already running for a thread, incoming messages are queued
 * and processed sequentially after the current agent completes.
 */

export interface QueuedMessage {
  threadTs: string;
  messageTs: string;
  channelId: string;
  userId: string;
  text: string;
  queuedAt: number;
}

/** Per-thread queues. Key is threadTs. */
const queues = new Map<string, QueuedMessage[]>();

/** Threads that currently have an agent running. */
const processing = new Set<string>();

/**
 * Returns true if an agent is currently running for the given thread.
 */
export function isProcessing(threadTs: string): boolean {
  return processing.has(threadTs);
}

/**
 * Marks a thread as having an agent running.
 * Call this before starting the agent for a thread.
 */
export function markProcessing(threadTs: string): void {
  processing.add(threadTs);
}

/**
 * Marks a thread as no longer having an agent running.
 * Call this after the agent finishes (success or error).
 */
export function markIdle(threadTs: string): void {
  processing.delete(threadTs);
}

/**
 * Enqueues a message for later processing.
 */
export function enqueue(message: QueuedMessage): void {
  const queue = queues.get(message.threadTs);
  if (queue) {
    queue.push(message);
  } else {
    queues.set(message.threadTs, [message]);
  }
}

/**
 * Dequeues the next message for a thread, if any.
 * Returns undefined if the queue is empty.
 */
export function dequeue(threadTs: string): QueuedMessage | undefined {
  const queue = queues.get(threadTs);
  if (!queue || queue.length === 0) {
    queues.delete(threadTs);
    return undefined;
  }
  const message = queue.shift()!;
  if (queue.length === 0) {
    queues.delete(threadTs);
  }
  return message;
}

/**
 * Returns the number of queued messages for a thread.
 */
export function queueSize(threadTs: string): number {
  return queues.get(threadTs)?.length ?? 0;
}

/**
 * Returns a snapshot of all queue sizes, keyed by threadTs.
 * Used for dashboard observability.
 */
export function getQueueStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const [threadTs, queue] of queues) {
    stats[threadTs] = queue.length;
  }
  return stats;
}

/**
 * Returns the total number of queued messages across all threads.
 */
export function getTotalQueuedCount(): number {
  let total = 0;
  for (const queue of queues.values()) {
    total += queue.length;
  }
  return total;
}

/**
 * Resets all queue and processing state. Exported for test isolation only.
 */
export function resetQueue(): void {
  queues.clear();
  processing.clear();
}
