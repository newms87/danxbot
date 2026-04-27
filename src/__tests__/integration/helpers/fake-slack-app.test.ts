import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FakeSlackApp,
  createFakeWebClient,
  getFakeAppByOrder,
  getFakeAppCount,
  getLatestFakeApp,
  installSlackBoltMock,
  resetFakeAppRegistry,
} from "./fake-slack-app.js";

describe("createFakeWebClient", () => {
  it("returns a client whose chat/reactions/conversations/filesUploadV2/auth methods are vi.fn() shims with sane resolved defaults", async () => {
    const client = createFakeWebClient();

    await expect(client.chat.postMessage({})).resolves.toEqual({ ts: "mock-ts" });
    await expect(client.chat.update({})).resolves.toEqual({});
    await expect(client.reactions.add({})).resolves.toEqual({});
    await expect(client.reactions.remove({})).resolves.toEqual({});
    await expect(client.conversations.replies({})).resolves.toEqual({ messages: [] });
    await expect(client.filesUploadV2({})).resolves.toEqual({});
    await expect(client.auth.test()).resolves.toEqual({ user_id: "BOT_USER_ID" });
  });

  it("returns independent clients per call (no shared spy state)", () => {
    const a = createFakeWebClient();
    const b = createFakeWebClient();
    a.chat.postMessage({ channel: "C-A", text: "from A" });

    expect(a.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(b.chat.postMessage).toHaveBeenCalledTimes(0);
  });

  it("supports per-test override via mockRejectedValueOnce on individual methods", async () => {
    const client = createFakeWebClient();
    client.reactions.remove.mockRejectedValueOnce(new Error("already_reacted"));

    await expect(client.reactions.remove({})).rejects.toThrow("already_reacted");
    // Subsequent calls revert to the default resolved value.
    await expect(client.reactions.remove({})).resolves.toEqual({});
  });
});

describe("FakeSlackApp", () => {
  beforeEach(() => {
    resetFakeAppRegistry();
  });

  it("registers itself in the insertion-ordered registry on construction", () => {
    expect(getFakeAppCount()).toBe(0);
    const a = new FakeSlackApp();
    const b = new FakeSlackApp();

    expect(getFakeAppCount()).toBe(2);
    expect(getFakeAppByOrder(0)).toBe(a);
    expect(getFakeAppByOrder(1)).toBe(b);
    expect(getLatestFakeApp()).toBe(b);
  });

  it("captures the handler registered via app.message(handler) and exposes it via getMessageHandler()", () => {
    const app = new FakeSlackApp();
    expect(app.getMessageHandler()).toBeUndefined();

    const fn = vi.fn();
    app.message(fn);

    expect(app.getMessageHandler()).toBe(fn);
  });

  it("injectMessage fires the registered handler with a synthesized message + the fake client", async () => {
    const app = new FakeSlackApp();
    const handler = vi.fn();
    app.message(handler);

    await app.injectMessage({
      channel: "C-TEST",
      ts: "111.222",
      text: "hello",
      user: "U-1",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const callArg = handler.mock.calls[0][0];
    expect(callArg.message).toMatchObject({
      type: "message",
      channel: "C-TEST",
      ts: "111.222",
      text: "hello",
      user: "U-1",
    });
    expect(callArg.client).toBe(app.client);
  });

  it("injectMessage omits thread_ts/bot_id/subtype when the caller doesn't supply them (matches real bolt-side payload shape)", async () => {
    const app = new FakeSlackApp();
    const handler = vi.fn();
    app.message(handler);

    await app.injectMessage({ channel: "C-X", ts: "1.1", text: "x" });

    const msg = handler.mock.calls[0][0].message;
    expect(msg).not.toHaveProperty("thread_ts");
    expect(msg).not.toHaveProperty("bot_id");
    expect(msg).not.toHaveProperty("subtype");
  });

  it("injectThreadReply auto-fills thread_ts from its first arg", async () => {
    const app = new FakeSlackApp();
    const handler = vi.fn();
    app.message(handler);

    await app.injectThreadReply("PARENT.TS", {
      channel: "C-TEST",
      ts: "REPLY.TS",
      text: "follow-up",
    });

    const msg = handler.mock.calls[0][0].message;
    expect(msg.thread_ts).toBe("PARENT.TS");
    expect(msg.ts).toBe("REPLY.TS");
  });

  it("injectMessage throws loudly when no handler has been registered yet (silent drops are forbidden)", async () => {
    const app = new FakeSlackApp();
    await expect(
      app.injectMessage({ channel: "C", ts: "1", text: "x" }),
    ).rejects.toThrow(/no message handler registered/);
  });
});

describe("installSlackBoltMock", () => {
  beforeEach(() => {
    resetFakeAppRegistry();
  });

  it("returns { App } where instances of App are FakeSlackApp", () => {
    const mod = installSlackBoltMock();
    const instance = new mod.App();
    expect(instance).toBeInstanceOf(FakeSlackApp);
    expect(getLatestFakeApp()).toBe(instance);
  });
});

describe("resetFakeAppRegistry", () => {
  beforeEach(() => {
    resetFakeAppRegistry();
  });

  it("clears the registry so a previous test's fake App can't leak into the next", () => {
    new FakeSlackApp();
    new FakeSlackApp();
    expect(getFakeAppCount()).toBe(2);

    resetFakeAppRegistry();
    expect(getFakeAppCount()).toBe(0);
    expect(getLatestFakeApp()).toBeUndefined();
  });
});
