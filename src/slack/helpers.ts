import type { WebClient } from "@slack/web-api";
import type { HeartbeatUpdate } from "../types.js";

/**
 * Builds the Slack attachment structure used for heartbeat status updates.
 */
export function buildHeartbeatAttachment(
  hb: HeartbeatUpdate,
  elapsedSeconds: number,
) {
  return [
    {
      color: hb.color,
      blocks: [
        {
          type: "context" as const,
          elements: [
            {
              type: "mrkdwn" as const,
              text: `${hb.emoji} *${hb.text}* (${elapsedSeconds}s)`,
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Swaps one reaction for another on a message.
 * Both operations are fire-and-forget (errors are silently ignored).
 */
export async function swapReaction(
  client: WebClient,
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

/**
 * Updates a placeholder message with an error-style attachment.
 * Used for timeout, crash, and orchestrator-stop scenarios.
 */
export async function postErrorAttachment(
  client: WebClient,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  await client.chat.update({
    channel,
    ts,
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
                text,
              },
            ],
          },
        ],
      },
    ],
  });
}
