import { describe, it, expect, beforeAll } from "vitest";
import { BudgetTracker, hasApiKey } from "./setup.js";
import { makeRepoContext } from "../helpers/fixtures.js";

const budget = new BudgetTracker(2.0);
let savedSessionId: string | null = null;

const MOCK_REPO_CONTEXT = makeRepoContext();

describe.skipIf(!hasApiKey())("validation: real Claude API", () => {
  let runRouter: typeof import("../../agent/router.js").runRouter;
  let runAgent: typeof import("../../agent/agent.js").runAgent;

  beforeAll(async () => {
    // Import real modules (no mocks for Anthropic SDK)
    const router = await import("../../agent/router.js");
    const agent = await import("../../agent/agent.js");
    runRouter = router.runRouter;
    runAgent = agent.runAgent;
  });

  it("routes a simple greeting without needing agent", async () => {
    const result = await runRouter("Hey, how are you?");

    expect(result.needsAgent).toBe(false);
    expect(result.quickResponse).toBeTruthy();
    // Router calls are near-zero cost (Haiku)
    budget.add(0.001);
  }, 30000);

  it("routes a code question then runs agent", async () => {
    const routerResult = await runRouter(
      "How does the FilterBuilder macro work in the platform?",
    );
    budget.add(0.001);

    expect(routerResult.needsAgent).toBe(true);

    const agentResult = await runAgent(
      MOCK_REPO_CONTEXT,
      "How does the FilterBuilder macro work in the platform?",
      null,
    );

    expect(agentResult.text).toBeTruthy();
    expect(agentResult.text.length).toBeGreaterThan(50);
    expect(agentResult.sessionId).toBeTruthy();
    budget.add(agentResult.subscriptionCostUsd);

    // Save for session resumption test
    savedSessionId = agentResult.sessionId;
  }, 120000);

  it("resumes a session for thread follow-up", async () => {
    // Skip if previous test didn't produce a session
    if (!savedSessionId) return;

    const result = await runAgent(
      MOCK_REPO_CONTEXT,
      "Can you show me a specific example of how it's used?",
      savedSessionId,
    );

    expect(result.text).toBeTruthy();
    budget.add(result.subscriptionCostUsd);

    // Cumulative cost should be under $2
    expect(budget.total).toBeLessThan(2.0);
  }, 120000);
});
