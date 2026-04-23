/**
 * Budget tracker for validation tests that use real Claude API calls.
 * Throws if cumulative cost exceeds the ceiling.
 */
export class BudgetTracker {
  private spent = 0;
  private ceiling: number;

  constructor(ceilingUsd = 2.0) {
    this.ceiling = ceilingUsd;
  }

  add(costUsd: number): void {
    this.spent += costUsd;
    if (this.spent > this.ceiling) {
      throw new Error(
        `Budget exceeded: $${this.spent.toFixed(4)} spent, ceiling is $${this.ceiling.toFixed(2)}`,
      );
    }
  }

  get total(): number {
    return this.spent;
  }
}

/**
 * Returns true if the ANTHROPIC_API_KEY env var is set.
 * Use with describe.skipIf(!hasApiKey()) to safely skip in CI.
 */
export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
