import { describe, it, expect } from "vitest";
import { FEATURE_LIST, FEATURE_EXAMPLES } from "./features.js";

describe("features", () => {
  it("FEATURE_LIST covers all capability areas", () => {
    expect(FEATURE_LIST).toContain("Data Lookups");
    expect(FEATURE_LIST).toContain("Schema");
    expect(FEATURE_LIST).toContain("Platform Knowledge");
    expect(FEATURE_LIST).toContain("Database Queries");
  });

  it("FEATURE_EXAMPLES contains specific example questions", () => {
    expect(FEATURE_EXAMPLES).toContain("active campaigns");
    expect(FEATURE_EXAMPLES).toContain("supplier record");
    expect(FEATURE_EXAMPLES).toContain("campaign approval workflow");
  });
});
