import { describe, it, expect } from "vitest";
import { renderProdCompose } from "./compose-infra.js";

describe("renderProdCompose", () => {
  it("substitutes ECR image and dashboard port", () => {
    const out = renderProdCompose(
      "123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production:latest",
      5555,
    );
    expect(out).toContain(
      "image: 123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production:latest",
    );
    expect(out).toMatch(/"5555:5555"/);
    expect(out).toMatch(/localhost:5555\/health/);
    expect(out).not.toContain("${ECR_IMAGE}");
    expect(out).not.toContain("${DASHBOARD_PORT}");
  });

  it("preserves ${DANXBOT_DB_*} vars (those are resolved by compose at runtime from /danxbot/.env)", () => {
    const out = renderProdCompose("any-image", 5555);
    expect(out).toContain("${DANXBOT_DB_PASSWORD}");
    expect(out).toContain("${DANXBOT_DB_USER}");
  });

  it("substitutes dashboard port on both the host-port mapping and the healthcheck URL", () => {
    const out = renderProdCompose("img", 9000);
    expect(out).toContain('"9000:9000"');
    expect(out).toContain("localhost:9000/health");
  });
});
