/**
 * Fake `@slack/bolt` `App` + `WebClient` double.
 *
 * Single source of truth for the bolt double across the test suite. Replaces:
 *   - The inline `vi.mock("@slack/bolt", ...)` block at `src/slack/listener.test.ts`.
 *   - The `createMockWebClient` / `createMockApp` helpers in `src/__tests__/helpers/slack-mock.ts`.
 *
 * Three responsibilities (per Trello CudG7AJy):
 *
 *   1. Receive injection. The fake App captures the handler registered via
 *      `app.message(handler)`. Tests fire it via `injectMessage(...)` (or the
 *      lower-level `getMessageHandler()` for tests that already have a client
 *      they want to thread in).
 *
 *   2. Send capture. The `client` object exposes the real-world surface used
 *      by the listener and the worker's slack endpoints — `chat.postMessage`,
 *      `chat.update`, `reactions.add`, `reactions.remove`, `conversations.replies`,
 *      `filesUploadV2`, and `auth.test`. Each is a `vi.fn()` returning a canned
 *      shape so tests can inspect `.mock.calls` without extra setup.
 *
 *   3. Cross-repo addressability. `startSlackListener(repo)` (the real function)
 *      already maps `repo.name → ListenerState` in the real `listeners` registry,
 *      so the cross-worker guard test can call it with repo A then repo B and
 *      retrieve the matching fake App via `getFakeAppByOrder(i)` or
 *      `getLatestFakeApp()`. No parallel registry needed.
 *
 * Use it by mocking `@slack/bolt` in the test file:
 *
 *   import { installSlackBoltMock, getLatestFakeApp, resetFakeAppRegistry }
 *     from "../__tests__/integration/helpers/fake-slack-app.js";
 *
 *   vi.mock("@slack/bolt", () => installSlackBoltMock());
 *
 *   beforeEach(() => {
 *     resetFakeAppRegistry();
 *   });
 */

import { vi, type Mock } from "vitest";

// `Mock<...>` with an explicit callable signature so consumers like
// `client.chat.postMessage({})` and `.mockRejectedValueOnce(...)` typecheck
// without each call-site having to cast. Bare `ReturnType<typeof vi.fn>`
// resolves to `Mock<Procedure | Constructable>`, which is NOT callable
// per TS2348.
type AnyMock = Mock<(...args: unknown[]) => unknown>;

export interface FakeWebClient {
  auth: { test: AnyMock };
  chat: {
    postMessage: AnyMock;
    update: AnyMock;
  };
  reactions: {
    add: AnyMock;
    remove: AnyMock;
  };
  conversations: {
    replies: AnyMock;
  };
  filesUploadV2: AnyMock;
}

export type SlackMessageHandlerArgs = {
  message: Record<string, unknown>;
  client: FakeWebClient;
};

export type SlackMessageHandler = (
  args: SlackMessageHandlerArgs,
) => Promise<void> | void;

export interface InjectMessageOptions {
  channel: string;
  text?: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * Build a fresh fake bolt `WebClient` with vi.fn() shims on every method the
 * listener + worker slack endpoints touch. Resolves shape-correctly so the
 * listener never has to defensive-check responses; tests override per-call
 * via `mockResolvedValueOnce` / `mockRejectedValueOnce` when they need
 * specific response bodies or failures.
 */
export function createFakeWebClient(): FakeWebClient {
  return {
    auth: {
      test: vi.fn().mockResolvedValue({ user_id: "BOT_USER_ID" }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "mock-ts" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
    filesUploadV2: vi.fn().mockResolvedValue({}),
  };
}

/**
 * Module-level registry of every `FakeSlackApp` instance constructed since
 * the last `resetFakeAppRegistry()` call. Insertion-ordered so tests that
 * call `startSlackListener(repoA)` then `startSlackListener(repoB)` can
 * grab `getFakeAppByOrder(0)` and `getFakeAppByOrder(1)`.
 *
 * The simpler `getLatestFakeApp()` covers the single-repo case (the one
 * `listener.test.ts` exercises).
 */
const fakeAppsByOrder: FakeSlackApp[] = [];

export class FakeSlackApp {
  client: FakeWebClient = createFakeWebClient();
  start = vi.fn().mockResolvedValue(undefined);
  private handler: SlackMessageHandler | undefined;

  constructor() {
    fakeAppsByOrder.push(this);
  }

  message(handler: SlackMessageHandler): void {
    this.handler = handler;
  }

  /**
   * Returns the registered message handler, or undefined if `app.message(...)`
   * has not been called yet (i.e. `startSlackListener(repo)` hasn't run).
   */
  getMessageHandler(): SlackMessageHandler | undefined {
    return this.handler;
  }

  /**
   * Fire the registered message handler with a synthesized Slack message.
   * Throws (loudly) when no handler has been registered yet — silently
   * dropping the inject is a classic source of silent test failures.
   */
  async injectMessage(opts: InjectMessageOptions): Promise<void> {
    if (!this.handler) {
      throw new Error(
        "FakeSlackApp.injectMessage: no message handler registered. " +
          "Did you call startSlackListener(repo) before injecting?",
      );
    }
    const message: Record<string, unknown> = {
      type: "message",
      channel: opts.channel,
      ts: opts.ts,
      text: opts.text,
      user: opts.user ?? "U-HUMAN",
    };
    if (opts.thread_ts !== undefined) message.thread_ts = opts.thread_ts;
    if (opts.bot_id !== undefined) message.bot_id = opts.bot_id;
    if (opts.subtype !== undefined) message.subtype = opts.subtype;
    await this.handler({ message, client: this.client });
  }

  /**
   * Convenience wrapper for thread replies — auto-fills `thread_ts` from the
   * first arg and synthesizes a fresh per-message timestamp so the queue test
   * can fire two distinct messages on the same thread without tracking
   * timestamps in the test body.
   */
  async injectThreadReply(
    threadTs: string,
    opts: Omit<InjectMessageOptions, "thread_ts">,
  ): Promise<void> {
    await this.injectMessage({ ...opts, thread_ts: threadTs });
  }
}

export function getFakeAppByOrder(idx: number): FakeSlackApp | undefined {
  return fakeAppsByOrder[idx];
}

export function getLatestFakeApp(): FakeSlackApp | undefined {
  if (fakeAppsByOrder.length === 0) return undefined;
  return fakeAppsByOrder[fakeAppsByOrder.length - 1];
}

export function getFakeAppCount(): number {
  return fakeAppsByOrder.length;
}

export function resetFakeAppRegistry(): void {
  fakeAppsByOrder.length = 0;
}

/**
 * Returns the module-replacement object for `vi.mock("@slack/bolt", ...)`.
 * Wrapping the export in a function (rather than exporting a literal) keeps
 * the factory shape on one line at the call site:
 *
 *   vi.mock("@slack/bolt", () => installSlackBoltMock());
 */
export function installSlackBoltMock(): { App: typeof FakeSlackApp } {
  return { App: FakeSlackApp };
}
