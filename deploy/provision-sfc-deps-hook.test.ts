import { describe, it, expect, vi } from "vitest";
import { provisionSfcDepsOnHost } from "./provision-sfc-deps-hook.js";

function fakeRemote() {
  return {
    calls: { scp: [] as Array<[string, string]>, ssh: [] as string[] },
    scpUpload: vi.fn(function (this: { calls: any }, local: string, remote: string) {
      // bound below
      (this as any).calls.scp.push([local, remote]);
    }),
    sshRun: vi.fn(() => ""),
    sshRunStreaming: vi.fn(function (this: { calls: any }, cmd: string) {
      (this as any).calls.ssh.push(cmd);
    }),
  };
}

describe("provisionSfcDepsOnHost", () => {
  it("scps the hook + ssh-runs it via bash", () => {
    const calls = { scp: [] as Array<[string, string]>, ssh: [] as string[] };
    const remote = {
      scpUpload: (local: string, rem: string) => calls.scp.push([local, rem]),
      sshRun: () => "",
      sshRunStreaming: (cmd: string) => calls.ssh.push(cmd),
    };
    provisionSfcDepsOnHost(remote, {
      hookLocalPath: "/repo/deploy/hooks/post-deploy-provision-deps.sh",
      hookRemotePath: "/tmp/post-deploy-provision-deps.sh",
    });
    expect(calls.scp).toEqual([
      [
        "/repo/deploy/hooks/post-deploy-provision-deps.sh",
        "/tmp/post-deploy-provision-deps.sh",
      ],
    ]);
    expect(calls.ssh).toEqual(["bash /tmp/post-deploy-provision-deps.sh"]);
  });

  it("dry-run: emits planned action but does not touch the remote", () => {
    const calls = { scp: [] as Array<[string, string]>, ssh: [] as string[] };
    const remote = {
      scpUpload: (local: string, rem: string) => calls.scp.push([local, rem]),
      sshRun: () => "",
      sshRunStreaming: (cmd: string) => calls.ssh.push(cmd),
    };
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    (process.stdout.write as any) = (chunk: string) => {
      writes.push(chunk);
      return true;
    };
    try {
      provisionSfcDepsOnHost(remote, {
        hookLocalPath: "/repo/deploy/hooks/post-deploy-provision-deps.sh",
        hookRemotePath: "/tmp/post-deploy-provision-deps.sh",
        dryRun: true,
      });
    } finally {
      (process.stdout.write as any) = origWrite;
    }
    expect(calls.scp).toEqual([]);
    expect(calls.ssh).toEqual([]);
    expect(writes.join("")).toContain("dry-run");
  });

  it("refuses an unsafe remoteHook path (defense in depth against shell injection)", () => {
    const remote = {
      scpUpload: () => {},
      sshRun: () => "",
      sshRunStreaming: () => {},
    };
    expect(() =>
      provisionSfcDepsOnHost(remote, {
        hookLocalPath: "/repo/deploy/hooks/post-deploy-provision-deps.sh",
        hookRemotePath: "/tmp/x; rm -rf /",
      }),
    ).toThrow(/unsafe hookRemotePath/);
  });

  it("default hookLocalPath resolves to deploy/hooks/post-deploy-provision-deps.sh", () => {
    const calls = { scp: [] as Array<[string, string]>, ssh: [] as string[] };
    const remote = {
      scpUpload: (local: string, rem: string) => calls.scp.push([local, rem]),
      sshRun: () => "",
      sshRunStreaming: (cmd: string) => calls.ssh.push(cmd),
    };
    provisionSfcDepsOnHost(remote);
    expect(calls.scp[0][0]).toMatch(/deploy\/hooks\/post-deploy-provision-deps\.sh$/);
    expect(calls.scp[0][1]).toBe("/tmp/post-deploy-provision-deps.sh");
  });
});
