import type { SpawnSyncReturns } from "node:child_process";
import { describe, it, expect, vi } from "vitest";

// Mock spawnSync for the defaultCreateUserDeps contract test. Must be declared
// before the import of ./create-user.js so vi.hoisted makes it visible there.
const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: mockSpawnSync };
});

import {
  buildSshInvocation,
  createUser,
  DASHBOARD_CONTAINER,
  defaultCreateUserDeps,
  type SshInvocation,
} from "./create-user.js";
import type { DeployConfig } from "./config.js";

function makeConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    name: "gpt",
    region: "us-east-1",
    domain: "example.com",
    hostedZone: "example.com",
    instance: {
      type: "t3.small",
      volumeSize: 20,
      dataVolumeSize: 100,
      sshKey: "/tmp/key.pem",
      sshAllowedCidrs: [],
    },
    aws: { profile: "gpt" },
    ssmPrefix: "/danxbot-gpt",
    claudeAuthDir: "/home/ignored",
    repos: [],
    dashboard: { port: 5555 },
    ...overrides,
  };
}

function okSpawnResult(): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
  } as SpawnSyncReturns<Buffer>;
}

describe("buildSshInvocation", () => {
  it("builds the expected ssh argv with --username at the end", () => {
    const inv = buildSshInvocation("/tmp/key.pem", "1.2.3.4", "alice");
    expect(inv.cmd).toBe("ssh");
    expect(inv.args).toEqual([
      "-i",
      "/tmp/key.pem",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "ubuntu@1.2.3.4",
      "docker",
      "exec",
      "-i",
      DASHBOARD_CONTAINER,
      "npx",
      "tsx",
      "src/cli/create-user.ts",
      "--username",
      "alice",
    ]);
  });

  it("uses `docker exec -i` (keeps stdin open for the password pipe)", () => {
    const inv = buildSshInvocation("/tmp/key.pem", "1.2.3.4", "alice");
    const joinedIdx = inv.args.indexOf("docker");
    expect(inv.args.slice(joinedIdx, joinedIdx + 4)).toEqual([
      "docker",
      "exec",
      "-i",
      DASHBOARD_CONTAINER,
    ]);
  });

  it("rejects usernames that would require shell escaping", () => {
    expect(() => buildSshInvocation("/k", "1.2.3.4", "alice; rm -rf /")).toThrow();
    expect(() => buildSshInvocation("/k", "1.2.3.4", "alice`pwd`")).toThrow();
    expect(() => buildSshInvocation("/k", "1.2.3.4", "alice with spaces")).toThrow();
    expect(() => buildSshInvocation("/k", "1.2.3.4", "ab")).toThrow();
  });
});

describe("createUser orchestration", () => {
  it("passes password+newline via stdin and invokes SSH with correct argv", async () => {
    const config = makeConfig();
    const execSsh = vi.fn().mockReturnValue(okSpawnResult());
    const resolveIp = vi.fn().mockReturnValue("1.2.3.4");
    const readPassword = vi.fn().mockResolvedValue("a-strong-password");

    await createUser(config, "alice", { resolveIp, readPassword, execSsh });

    expect(resolveIp).toHaveBeenCalledOnce();
    expect(readPassword).toHaveBeenCalledOnce();
    expect(execSsh).toHaveBeenCalledOnce();

    const [inv, password] = execSsh.mock.calls[0] as [SshInvocation, string];
    // The CLI orchestrator forwards the password verbatim — the spawnSync layer
    // appends the trailing newline (see defaultCreateUserDeps.execSsh). Tests
    // for newline-on-stdin live in `defaultCreateUserDeps execSsh shape` below.
    expect(password).toBe("a-strong-password");
    expect(inv.cmd).toBe("ssh");
    expect(inv.args).toContain("ubuntu@1.2.3.4");
    expect(inv.args).toContain("--username");
    expect(inv.args[inv.args.length - 1]).toBe("alice");
  });

  it("never embeds the password in the SSH argv (security regression guard)", async () => {
    const config = makeConfig();
    const execSsh = vi.fn().mockReturnValue(okSpawnResult());
    const resolveIp = vi.fn().mockReturnValue("1.2.3.4");
    const readPassword = vi.fn().mockResolvedValue("super-secret-pw-12345");

    await createUser(config, "alice", { resolveIp, readPassword, execSsh });

    const [inv] = execSsh.mock.calls[0] as [SshInvocation, string];
    for (const a of inv.args) {
      expect(a).not.toContain("super-secret-pw-12345");
    }
  });

  it("calls resolveIp BEFORE readPassword (don't make the operator type a password if the box is unreachable)", async () => {
    const config = makeConfig();
    const order: string[] = [];
    const resolveIp = vi.fn(() => {
      order.push("resolveIp");
      return "1.2.3.4";
    });
    const readPassword = vi.fn(async () => {
      order.push("readPassword");
      return "a-strong-password";
    });
    const execSsh = vi.fn(() => {
      order.push("execSsh");
      return okSpawnResult();
    });

    await createUser(config, "alice", { resolveIp, readPassword, execSsh });

    expect(order).toEqual(["resolveIp", "readPassword", "execSsh"]);
  });

  it("throws when the remote command exits non-zero", async () => {
    const config = makeConfig();
    const execSsh = vi.fn().mockReturnValue({
      ...okSpawnResult(),
      status: 1,
    });

    await expect(
      createUser(config, "alice", {
        resolveIp: () => "1.2.3.4",
        readPassword: async () => "a-strong-password",
        execSsh,
      }),
    ).rejects.toThrow(/exit 1/);
  });

  it("throws on invalid username before any SSH or password prompt runs", async () => {
    const config = makeConfig();
    const execSsh = vi.fn();
    const readPassword = vi.fn();
    const resolveIp = vi.fn();

    await expect(
      createUser(config, "bad user!", {
        resolveIp,
        readPassword,
        execSsh,
      }),
    ).rejects.toThrow();

    expect(resolveIp).not.toHaveBeenCalled();
    expect(readPassword).not.toHaveBeenCalled();
    expect(execSsh).not.toHaveBeenCalled();
  });

  it("throws on short password without invoking SSH", async () => {
    const config = makeConfig();
    const execSsh = vi.fn();

    await expect(
      createUser(config, "alice", {
        resolveIp: () => "1.2.3.4",
        readPassword: async () => "short",
        execSsh,
      }),
    ).rejects.toThrow(/12/);

    expect(execSsh).not.toHaveBeenCalled();
  });
});

describe("defaultCreateUserDeps execSsh", () => {
  it("passes `password + \\n` on stdin and pipes stdio correctly", () => {
    mockSpawnSync.mockReturnValue({
      pid: 1,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
    } as SpawnSyncReturns<Buffer>);

    const deps = defaultCreateUserDeps();
    const inv: SshInvocation = { cmd: "ssh", args: ["-x", "host"] };
    deps.execSsh(inv, "pw-12345678");

    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [cmd, args, options] = mockSpawnSync.mock.calls[0] as [
      string,
      string[],
      { input: string; stdio: ["pipe", "inherit", "inherit"] },
    ];
    expect(cmd).toBe("ssh");
    expect(args).toEqual(["-x", "host"]);
    // The trailing newline terminates the remote readline's first-line read.
    // Removing it would hang the remote CLI indefinitely.
    expect(options.input).toBe("pw-12345678\n");
    expect(options.stdio).toEqual(["pipe", "inherit", "inherit"]);
  });
});
