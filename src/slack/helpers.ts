import type { SlackBoltClient } from "./types.js";

/**
 * Swaps one reaction for another on a message.
 * Both operations are fire-and-forget (errors are silently ignored).
 */
export async function swapReaction(
  client: SlackBoltClient,
  channel: string,
  timestamp: string,
  remove: string,
  add: string,
): Promise<void> {
  await client.reactions
    .remove({ channel, timestamp, name: remove })
    .catch(() => {});
  await client.reactions
    .add({ channel, timestamp, name: add })
    .catch(() => {});
}
