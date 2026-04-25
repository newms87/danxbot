import { describe, it, expect } from "vitest";
import {
  PRUNE_COMMAND,
  pruneStaleDockerImages,
  renderProdCompose,
} from "./compose-infra.js";
import type { RemoteHost } from "./remote.js";

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

  it("mounts per-repo Claude Code JSONL directories under /danxbot/app/claude-projects so the dashboard jsonl-path-resolver can find them", () => {
    const out = renderProdCompose("img", 5555);
    // Per-repo namespaced RO mounts — host shares one physical dir, each repo
    // gets its own container alias so jsonl-path-resolver can resolve paths
    // by repo name. Workers write via `.claude/projects` inside their own
    // containers; dashboard reads via these namespaced aliases.
    expect(out).toContain(
      "/danxbot/claude-projects:/danxbot/app/claude-projects/danxbot:ro",
    );
    expect(out).toContain(
      "/danxbot/claude-projects:/danxbot/app/claude-projects/gpt-manager:ro",
    );
  });
});

describe("pruneStaleDockerImages", () => {
  it("PRUNE_COMMAND prunes ONLY unreferenced images — never volumes, networks, or system-wide", () => {
    // The deploy host runs the dashboard, MySQL, two workers, and Playwright
    // — `system prune` could remove the danxbot-net network mid-deploy and
    // disconnect everything. `--volumes` could nuke the MySQL data volume.
    // Lock the safety surface so a future "be more aggressive" tweak can't
    // silently destroy state without flipping these assertions red.
    expect(PRUNE_COMMAND).toBe("docker image prune -af");
    expect(PRUNE_COMMAND).not.toContain("system");
    expect(PRUNE_COMMAND).not.toContain("--volumes");
    expect(PRUNE_COMMAND).not.toContain("volume");
    expect(PRUNE_COMMAND).not.toContain("network");
  });

  it("issues exactly one sshRunStreaming call with PRUNE_COMMAND", () => {
    // Stub RemoteHost: only the methods pruneStaleDockerImages touches need
    // to be real. Keeps the test hermetic — no SSH process, no network.
    const calls: string[] = [];
    const remote = {
      sshRunStreaming: (cmd: string) => calls.push(cmd),
    } as unknown as RemoteHost;

    pruneStaleDockerImages(remote);

    expect(calls).toEqual([PRUNE_COMMAND]);
  });
});
