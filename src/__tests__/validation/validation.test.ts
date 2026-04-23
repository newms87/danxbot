import { describe, it, expect } from "vitest";
import { BudgetTracker, hasApiKey } from "./setup.js";

const budget = new BudgetTracker(2.0);

describe.skipIf(!hasApiKey())("validation: real Claude API", () => {
  it("routes a simple greeting without needing agent", async () => {
    const { runRouter } = await import("../../agent/router.js");
    const result = await runRouter("Hey, how are you?");

    expect(result.needsAgent).toBe(false);
    expect(result.quickResponse).toBeTruthy();
    // Router calls are near-zero cost (Haiku)
    budget.add(0.001);
  }, 30000);

  it("routes a code question to the agent (without actually running it)", async () => {
    const { runRouter } = await import("../../agent/router.js");
    const routerResult = await runRouter(
      "How does the FilterBuilder macro work in the platform?",
    );
    budget.add(0.001);

    // The deep-agent path is dispatch-based (src/slack/listener.ts), covered
    // by dispatch-validation.test.ts. This suite only validates the router.
    expect(routerResult.needsAgent).toBe(true);
    expect(budget.total).toBeLessThan(2.0);
  }, 30000);
});
