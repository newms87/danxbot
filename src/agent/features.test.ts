import { describe, it, expect } from "vitest";
import { FEATURE_LIST, FEATURE_EXAMPLES } from "./features.js";

describe("features", () => {
  it("FEATURE_LIST covers all capability areas", () => {
    expect(FEATURE_LIST).toContain("Data Lookups");
    expect(FEATURE_LIST).toContain("Schema");
    expect(FEATURE_LIST).toContain("Codebase Knowledge");
    expect(FEATURE_LIST).toContain("Database Queries");
    expect(FEATURE_LIST).toContain("Feature Requests");
  });

  it("FEATURE_EXAMPLES contains specific example questions", () => {
    expect(FEATURE_EXAMPLES).toContain("active records");
    expect(FEATURE_EXAMPLES).toContain("approval workflow");
    expect(FEATURE_EXAMPLES).toContain("billing process");
  });
});
