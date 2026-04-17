import { describe, it, expect } from "vitest";
import { getBackendConfig } from "./bootstrap.js";
import { makeConfig } from "./test-helpers.js";

describe("bootstrap backend config", () => {
  it("scopes bucket + lock table per deployment name", () => {
    const backend = getBackendConfig(
      makeConfig({ name: "danxbot-production" }),
    );
    expect(backend.bucket).toBe("danxbot-production-terraform-state");
    expect(backend.dynamodbTable).toBe("danxbot-production-terraform-locks");
    expect(backend.key).toBe("danxbot/terraform.tfstate");
  });

  it("propagates region from config", () => {
    const backend = getBackendConfig(makeConfig({ region: "eu-west-1" }));
    expect(backend.region).toBe("eu-west-1");
  });

  it("enables encryption", () => {
    const backend = getBackendConfig(makeConfig());
    expect(backend.encrypt).toBe(true);
  });

  it("isolates buckets between differently-named deployments", () => {
    const gpt = getBackendConfig(makeConfig({ name: "gpt-deploy" }));
    const fly = getBackendConfig(makeConfig({ name: "flytedesk-deploy" }));
    expect(gpt.bucket).not.toBe(fly.bucket);
    expect(gpt.dynamodbTable).not.toBe(fly.dynamodbTable);
  });
});
