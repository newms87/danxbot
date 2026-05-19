import { afterEach } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";

// Stub backend-required env vars so dashboard tests that pull modules
// from `@backend/*` (e.g. `effort-levels-lockstep.test.ts` importing
// `@backend/settings-file.js`) don't trip `src/env.ts#requireEnv` at
// import time. Values are dummies — no test exercises real DB / API
// behavior through this path. Set conditionally so a real env doesn't
// get clobbered.
for (const k of [
  "DANXBOT_DB_USER",
  "DANXBOT_DB_PASSWORD",
  "DANXBOT_DB_HOST",
  "DANXBOT_DB_NAME",
  "DANXBOT_DB_PORT",
  "ANTHROPIC_API_KEY",
]) {
  if (!process.env[k]) process.env[k] = "test_stub";
}

// Auto-unmount any wrapper a test mounted, even when the test throws or
// times out before reaching its own `w.unmount()`. Prevents leaked
// `onMounted`/`onUnmounted` side-effects (window event listeners, watch
// callbacks tied to module-scoped refs) from cascading into later tests in
// the same file. DX-253 root-caused App.test.ts's flake to this: under the
// full suite the first dynamic `import("./App.vue")` blew past the default
// 5s timeout, test 1's mount leaked, and every subsequent test in the file
// saw the prior mount's listeners fire on top of its own.
enableAutoUnmount(afterEach);
