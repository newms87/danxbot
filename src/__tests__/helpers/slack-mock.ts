/**
 * Re-export the canonical bolt-WebClient double under its legacy name.
 *
 * The implementation moved to
 * `src/__tests__/integration/helpers/fake-slack-app.ts` so a single source
 * of truth covers BOTH unit tests (this re-export path) and the
 * `slack-agent-e2e` system test (direct import). Anything new should
 * import `createFakeWebClient` from `fake-slack-app.js` directly; this
 * shim exists so the existing `createMockWebClient` call sites in
 * `src/slack/helpers.test.ts` and `src/worker/slack-endpoints.test.ts`
 * keep working without churn. The previous `createMockApp` export was
 * dead code (zero callers) and was dropped.
 */

export { createFakeWebClient as createMockWebClient } from "../integration/helpers/fake-slack-app.js";
