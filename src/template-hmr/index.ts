/**
 * SG-189 — public API for the template-hmr module.
 *
 * Consumers:
 *   - `dispatch/core.ts` calls the lifecycle pair on spawn + terminal.
 *   - `worker/template-hmr-route.ts` reads `getActiveHmr` for the
 *     `/api/template-hmr/active` route.
 *   - `worker/server.ts` invokes `shutdownAllHmr` on SIGTERM/SIGINT.
 */

// Public surface — only what dispatch/core.ts, worker/template-hmr-route.ts,
// shutdown.ts, and tests actually need. `pickFreePort` + the raw test-only
// hooks stay imported from their source files (./server.js) for the test
// suite — not part of the consumer-facing API.
export {
  getActiveHmr,
  listActiveHmr,
  shutdownAllHmr,
  type HmrServerInfo,
} from "./server.js";
export {
  startTemplateHmrForDispatch,
  stopTemplateHmrForDispatch,
  type StartLifecycleOptions,
} from "./lifecycle.js";
