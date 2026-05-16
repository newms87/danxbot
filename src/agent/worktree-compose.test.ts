/**
 * Real-Docker integration tests for the per-worktree consumer-stack
 * lifecycle. Uses a minimal docker-compose.yml that only declares the
 * `alpine:latest` image (already pulled by the host) so the test does
 * not download anything new and exits in seconds.
 *
 * Auto-skips when `docker info` fails.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  provisionConsumerStack,
  teardownConsumerStack,
  composeProjectName,
} from "./worktree-compose.js";

const execFile = promisify(execFileCb);

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function listProjectContainers(project: string): Promise<string[]> {
  try {
    const { stdout } = await execFile("docker", [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.Names}}",
    ]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

// Compose file with one tiny service that loops forever. No build, no
// volume, no port binding — the only assertion is that the service
// container exists and is running after `up`, gone after `down`.
const TINY_COMPOSE = `
services:
  smoke:
    image: alpine:latest
    container_name: \${COMPOSE_PROJECT_NAME}_smoke
    command: ["sh","-c","while true; do sleep 30; done"]
`;

let workArea: string;
let worktreePath: string;
let projectName: string;

const dockerOk = await dockerAvailable();
const describeIfDocker = dockerOk ? describe : describe.skip;

describeIfDocker("provisionConsumerStack / teardownConsumerStack", () => {
  beforeAll(() => {
    workArea = mkdtempSync(join(tmpdir(), "worktree-compose-test-"));
    worktreePath = join(workArea, "worktree");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "docker-compose.yml"), TINY_COMPOSE);
    writeFileSync(join(worktreePath, ".env"), "");
    projectName = composeProjectName(`test-${process.pid}`, "alice");
  });

  afterAll(async () => {
    try {
      await teardownConsumerStack({
        worktreePath,
        repoName: `test-${process.pid}`,
        worktreeName: "alice",
      });
    } catch {}
    rmSync(workArea, { recursive: true, force: true });
  });

  it("composeProjectName composes danxbot-<repo>-<agent> deterministically", () => {
    expect(composeProjectName("gpt-manager", "harry")).toBe(
      "danxbot-gpt-manager-harry",
    );
    expect(composeProjectName("DanxBot", "Harry-1")).toBe(
      "danxbot-danxbot-harry-1",
    );
  });

  it("skips silently when worktreePath has no docker-compose.yml", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-compose-"));
    const result = await provisionConsumerStack({
      worktreePath: empty,
      repoName: "no-compose-repo",
      worktreeName: "ghost",
    });
    expect(result.kind).toBe("skipped");
    rmSync(empty, { recursive: true, force: true });
  });

  it("up: container is running after provision; down: container is gone", async () => {
    const upResult = await provisionConsumerStack({
      worktreePath,
      repoName: `test-${process.pid}`,
      worktreeName: "alice",
    });
    expect(upResult.kind).toBe("provisioned");
    if (upResult.kind !== "provisioned") return;
    expect(upResult.projectName).toBe(projectName);

    const containers = await listProjectContainers(projectName);
    expect(containers.some((c) => c.includes("smoke"))).toBe(true);

    const downResult = await teardownConsumerStack({
      worktreePath,
      repoName: `test-${process.pid}`,
      worktreeName: "alice",
    });
    expect(downResult.kind).toBe("torn-down");

    const after = await listProjectContainers(projectName);
    expect(after).toEqual([]);
  });

  it("provision is idempotent — second up against running stack returns provisioned", async () => {
    await provisionConsumerStack({
      worktreePath,
      repoName: `test-${process.pid}`,
      worktreeName: "alice",
    });
    const again = await provisionConsumerStack({
      worktreePath,
      repoName: `test-${process.pid}`,
      worktreeName: "alice",
    });
    expect(again.kind).toBe("provisioned");
    // Cleanup
    await teardownConsumerStack({
      worktreePath,
      repoName: `test-${process.pid}`,
      worktreeName: "alice",
    });
  });

  it("teardown is idempotent — second down against gone stack returns torn-down", async () => {
    const r = await teardownConsumerStack({
      worktreePath,
      repoName: `test-${process.pid}`,
      worktreeName: "alice",
    });
    expect(r.kind).toBe("torn-down");
  });
});
