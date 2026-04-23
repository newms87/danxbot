import { describe, it, expect } from "vitest";
import { swapReaction } from "./helpers.js";
import { createMockWebClient } from "../__tests__/helpers/slack-mock.js";
import type { SlackBoltClient } from "./types.js";

describe("swapReaction", () => {
  it("removes the old reaction and adds the new one", async () => {
    const client = createMockWebClient() as unknown as SlackBoltClient;
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
      swapReaction(client as unknown as SlackBoltClient, "C1", "ts1", "old", "new"),
    ).resolves.toBeUndefined();

    expect(client.reactions.add).toHaveBeenCalled();
  });

  it("silently ignores errors from reactions.add", async () => {
    const client = createMockWebClient();
    client.reactions.add.mockRejectedValue(new Error("too_many_reactions"));

    await expect(
      swapReaction(client as unknown as SlackBoltClient, "C1", "ts1", "old", "new"),
    ).resolves.toBeUndefined();
  });
});
