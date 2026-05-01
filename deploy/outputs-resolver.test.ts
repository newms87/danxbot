import { describe, it, expect, vi } from "vitest";
import { resolveOutputs, ResolveOutputsDeps } from "./outputs-resolver.js";
import type { CachedOutputs } from "./output-cache.js";
import type { TerraformOutputs } from "./provision.js";
import { makeConfig } from "./test-helpers.js";

const sampleOutputs: TerraformOutputs = {
  instanceId: "i-abc",
  publicIp: "1.2.3.4",
  domain: "example.com",
  ecrRepositoryUrl: "123.dkr.ecr.us-east-1.amazonaws.com/foo",
  sshCommand: "ssh ubuntu@1.2.3.4",
  securityGroupId: "sg-abc",
  dataVolumeId: "vol-abc",
  iamRoleArn: "arn:aws:iam::123:role/foo",
};

const cachedSample: CachedOutputs = {
  ...sampleOutputs,
  cachedAt: "2026-05-01T12:00:00.000Z",
};

function makeDeps(): ResolveOutputsDeps {
  return {
    ensureBackend: vi.fn(),
    fetchOutputs: vi.fn().mockReturnValue(sampleOutputs),
    readCache: vi.fn().mockReturnValue(null),
    writeCache: vi.fn(),
  };
}

describe("resolveOutputs", () => {
  it("on cache hit, skips ensureBackend, fetchOutputs, and writeCache", () => {
    const deps = makeDeps();
    deps.readCache = vi.fn().mockReturnValue(cachedSample);
    const out = resolveOutputs("platform", makeConfig(), deps);
    expect(out).toEqual(sampleOutputs);
    expect(deps.ensureBackend).not.toHaveBeenCalled();
    expect(deps.fetchOutputs).not.toHaveBeenCalled();
    expect(deps.writeCache).not.toHaveBeenCalled();
  });

  it("strips cachedAt from the cached payload before returning", () => {
    const deps = makeDeps();
    deps.readCache = vi.fn().mockReturnValue(cachedSample);
    const out = resolveOutputs("platform", makeConfig(), deps);
    expect(out).not.toHaveProperty("cachedAt");
  });

  it("on cache miss, runs ensureBackend → fetchOutputs → writeCache → returns outputs", () => {
    const deps = makeDeps();
    const config = makeConfig();
    const out = resolveOutputs("platform", config, deps);
    expect(out).toEqual(sampleOutputs);
    expect(deps.ensureBackend).toHaveBeenCalledExactlyOnceWith(config);
    expect(deps.fetchOutputs).toHaveBeenCalledOnce();
    expect(deps.writeCache).toHaveBeenCalledExactlyOnceWith(
      "platform",
      sampleOutputs,
    );
  });

  it("on cache miss, calls ensureBackend BEFORE fetchOutputs", () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.ensureBackend = vi.fn(() => void order.push("ensureBackend"));
    deps.fetchOutputs = vi.fn(() => {
      order.push("fetchOutputs");
      return sampleOutputs;
    });
    deps.writeCache = vi.fn(() => void order.push("writeCache"));
    resolveOutputs("platform", makeConfig(), deps);
    expect(order).toEqual(["ensureBackend", "fetchOutputs", "writeCache"]);
  });

  it("propagates writeCache failures (does not silence them)", () => {
    const deps = makeDeps();
    deps.writeCache = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(() => resolveOutputs("platform", makeConfig(), deps)).toThrow(
      /disk full/,
    );
  });

  it("uses the target arg verbatim for both readCache and writeCache", () => {
    const deps = makeDeps();
    resolveOutputs("gpt", makeConfig(), deps);
    expect(deps.readCache).toHaveBeenCalledExactlyOnceWith("gpt");
    expect(deps.writeCache).toHaveBeenCalledExactlyOnceWith(
      "gpt",
      sampleOutputs,
    );
  });
});
