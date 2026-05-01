import { describe, it, expect, afterEach } from "vitest";
import { ensureRootUser, buildSshCommand } from "./ensure-root-user.js";
import { setDryRun } from "./exec.js";
import { makeConfig } from "./test-helpers.js";

describe("buildSshCommand", () => {
  // Argv-shape regression guard: the command embeds the key path and IP into
  // an `ssh ... ubuntu@<ip> docker exec ...` chain. Operators copy this
  // string from logs and re-run it, so the spacing + flag order matters.
  it("emits ssh -i <key> ... ubuntu@<ip> docker exec ... npx tsx src/cli/ensure-root-user.ts", () => {
    const cmd = buildSshCommand("/path/to/key.pem", "1.2.3.4");
    expect(cmd).toContain("-i /path/to/key.pem");
    expect(cmd).toContain("-o StrictHostKeyChecking=no");
    expect(cmd).toContain("ubuntu@1.2.3.4");
    expect(cmd).toMatch(/docker exec -i \S+ npx tsx src\/cli\/ensure-root-user\.ts$/);
  });
});

describe("ensureRootUser dry-run", () => {
  afterEach(() => {
    setDryRun(false);
  });

  it("does not invoke the exec callback in dry-run (defense-in-depth — execSync bypasses the exec.ts gate)", async () => {
    // ensureRootUser uses execSync directly, NOT the dry-run-aware
    // runStreaming. The internal isDryRun() guard is the only thing
    // preventing a real SSH attempt against the placeholder IP. Removing
    // either the guard or the callsite gate in cli.ts would silently
    // re-enable real-instance SSH on every dry-run.
    setDryRun(true);
    let execCalled = false;
    await ensureRootUser(makeConfig({ name: "dry-run-target" }), "1.2.3.4", {
      exec: () => {
        execCalled = true;
      },
    });
    expect(execCalled).toBe(false);
  });
});
