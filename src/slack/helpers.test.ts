import { describe, it, expect, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { buildHeartbeatAttachment, swapReaction, postErrorAttachment } from "./helpers.js";
import { createMockWebClient } from "../__tests__/helpers/slack-mock.js";
import type { HeartbeatUpdate } from "../types.js";

describe("buildHeartbeatAttachment", () => {
  it("returns an array with one attachment", () => {
    const hb: HeartbeatUpdate = { emoji: ":mag:", color: "#36a64f", text: "Searching", stop: false };
    const result = buildHeartbeatAttachment(hb, 12);

    expect(result).toHaveLength(1);
  });

  it("uses the heartbeat color", () => {
    const hb: HeartbeatUpdate = { emoji: ":mag:", color: "#ff0000", text: "Searching", stop: false };
    const result = buildHeartbeatAttachment(hb, 5);

    expect(result[0].color).toBe("#ff0000");
  });

  it("has a context block with mrkdwn element", () => {
    const hb: HeartbeatUpdate = { emoji: ":mag:", color: "#36a64f", text: "Searching", stop: false };
    const result = buildHeartbeatAttachment(hb, 10);

    expect(result[0].blocks).toHaveLength(1);
    expect(result[0].blocks[0].type).toBe("context");
    expect(result[0].blocks[0].elements).toHaveLength(1);
    expect(result[0].blocks[0].elements[0].type).toBe("mrkdwn");
  });

  it("formats text with emoji, bold text, and elapsed seconds", () => {
    const hb: HeartbeatUpdate = { emoji: ":hourglass:", color: "#ccc", text: "Processing", stop: false };
    const result = buildHeartbeatAttachment(hb, 42);

    expect(result[0].blocks[0].elements[0].text).toBe(":hourglass: *Processing* (42s)");
  });
});

describe("swapReaction", () => {
  it("removes the old reaction and adds the new one", async () => {
    const client = createMockWebClient() as unknown as WebClient;
    await swapReaction(client, "C123", "1234.5678", "eyes", "white_check_mark");

    expect((client as any).reactions.remove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "eyes",
    });
    expect((client as any).reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "white_check_mark",
    });
  });

  it("silently ignores errors from reactions.remove", async () => {
    const client = createMockWebClient();
    client.reactions.remove.mockRejectedValue(new Error("already_reacted"));

    await expect(
      swapReaction(client as unknown as WebClient, "C1", "ts1", "old", "new"),
    ).resolves.toBeUndefined();

    expect(client.reactions.add).toHaveBeenCalled();
  });

  it("silently ignores errors from reactions.add", async () => {
    const client = createMockWebClient();
    client.reactions.add.mockRejectedValue(new Error("too_many_reactions"));

    await expect(
      swapReaction(client as unknown as WebClient, "C1", "ts1", "old", "new"),
    ).resolves.toBeUndefined();
  });
});

describe("postErrorAttachment", () => {
  it("calls chat.update with error-colored attachment", async () => {
    const client = createMockWebClient();
    await postErrorAttachment(client as unknown as WebClient, "C123", "1234.5678", "Something went wrong");

    expect(client.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1234.5678",
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
                  text: "Something went wrong",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("uses the provided text in the mrkdwn element", async () => {
    const client = createMockWebClient();
    await postErrorAttachment(client as unknown as WebClient, "C1", "ts1", "Timeout after 120s");

    const call = client.chat.update.mock.calls[0][0] as any;
    expect(call.attachments[0].blocks[0].elements[0].text).toBe("Timeout after 120s");
  });
});
