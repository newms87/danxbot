import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, findConfigPath } from "./config.js";

const TEST_DIR = resolve("/tmp/danxbot-deploy-test");
const DEPLOYMENTS_DIR = resolve(TEST_DIR, "deploy/targets");

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
    url: git@github-newms87:newms87/danxbot.git
    worker_port: 5561
  - name: gpt-manager
    url: https://github.com/newms87/gpt-manager.git
    worker_port: 5562
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

  it("expands a leading ~ in claude_auth_dir to the operator's home directory", () => {
    // Lets gpt.yml say `claude_auth_dir: "~"` and have the deploy upload from
    // the live `claude` CLI's auth dir directly — eliminating the stale-
    // snapshot class of bug where a stamp-in-time copy of `.credentials.json`
    // ages past `expiresAt` and every deploy uploads a token that's already
    // dead on arrival.
    //
    // YAML quirk: bare `~` is the canonical representation of `null`, so
    // the value MUST be quoted (`"~"`). expandTilde would otherwise never
    // see the tilde — `optionalString` would return the default fallback.
    const p = writeDeployment(
      "tilde",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
claude_auth_dir: "~"
`,
    );

    const config = loadConfig(p);
    expect(config.claudeAuthDir).toBe(homedir());
  });

  it("expands ~/<subpath> in claude_auth_dir", () => {
    // Path forms starting with `~/` aren't ambiguous to YAML (only bare `~`
    // is null), so quoting is optional here. Quote anyway for symmetry with
    // the bare-tilde case so users don't have to remember the YAML rule.
    const p = writeDeployment(
      "tilde-sub",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
claude_auth_dir: "~/some/sub"
`,
    );

    const config = loadConfig(p);
    expect(config.claudeAuthDir).toBe(resolve(homedir(), "some/sub"));
  });

  it("does NOT expand a tilde that appears later in the path (only leading ~ is special)", () => {
    // `path/~/x` is a literal path containing a `~` segment — leave it alone.
    // Operating systems don't treat embedded `~` as $HOME, so neither should we.
    // The path resolves relative to the deployment yml's dir as usual.
    const p = writeDeployment(
      "tilde-mid",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
claude_auth_dir: ./path/~/x
`,
    );

    const config = loadConfig(p);
    // Must contain a literal `~` segment — proves no homedir substitution.
    expect(config.claudeAuthDir).toContain("/path/~/x");
    expect(config.claudeAuthDir).not.toContain(homedir());
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
    worker_port: 5561
  - name: repo-b
    url: https://github.com/user/b.git
    worker_port: 5562
`,
    );

    const config = loadConfig(p);
    expect(config.repos).toHaveLength(2);
    expect(config.repos[0].name).toBe("repo-a");
    expect(config.repos[1].name).toBe("repo-b");
  });

  it("findConfigPath locates deploy/targets/<target>.yml walking up", () => {
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
      "No deploy/targets/nonexistent.yml found",
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

  it("parses optional worker_host on a repo", () => {
    // worker_host overrides the default `danxbot-worker-<name>` docker hostname
    // the dashboard uses to proxy to a worker container. Repos that rename their
    // container (legitimate per-repo concern) declare it here so the dashboard
    // sees the right hostname instead of silently 502'ing.
    const p = writeDeployment(
      "with-worker-host",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: custom
    url: https://github.com/user/custom.git
    worker_port: 5561
    worker_host: custom-container-name
  - name: defaulted
    url: https://github.com/user/defaulted.git
    worker_port: 5562
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].name).toBe("custom");
    expect(config.repos[0].workerHost).toBe("custom-container-name");
    expect(config.repos[1].name).toBe("defaulted");
    // Unset must remain undefined so default `danxbot-worker-<name>` applies.
    expect(config.repos[1].workerHost).toBeUndefined();
  });

  it("rejects worker_host that is not a string", () => {
    const p = writeDeployment(
      "bad-host-type",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    worker_host: 42
`,
    );

    expect(() => loadConfig(p)).toThrow(/worker_host.*string/i);
  });

  it("rejects empty worker_host (no silent fallback on config keys)", () => {
    const p = writeDeployment(
      "empty-host",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    worker_host: ""
`,
    );

    expect(() => loadConfig(p)).toThrow(/worker_host.*empty/i);
  });

  it("trims surrounding whitespace from a worker_host value", () => {
    // Test files outside this repo can quote-wrap the value with leading
    // padding for readability; the loader should trim it before storing
    // (mirrors the trim done in src/config.ts:parseWorkerHosts).
    const p = writeDeployment(
      "trim-host",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: r
    url: https://github.com/user/r.git
    worker_port: 5561
    worker_host: "  custom-name  "
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].workerHost).toBe("custom-name");
  });

  it("rejects worker_host with whitespace (DNS labels can't contain spaces)", () => {
    const p = writeDeployment(
      "whitespace-host",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    worker_host: has space
`,
    );

    expect(() => loadConfig(p)).toThrow(/worker_host.*whitespace/i);
  });

  it("parses optional app_env_subpath on a repo", () => {
    const p = writeDeployment(
      "with-subpath",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: platform
    url: https://github.com/user/platform.git
    worker_port: 5561
    app_env_subpath: ssap
  - name: simple
    url: https://github.com/user/simple.git
    worker_port: 5562
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].name).toBe("platform");
    expect(config.repos[0].appEnvSubpath).toBe("ssap");
    expect(config.repos[1].name).toBe("simple");
    // Unset field must remain undefined so existing repos keep default behavior.
    expect(config.repos[1].appEnvSubpath).toBeUndefined();
  });

  it("rejects absolute app_env_subpath (deploy CLI would write outside the repo)", () => {
    const p = writeDeployment(
      "abs-subpath",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    app_env_subpath: /etc
`,
    );

    expect(() => loadConfig(p)).toThrow(/app_env_subpath.*absolute/i);
  });

  it("rejects app_env_subpath containing path traversal", () => {
    const p = writeDeployment(
      "traversal",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    app_env_subpath: ../secrets
`,
    );

    expect(() => loadConfig(p)).toThrow(/app_env_subpath.*traversal/i);
  });

  it("rejects app_env_subpath that is not a string", () => {
    const p = writeDeployment(
      "bad-type",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    app_env_subpath: 42
`,
    );

    expect(() => loadConfig(p)).toThrow(/app_env_subpath.*string/i);
  });

  it("rejects empty app_env_subpath (no silent fallback on config keys)", () => {
    const p = writeDeployment(
      "empty-subpath",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    app_env_subpath: ""
`,
    );

    expect(() => loadConfig(p)).toThrow(/app_env_subpath.*empty/i);
  });

  it("rejects app_env_subpath with non-leading .. segment", () => {
    // Guards the segment-level check: the string contains ".." not at the
    // start, which a naive substring check would miss — but our validator
    // splits on `/` and rejects any exact `..` segment.
    const p = writeDeployment(
      "inner-traversal",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    app_env_subpath: ssap/../escape
`,
    );

    expect(() => loadConfig(p)).toThrow(/app_env_subpath.*traversal/i);
  });

  it("accepts literal '..' as a substring but not a path segment (foo..bar)", () => {
    // The shell script had a `*..*` glob bug — rejected legitimate names.
    // This test pins the TS side and is the regression guard if anyone
    // re-introduces a substring-based check.
    const p = writeDeployment(
      "substring-not-segment",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: odd
    url: https://github.com/user/odd.git
    worker_port: 5561
    app_env_subpath: foo..bar
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].appEnvSubpath).toBe("foo..bar");
  });

  it("normalizes a trailing slash on app_env_subpath (ssap/ → ssap)", () => {
    const p = writeDeployment(
      "trailing-slash",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: r
    url: https://github.com/user/r.git
    worker_port: 5561
    app_env_subpath: ssap/
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].appEnvSubpath).toBe("ssap");
  });

  it("defaults repo branch to main when absent", () => {
    const p = writeDeployment(
      "default-branch",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: r
    url: https://github.com/user/r.git
    worker_port: 5561
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].branch).toBe("main");
  });

  it("defaults branch to main when explicitly set to YAML null (~)", () => {
    // Symmetric with how worker_host / app_env_subpath treat explicit null:
    // the parser short-circuits the type/empty/whitespace checks and falls
    // through to the default. Pinned so future refactors don't accidentally
    // treat null as "empty string" and throw.
    const p = writeDeployment(
      "null-branch",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: r
    url: https://github.com/user/r.git
    worker_port: 5561
    branch: ~
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].branch).toBe("main");
  });

  it("parses optional branch on a repo (e.g. master)", () => {
    // Repos whose default branch isn't `main` (legacy repos still on
    // `master`, projects on `develop`, etc.) need to declare the branch
    // explicitly so deploy syncs the right ref. Without this field the
    // hardcoded `origin/main` silently failed against a non-existent ref.
    const p = writeDeployment(
      "with-branch",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: legacy
    url: https://github.com/user/legacy.git
    worker_port: 5561
    branch: master
  - name: modern
    url: https://github.com/user/modern.git
    worker_port: 5562
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].branch).toBe("master");
    expect(config.repos[1].branch).toBe("main");
  });

  it("rejects empty branch (no silent fallback on config keys)", () => {
    const p = writeDeployment(
      "empty-branch",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    branch: ""
`,
    );

    expect(() => loadConfig(p)).toThrow(/branch.*empty/i);
  });

  it("rejects branch that is not a string", () => {
    const p = writeDeployment(
      "bad-branch-type",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    branch: 42
`,
    );

    expect(() => loadConfig(p)).toThrow(/branch.*string/i);
  });

  it("rejects branch with whitespace (refs can't contain spaces)", () => {
    const p = writeDeployment(
      "whitespace-branch",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: bad
    url: https://github.com/user/bad.git
    worker_port: 5561
    branch: not a ref
`,
    );

    expect(() => loadConfig(p)).toThrow(/branch.*whitespace/i);
  });

  it("trims surrounding whitespace from branch", () => {
    const p = writeDeployment(
      "trim-branch",
      `
name: test-bot
region: us-east-1
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
repos:
  - name: r
    url: https://github.com/user/r.git
    worker_port: 5561
    branch: "  master  "
`,
    );

    const config = loadConfig(p);
    expect(config.repos[0].branch).toBe("master");
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
    worker_port: 5561
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

  it("defaults mode to 'deploy' when omitted (matches gpt.yml/platform.yml shape)", () => {
    const p = writeDeployment(
      "default-mode",
      `
name: test-bot
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
`,
    );
    expect(loadConfig(p).mode).toBe("deploy");
  });

  it("parses mode: local for non-deployable targets", () => {
    // local.yml carries `mode: local` so the deploy CLI's main() can
    // refuse to ship it (deploy/cli.ts gate). The runtime
    // (src/target.ts) shares the YML shape, so this field has to land
    // in DeployConfig too.
    const p = writeDeployment(
      "local",
      `
name: danxbot-local
mode: local
domain: localhost
hosted_zone: localhost
aws:
  profile: default
`,
    );
    expect(loadConfig(p).mode).toBe("local");
  });

  it("rejects mode values other than 'local' or 'deploy'", () => {
    const p = writeDeployment(
      "bad-mode",
      `
name: test-bot
mode: staging
domain: bot.example.com
hosted_zone: example.com
aws:
  profile: default
`,
    );
    expect(() => loadConfig(p)).toThrow(/mode must be "local" or "deploy"/);
  });
});
