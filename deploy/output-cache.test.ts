import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  cachePath,
  clearCachedOutputs,
  readCachedOutputs,
  writeCachedOutputs,
} from "./output-cache.js";
import type { TerraformOutputs } from "./provision.js";

const sample: TerraformOutputs = {
  instanceId: "i-abc",
  publicIp: "1.2.3.4",
  domain: "example.com",
  ecrRepositoryUrl: "123.dkr.ecr.us-east-1.amazonaws.com/foo",
  sshCommand: "ssh ubuntu@1.2.3.4",
  securityGroupId: "sg-abc",
  dataVolumeId: "vol-abc",
  iamRoleArn: "arn:aws:iam::123:role/foo",
};

describe("output-cache", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "danx-cache-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when cache file does not exist", () => {
    expect(readCachedOutputs("platform", root)).toBeNull();
  });

  it("round-trips outputs through write then read", () => {
    writeCachedOutputs("platform", sample, root);
    const got = readCachedOutputs("platform", root);
    expect(got).toMatchObject(sample);
    expect(got?.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes file under <root>/<target>.json", () => {
    writeCachedOutputs("gpt", sample, root);
    expect(existsSync(cachePath("gpt", root))).toBe(true);
  });

  it("creates the cache dir if it does not exist", () => {
    rmSync(root, { recursive: true, force: true });
    writeCachedOutputs("platform", sample, root);
    expect(readCachedOutputs("platform", root)).toMatchObject(sample);
  });

  it("returns null on corrupt JSON instead of throwing", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(cachePath("platform", root), "{not json", "utf-8");
    expect(readCachedOutputs("platform", root)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      cachePath("platform", root),
      JSON.stringify({ publicIp: "1.2.3.4" }),
      "utf-8",
    );
    expect(readCachedOutputs("platform", root)).toBeNull();
  });

  it("returns null when a required field is empty string", () => {
    writeCachedOutputs("platform", { ...sample, publicIp: "" }, root);
    expect(readCachedOutputs("platform", root)).toBeNull();
  });

  it("isolates targets — writing platform does not affect gpt", () => {
    writeCachedOutputs("platform", sample, root);
    expect(readCachedOutputs("gpt", root)).toBeNull();
  });

  it("clearCachedOutputs is a no-op when cache is absent", () => {
    expect(() => clearCachedOutputs("nope", root)).not.toThrow();
  });

  it("clearCachedOutputs removes an existing cache", () => {
    writeCachedOutputs("platform", sample, root);
    clearCachedOutputs("platform", root);
    expect(readCachedOutputs("platform", root)).toBeNull();
  });

  it("atomic write leaves no .tmp.* siblings behind", () => {
    writeCachedOutputs("platform", sample, root);
    const entries = readdirSync(root);
    expect(entries.filter((e) => e.includes(".tmp."))).toHaveLength(0);
  });

  it("overwrites an existing cache entry", () => {
    writeCachedOutputs("platform", sample, root);
    writeCachedOutputs("platform", { ...sample, publicIp: "9.9.9.9" }, root);
    expect(readCachedOutputs("platform", root)?.publicIp).toBe("9.9.9.9");
  });

  // Table-driven: each REQUIRED_FIELD must be enforced. If a future refactor
  // accidentally drops one from the validator's enforced list (e.g. by not
  // including it in REQUIRED_FIELDS), this test catches the regression.
  const requiredFieldKeys: (keyof typeof sample)[] = [
    "publicIp",
    "instanceId",
    "domain",
    "ecrRepositoryUrl",
    "sshCommand",
    "securityGroupId",
    "dataVolumeId",
    "iamRoleArn",
  ];
  for (const key of requiredFieldKeys) {
    it(`returns null when required field "${key}" is missing`, () => {
      mkdirSync(root, { recursive: true });
      const partial: Record<string, string> = { ...sample, cachedAt: "2026-05-01T00:00:00Z" };
      delete partial[key];
      writeFileSync(cachePath("platform", root), JSON.stringify(partial), "utf-8");
      expect(readCachedOutputs("platform", root)).toBeNull();
    });
  }

  it("returns null when cachedAt is missing", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      cachePath("platform", root),
      JSON.stringify(sample),
      "utf-8",
    );
    expect(readCachedOutputs("platform", root)).toBeNull();
  });

  // The TOCTOU window between existsSync and readFileSync is real: another
  // process can delete or chmod the file in between. The catch ensures
  // readCachedOutputs never throws — it always returns null on miss.
  it("returns null when readFileSync throws after existsSync passes (TOCTOU)", () => {
    mkdirSync(root, { recursive: true });
    const p = cachePath("platform", root);
    writeFileSync(p, "{}", "utf-8");
    if (process.getuid && process.getuid() === 0) {
      // root bypasses chmod 000; rely on the JSON-validation null path instead.
      expect(readCachedOutputs("platform", root)).toBeNull();
      return;
    }
    chmodSync(p, 0o000);
    try {
      expect(readCachedOutputs("platform", root)).toBeNull();
    } finally {
      chmodSync(p, 0o600);
    }
  });
});
