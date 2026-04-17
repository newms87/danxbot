import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, findConfigPath } from "./config.js";

const TEST_DIR = resolve("/tmp/danxbot-deploy-test");
const DEPLOYMENTS_DIR = resolve(TEST_DIR, ".danxbot/deployments");

function writeDeployment(name: string, yaml: string): string {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const path = resolve(DEPLOYMENTS_DIR, `${name}.yml`);
  writeFileSync(path, yaml);
  return path;
}

describe("deploy config", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("parses a valid config with all required fields", () => {
    const p = writeDeployment(
      "gpt",
      `
name: danxbot-production
region: us-west-2
domain: bot.example.com
hosted_zone: example.com
instance:
  type: t3.large
  volume_size: 40
  data_volume_size: 120
  ssh_key: my-key
  ssh_allowed_cidrs:
    - 10.0.0.0/8
aws:
  profile: gpt
ssm_prefix: /danxbot-gpt
claude_auth_dir: ../../claude-auth
repos:
  - name: danxbot
    url: https://github.com/newms87/danxbot-flytebot.git
  - name: gpt-manager
    url: https://github.com/newms87/gpt-manager.git
dashboard:
  port: 8080
`,
    );

    const config = loadConfig(p);

    expect(config.name).toBe("danxbot-production");
    expect(config.region).toBe("us-west-2");
    expect(config.instance.type).toBe("t3.large");
    expect(config.instance.dataVolumeSize).toBe(120);
    expect(config.aws.profile).toBe("gpt");
    expect(config.ssmPrefix).toBe("/danxbot-gpt");
    expect(config.repos).toHaveLength(2);
  });

  it("applies new minimum defaults (t3.small, 100 GB data)", () => {
    const p = writeDeployment(
      "minimal",
      `
name: minimal-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
`,
    );

    const config = loadConfig(p);

    expect(config.instance.type).toBe("t3.small");
    expect(config.instance.volumeSize).toBe(30);
    expect(config.instance.dataVolumeSize).toBe(100);
    expect(config.dashboard.port).toBe(5555);
    expect(config.repos).toEqual([]);
  });

  it("defaults ssm_prefix to /danxbot-<target> when absent", () => {
    const p = writeDeployment(
      "flytedesk",
      `
name: flytedesk-platform
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
`,
    );

    const config = loadConfig(p);
    expect(config.ssmPrefix).toBe("/danxbot-flytedesk");
  });

  it("throws when aws.profile is missing (no credential-chain fallback)", () => {
    const p = writeDeployment(
      "no-profile",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
`,
    );

    expect(() => loadConfig(p)).toThrow("aws.profile is required");
  });

  it("throws on invalid name format", () => {
    const p = writeDeployment(
      "bad",
      `
name: INVALID_NAME
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
`,
    );

    expect(() => loadConfig(p)).toThrow(
      "lowercase alphanumeric with hyphens",
    );
  });

  it("throws on volume_size below minimum", () => {
    const p = writeDeployment(
      "small-root",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
instance:
  volume_size: 2
aws:
  profile: default
`,
    );

    expect(() => loadConfig(p)).toThrow("volume_size must be");
  });

  it("throws on data_volume_size below minimum", () => {
    const p = writeDeployment(
      "small-data",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
instance:
  data_volume_size: 5
aws:
  profile: default
`,
    );

    expect(() => loadConfig(p)).toThrow("data_volume_size must be");
  });

  it("resolves claude_auth_dir relative to the deployment yml file", () => {
    const p = writeDeployment(
      "rel",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
claude_auth_dir: ../../claude-auth
`,
    );

    const config = loadConfig(p);
    expect(config.claudeAuthDir).toBe(resolve(TEST_DIR, "claude-auth"));
  });

  it("parses multiple repos", () => {
    const p = writeDeployment(
      "multi",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: repo-a
    url: https://github.com/user/a.git
  - name: repo-b
    url: https://github.com/user/b.git
`,
    );

    const config = loadConfig(p);
    expect(config.repos).toHaveLength(2);
    expect(config.repos[0].name).toBe("repo-a");
    expect(config.repos[1].name).toBe("repo-b");
  });

  it("findConfigPath locates .danxbot/deployments/<target>.yml walking up", () => {
    const p = writeDeployment(
      "gpt",
      `
name: danxbot-production
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: gpt
`,
    );

    const nestedDir = resolve(TEST_DIR, "a/b/c");
    mkdirSync(nestedDir, { recursive: true });

    expect(findConfigPath(nestedDir, "gpt")).toBe(p);
  });

  it("findConfigPath throws with a clear message when target is missing", () => {
    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    expect(() => findConfigPath(TEST_DIR, "nonexistent")).toThrow(
      "No .danxbot/deployments/nonexistent.yml found",
    );
  });

  it("throws on invalid YAML", () => {
    const p = writeDeployment("bad-yaml", "not: valid: yaml: [");
    expect(() => loadConfig(p)).toThrow();
  });

  it("throws on wrong type for instance section", () => {
    const p = writeDeployment(
      "bad-instance",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
instance: "not-an-object"
`,
    );

    expect(() => loadConfig(p)).toThrow("instance must be an object");
  });

  it("throws with labeled errors when required top-level fields are missing", () => {
    const p = writeDeployment(
      "missing-required",
      `
aws:
  profile: default
`,
    );

    expect(() => loadConfig(p)).toThrow(/name is required.*domain is required.*hosted_zone is required/s);
  });

  it("throws when ssh_allowed_cidrs is a non-array scalar", () => {
    const p = writeDeployment(
      "bad-cidrs",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
instance:
  ssh_allowed_cidrs: "10.0.0.0/8"
`,
    );

    expect(() => loadConfig(p)).toThrow("instance.ssh_allowed_cidrs must be an array");
  });

  it("throws when a repo entry is missing name or url", () => {
    const p = writeDeployment(
      "bad-repo",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: complete
    url: https://example.com/a.git
  - url: https://example.com/b.git
`,
    );

    expect(() => loadConfig(p)).toThrow("repos[].name is required");
  });

  it("aggregates multiple errors into one thrown message", () => {
    const p = writeDeployment(
      "many-errors",
      `
name: INVALID_NAME
domain: bot.example.com
instance:
  volume_size: 2
aws:
  profile: default
`,
    );

    let caught: Error | null = null;
    try {
      loadConfig(p);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    const msg = caught!.message;
    expect(msg).toContain("lowercase alphanumeric");
    expect(msg).toContain("hosted_zone is required");
    expect(msg).toContain("volume_size must be");
  });

  it("throws on empty YAML file", () => {
    const p = writeDeployment("empty", "");
    expect(() => loadConfig(p)).toThrow("Invalid YAML");
  });

  it("region defaults to us-east-1 when absent", () => {
    const p = writeDeployment(
      "default-region",
      `
name: test-bot
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
`,
    );

    const config = loadConfig(p);
    expect(config.region).toBe("us-east-1");
  });
});
