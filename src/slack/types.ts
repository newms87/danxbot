import type { App } from "@slack/bolt";

/**
 * The bolt App's web client — the exact client type bolt exposes at
 * `app.client`. Equivalent to `WebClient` from `@slack/web-api` but anchored
 * to whatever bolt is actually constructing, so if bolt ever swaps its client
 * type the consumers here move with it automatically.
 *
 * Use this (not `WebClient`) in Slack listener / worker handlers that accept
 * a client derived from an `App` — that's every path since the listener is
 * the only client factory.
 */
export type SlackBoltClient = App["client"];
