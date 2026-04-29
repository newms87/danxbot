# Production Deploy Port Implementation Plan

> **Note (2026-04-28):** This plan was authored when `@thehammer/schema-mcp-server` was a direct danxbot dependency. That contract has since been removed (gpt-manager card #529). The dispatched-agent flow now resolves the schema MCP server via `npx -y` from the workspace `.mcp.json` at dispatch time — no install in danxbot. When porting, omit `@thehammer/schema-mcp-server` from any new `package.json` block; the alphabetical insertion of `yaml` is now between `@slack/bolt` and `mysql2`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the AWS deployment system from `danxbot-gpt-manager` into `danxbot-flytebot`, adapted for multi-repo workers, extended for multi-deployment (per-AWS-account), with a secrets push helper and a per-repo bootstrap step so each prod box runs every worker's full dev stack.

**Architecture:** A TypeScript deploy CLI (`deploy/cli.ts`) that loads `.danxbot/deployments/<TARGET>.yml`, bootstraps a Terraform S3/DynamoDB backend scoped per deployment, provisions AWS (EC2 + EBS + ECR + Route53 + IAM + SG + EIP) via Terraform, builds and pushes the danxbot image, SSHs in to materialize secrets from SSM, sync repos, run each repo's `.danxbot/scripts/bootstrap.sh`, launch the shared-infra compose and one worker compose per repo, then verifies health. Every AWS operation is scoped by deployment TARGET — two deployments in different AWS accounts never collide.

**Tech Stack:** TypeScript + tsx (executed directly, no build step), Node.js `child_process` for shell execution, `yaml` for config parsing, Terraform 1.5+ with the hashicorp/aws 5.x + hashicorp/tls 4.x providers, Docker + ECR, Caddy (auto-TLS), AWS SSM Parameter Store, Vitest for unit tests.

**Source of truth for ports:** The canonical originals live in `/home/newms/web/danxbot-gpt-manager/deploy/` — use that tree as the reference while porting. Paths are called out explicitly in every port task.

**Spec:** `docs/superpowers/specs/2026-04-17-production-deploy-port-design.md` in this repo.

---

## Phase 1: Scaffolding, exec, and config

This phase lays the foundations: adds the `yaml` dep, creates the `deploy/` directory, ports the two utility modules that everything else uses (`exec.ts` and `test-helpers.ts`), and ports `config.ts` adapted for multi-deployment TARGET-based lookup.

### Task 1.1: Add the yaml dependency

**Files:**
- Modify: `/home/newms/web/danxbot-flytebot/package.json`

- [ ] **Step 1: Add `yaml` to dependencies**

Open `package.json`, add `"yaml": "^2.3.4"` to the `dependencies` object (alphabetically between `@thehammer/schema-mcp-server` and `mysql2`). The final dependencies block should look like:

```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "^0.1.0",
  "@anthropic-ai/sdk": "^0.74.0",
  "@slack/bolt": "^4.1.0",
  "@thehammer/schema-mcp-server": "^1.0.3",
  "mysql2": "^3.17.1",
  "yaml": "^2.3.4"
}
```

- [ ] **Step 2: Install the dep**

Run: `cd /home/newms/web/danxbot-flytebot && npm install`
Expected: updates `package-lock.json`, adds `yaml` under `node_modules/yaml/`.

- [ ] **Step 3: Commit**

```bash
cd /home/newms/web/danxbot-flytebot
git add package.json package-lock.json
git commit -m "[Danxbot] Add yaml dep for deploy config parser

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 1.2: Create deploy directory structure

**Files:**
- Create: `deploy/` (empty dir)
- Create: `deploy/terraform/` (empty dir)
- Create: `deploy/templates/` (empty dir)

- [ ] **Step 1: Make directories**

Run: `cd /home/newms/web/danxbot-flytebot && mkdir -p deploy/terraform deploy/templates`

- [ ] **Step 2: Confirm**

Run: `ls -la deploy/`
Expected: shows `terraform/` and `templates/` subdirectories.

No commit yet — empty dirs are not tracked. Subsequent tasks add files here and commit.

### Task 1.3: Port exec.ts (shell helpers) verbatim

**Files:**
- Create: `deploy/exec.ts`
- Create: `deploy/exec.test.ts`

- [ ] **Step 1: Write `deploy/exec.ts`**

Create `deploy/exec.ts` with identical content to `/home/newms/web/danxbot-gpt-manager/deploy/exec.ts`. Module is pure and has no flytebot-specific adaptation — straight copy. Content (use exactly this):

```typescript
/**
 * Shell execution helpers for the deploy CLI.
 * Wraps child_process with consistent error handling and output capture.
 */

import { execSync, type ExecSyncOptions } from "node:child_process";

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 */
export function run(cmd: string, options?: ExecSyncOptions): string {
  console.log(`  $ ${cmd}`);
  const result = execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
  return result.trim();
}

/**
 * Run a shell command, streaming stdout/stderr to the terminal.
 * Throws on non-zero exit.
 */
export function runStreaming(cmd: string, options?: ExecSyncOptions): void {
  console.log(`  $ ${cmd}`);
  execSync(cmd, {
    encoding: "utf-8",
    stdio: "inherit",
    ...options,
  });
}

/**
 * Run a shell command, returning stdout without throwing on failure.
 * Returns null if the command fails.
 */
export function tryRun(cmd: string, options?: ExecSyncOptions): string | null {
  try {
    return run(cmd, options);
  } catch {
    return null;
  }
}

/**
 * Build an AWS CLI command with the given profile.
 */
export function awsCmd(profile: string, cmd: string): string {
  const profileFlag = profile ? `--profile ${profile}` : "";
  return `aws ${profileFlag} ${cmd}`.replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 2: Write failing tests `deploy/exec.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { run, tryRun, awsCmd } from "./exec.js";

describe("exec", () => {
  it("run returns trimmed stdout", () => {
    expect(run("echo hello")).toBe("hello");
  });

  it("run throws on non-zero exit", () => {
    expect(() => run("false")).toThrow();
  });

  it("tryRun returns null on failure", () => {
    expect(tryRun("false")).toBeNull();
  });

  it("tryRun returns stdout on success", () => {
    expect(tryRun("echo world")).toBe("world");
  });

  it("awsCmd prepends --profile when profile is non-empty", () => {
    expect(awsCmd("prod", "s3 ls")).toBe("aws --profile prod s3 ls");
  });

  it("awsCmd omits --profile when profile is empty string", () => {
    expect(awsCmd("", "sts get-caller-identity")).toBe(
      "aws sts get-caller-identity",
    );
  });

  it("awsCmd collapses multiple spaces", () => {
    expect(awsCmd("", "  s3    ls  ")).toBe("aws s3 ls");
  });
});
```

- [ ] **Step 3: Run tests, expect pass**

Run: `cd /home/newms/web/danxbot-flytebot && npx vitest run deploy/exec.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add deploy/exec.ts deploy/exec.test.ts
git commit -m "[Danxbot] Port deploy/exec.ts shell helpers

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 1.4: Port test-helpers.ts adapted for multi-deployment defaults

**Files:**
- Create: `deploy/test-helpers.ts`

- [ ] **Step 1: Write `deploy/test-helpers.ts`**

This is identical to gpt-manager's `test-helpers.ts` except the default `ssmPrefix` becomes `/danxbot-test-bot` (multi-deployment convention) and defaults match the new minimums (t3.small, 100 GB data volume):

```typescript
/**
 * Shared test helpers for deploy tests.
 * Provides a factory for DeployConfig with sensible defaults.
 */

import type { DeployConfig } from "./config.js";

export function makeConfig(
  overrides: Partial<DeployConfig> = {},
): DeployConfig {
  return {
    name: "test-bot",
    region: "us-west-2",
    domain: "bot.example.com",
    hostedZone: "example.com",
    instance: {
      type: "t3.small",
      volumeSize: 30,
      dataVolumeSize: 100,
      sshKey: "",
      sshAllowedCidrs: ["0.0.0.0/0"],
    },
    aws: { profile: "test-profile" },
    ssmPrefix: "/danxbot-test-bot",
    claudeAuthDir: "/tmp/claude-auth",
    repos: [],
    dashboard: { port: 5555 },
    ...overrides,
  };
}
```

No test for this module — it's a factory used by other tests.

- [ ] **Step 2: Commit when config.ts lands**

Hold off on committing until Task 1.5 creates `config.ts`; `test-helpers.ts` imports from it.

### Task 1.5: Port config.ts adapted for `.danxbot/deployments/<TARGET>.yml` lookup

**Files:**
- Create: `deploy/config.ts`
- Create: `deploy/config.test.ts`

The adaptations vs gpt-manager's `config.ts`:

- `findConfigPath(startDir, target)` — takes a `target` string (the deployment name from `--target` / `TARGET=` / positional arg). Walks up from `startDir` looking for `.danxbot/deployments/<target>.yml`. Throws a clear error if not found.
- `loadConfig(configPath)` — same shape as today, but:
  - Default `instance.type` is `"t3.small"` (new minimum) instead of `"t3.medium"`.
  - Default `instance.data_volume_size` has its floor raised to `50` still, but the default when absent bumps to `100` (buffer).
  - `aws.profile` becomes **required** (no default-chain fallback) — omitting it throws.
  - `ssm_prefix` default becomes `/danxbot-<target>` where `<target>` is derived from the yml filename stem. `loadConfig` accepts an optional `target` parameter (already derivable from the path).

- [ ] **Step 1: Write failing tests `deploy/config.test.ts`**

Start with the full file (replaces the gpt-manager version):

```typescript
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
    // .danxbot/deployments/rel.yml → ../../claude-auth resolves to TEST_DIR/claude-auth
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
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/config.test.ts`
Expected: all fail (module doesn't exist yet).

- [ ] **Step 3: Write `deploy/config.ts`**

```typescript
/**
 * YAML parser + validator for .danxbot/deployments/<TARGET>.yml.
 * Multi-deployment variant of gpt-manager's single-deployment config.
 *
 * Key differences vs gpt-manager:
 *   - Config lives at .danxbot/deployments/<target>.yml (not .danxbot/deploy.yml).
 *   - aws.profile is REQUIRED (no credential-chain fallback; wrong account is expensive).
 *   - Defaults shift to the new minimums (t3.small, 100 GB data volume).
 *   - ssm_prefix defaults to /danxbot-<target> using the yml filename stem.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { parse as parseYaml } from "yaml";

export interface DeployConfig {
  name: string;
  region: string;
  domain: string;
  hostedZone: string;
  instance: {
    type: string;
    volumeSize: number;
    dataVolumeSize: number;
    sshKey: string;
    sshAllowedCidrs: string[];
  };
  aws: {
    profile: string;
  };
  ssmPrefix: string;
  claudeAuthDir: string;
  repos: Array<{ name: string; url: string }>;
  dashboard: {
    port: number;
  };
}

/**
 * Locate .danxbot/deployments/<target>.yml, starting from cwd and walking up.
 * Throws a clear error if not found.
 */
export function findConfigPath(
  startDir: string = process.cwd(),
  target: string,
): string {
  let dir = resolve(startDir);
  const root = resolve("/");

  while (dir !== root) {
    const candidate = resolve(dir, ".danxbot/deployments", `${target}.yml`);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }

  throw new Error(
    `No .danxbot/deployments/${target}.yml found. Create it from .danxbot/deployments.example.yml.`,
  );
}

/**
 * Parse and validate the deploy config. Throws on any missing or invalid field.
 */
export function loadConfig(configPath: string): DeployConfig {
  const raw = readFileSync(configPath, "utf-8");
  const yaml = parseYaml(raw);

  if (!yaml || typeof yaml !== "object") {
    throw new Error(`Invalid YAML in ${configPath}`);
  }

  const errors: string[] = [];

  function requireString(
    obj: Record<string, unknown>,
    key: string,
    label: string,
  ): string {
    const value = obj[key];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${label} is required and must be a non-empty string`);
      return "";
    }
    return value.trim();
  }

  function requireNumber(
    obj: Record<string, unknown>,
    key: string,
    label: string,
    min: number,
  ): number {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
      errors.push(`${label} must be a number >= ${min}`);
      return min;
    }
    return value;
  }

  function optionalString(
    obj: Record<string, unknown>,
    key: string,
    label: string,
    defaultValue: string,
  ): string {
    const value = obj[key];
    if (value === undefined || value === null) return defaultValue;
    if (typeof value !== "string") {
      errors.push(`${label} must be a string (got ${typeof value})`);
      return defaultValue;
    }
    return value;
  }

  function optionalNumber(
    obj: Record<string, unknown>,
    key: string,
    label: string,
    defaultValue: number,
    min: number,
  ): number {
    const value = obj[key];
    if (value === undefined || value === null) return defaultValue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${label} must be a number (got ${typeof value})`);
      return defaultValue;
    }
    if (value < min) {
      errors.push(`${label} must be a number >= ${min}`);
      return defaultValue;
    }
    return value;
  }

  function requireObject(
    obj: Record<string, unknown>,
    key: string,
    label: string,
  ): Record<string, unknown> {
    const value = obj[key];
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(
        `${label} must be an object (got ${Array.isArray(value) ? "array" : typeof value})`,
      );
      return {};
    }
    return value as Record<string, unknown>;
  }

  const target = basename(configPath, ".yml");

  const name = requireString(yaml, "name", "name");
  const region = optionalString(yaml, "region", "region", "us-east-1");
  const domain = requireString(yaml, "domain", "domain");
  const hostedZone = requireString(yaml, "hosted_zone", "hosted_zone");

  if (name && !/^[a-z0-9-]+$/.test(name)) {
    errors.push("name must be lowercase alphanumeric with hyphens only");
  }

  const inst = requireObject(yaml, "instance", "instance");
  const instanceType = optionalString(
    inst,
    "type",
    "instance.type",
    "t3.small",
  );
  const volumeSize = optionalNumber(
    inst,
    "volume_size",
    "instance.volume_size",
    30,
    8,
  );
  const dataVolumeSize = optionalNumber(
    inst,
    "data_volume_size",
    "instance.data_volume_size",
    100,
    10,
  );
  const sshKey = optionalString(inst, "ssh_key", "instance.ssh_key", "");
  const sshAllowedCidrs = Array.isArray(inst.ssh_allowed_cidrs)
    ? (inst.ssh_allowed_cidrs as string[])
    : inst.ssh_allowed_cidrs === undefined
      ? ["0.0.0.0/0"]
      : (() => {
          errors.push("instance.ssh_allowed_cidrs must be an array");
          return ["0.0.0.0/0"];
        })();

  const awsConfig = requireObject(yaml, "aws", "aws");
  const awsProfile = requireString(awsConfig, "profile", "aws.profile");

  const ssmPrefix = optionalString(
    yaml,
    "ssm_prefix",
    "ssm_prefix",
    `/danxbot-${target}`,
  );

  const claudeAuthRaw = optionalString(
    yaml,
    "claude_auth_dir",
    "claude_auth_dir",
    "../../claude-auth",
  );
  const configDir = dirname(configPath);
  const claudeAuthDir = resolve(configDir, claudeAuthRaw);

  const repos: Array<{ name: string; url: string }> = [];
  if (Array.isArray(yaml.repos)) {
    for (const repo of yaml.repos) {
      if (typeof repo === "object" && repo !== null) {
        const r = repo as Record<string, unknown>;
        const rName = requireString(r, "name", "repos[].name");
        const rUrl = requireString(r, "url", "repos[].url");
        if (rName && rUrl) repos.push({ name: rName, url: rUrl });
      }
    }
  }

  const dash = requireObject(yaml, "dashboard", "dashboard");
  const dashboardPort = optionalNumber(
    dash,
    "port",
    "dashboard.port",
    5555,
    1,
  );

  if (errors.length > 0) {
    throw new Error(
      `Invalid deploy config (${configPath}):\n  - ${errors.join("\n  - ")}`,
    );
  }

  return {
    name,
    region,
    domain,
    hostedZone,
    instance: {
      type: instanceType,
      volumeSize,
      dataVolumeSize,
      sshKey,
      sshAllowedCidrs,
    },
    aws: { profile: awsProfile },
    ssmPrefix,
    claudeAuthDir,
    repos,
    dashboard: { port: dashboardPort },
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/config.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add deploy/config.ts deploy/config.test.ts deploy/test-helpers.ts
git commit -m "[Danxbot] Port deploy config loader for multi-deployment TARGET yml

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 2: Terraform backend + stack

Ports the S3/DynamoDB backend bootstrap, the Terraform provision wrapper, and all HCL files. Terraform files are straight ports — they already treat `name` as the deployment prefix for all resource names, which is exactly the multi-deployment model.

### Task 2.1: Port bootstrap.ts (S3 + DynamoDB)

**Files:**
- Create: `deploy/bootstrap.ts`
- Create: `deploy/bootstrap.test.ts`

- [ ] **Step 1: Write failing tests `deploy/bootstrap.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { getBackendConfig } from "./bootstrap.js";
import { makeConfig } from "./test-helpers.js";

describe("bootstrap backend config", () => {
  it("scopes bucket + lock table per deployment name", () => {
    const backend = getBackendConfig(makeConfig({ name: "danxbot-production" }));
    expect(backend.bucket).toBe("danxbot-production-terraform-state");
    expect(backend.dynamodbTable).toBe("danxbot-production-terraform-locks");
    expect(backend.key).toBe("danxbot/terraform.tfstate");
  });

  it("propagates region from config", () => {
    const backend = getBackendConfig(makeConfig({ region: "eu-west-1" }));
    expect(backend.region).toBe("eu-west-1");
  });

  it("enables encryption", () => {
    const backend = getBackendConfig(makeConfig());
    expect(backend.encrypt).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/bootstrap.test.ts`
Expected: fails with "Cannot find module './bootstrap.js'".

- [ ] **Step 3: Write `deploy/bootstrap.ts`**

Straight port from `/home/newms/web/danxbot-gpt-manager/deploy/bootstrap.ts` — no adaptations needed. Copy the file verbatim.

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/bootstrap.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add deploy/bootstrap.ts deploy/bootstrap.test.ts
git commit -m "[Danxbot] Port deploy/bootstrap.ts (Terraform backend)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 2.2: Port Terraform HCL files

**Files:**
- Create: `deploy/terraform/versions.tf`
- Create: `deploy/terraform/data.tf`
- Create: `deploy/terraform/networking.tf`
- Create: `deploy/terraform/compute.tf`
- Create: `deploy/terraform/ecr.tf`
- Create: `deploy/terraform/iam.tf`
- Create: `deploy/terraform/outputs.tf`
- Create: `deploy/terraform/variables.tf`

All files are straight ports from `/home/newms/web/danxbot-gpt-manager/deploy/terraform/` — the multi-deployment model is already satisfied because every resource name is prefixed with `var.name`. Two adaptations:

- `variables.tf`: change default `instance_type` from `"t3.medium"` to `"t3.small"` and default `data_volume_size` from `50` to `100`.
- `compute.tf`: the `templatefile` call already handles cloud-init rendering; no change yet. Extended in Phase 5 when multi-worker cloud-init lands.

- [ ] **Step 1: Copy each .tf file verbatim**

```bash
cd /home/newms/web/danxbot-flytebot
for f in versions.tf data.tf networking.tf ecr.tf iam.tf outputs.tf; do
  cp /home/newms/web/danxbot-gpt-manager/deploy/terraform/$f deploy/terraform/$f
done
cp /home/newms/web/danxbot-gpt-manager/deploy/terraform/compute.tf deploy/terraform/compute.tf
```

- [ ] **Step 2: Write `deploy/terraform/variables.tf` with new defaults**

Copy from gpt-manager, then edit two lines: `instance_type` default `"t3.small"` and `data_volume_size` default `100`. Full content:

```hcl
# ──────────────────────────────────────────────
# Core
# ──────────────────────────────────────────────

variable "name" {
  description = "Deployment name — used as prefix for all AWS resources"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.name))
    error_message = "name must be lowercase alphanumeric with hyphens only"
  }
}

variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile name (required — multi-deployment safety)"
  type        = string
}

# ──────────────────────────────────────────────
# Compute
# ──────────────────────────────────────────────

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 30
}

variable "data_volume_size" {
  description = "Data EBS volume size in GB (repos, threads, mysql, claude-auth)"
  type        = number
  default     = 100
}

variable "ssh_key_name" {
  description = "Name of an existing AWS EC2 key pair for SSH access. Leave empty to generate one."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to SSH into the instance"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ──────────────────────────────────────────────
# DNS
# ──────────────────────────────────────────────

variable "domain" {
  description = "Full domain name for the dashboard (e.g. danxbot.example.com)"
  type        = string
}

variable "hosted_zone" {
  description = "Route53 hosted zone name (e.g. example.com)"
  type        = string
}

# ──────────────────────────────────────────────
# Secrets (SSM parameter paths)
# ──────────────────────────────────────────────

variable "ssm_parameter_prefix" {
  description = "SSM Parameter Store prefix for secrets (e.g. /danxbot-gpt)"
  type        = string
}

# ──────────────────────────────────────────────
# Dashboard
# ──────────────────────────────────────────────

variable "dashboard_port" {
  description = "Port the danxbot dashboard listens on inside the container"
  type        = number
  default     = 5555
}
```

- [ ] **Step 3: Verify Terraform files are syntactically valid**

Run: `cd deploy/terraform && terraform init -backend=false && terraform validate`
Expected: `Success! The configuration is valid.` — the init with `-backend=false` skips S3 backend so this can run without AWS creds.

- [ ] **Step 4: Commit**

```bash
cd /home/newms/web/danxbot-flytebot
git add deploy/terraform/
git commit -m "[Danxbot] Port Terraform stack with new minimum defaults

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 2.3: Port provision.ts (Terraform wrapper)

**Files:**
- Create: `deploy/provision.ts`
- Create: `deploy/provision.test.ts`

- [ ] **Step 1: Write failing tests `deploy/provision.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { backendConfigFlags } from "./provision.js";
import { makeConfig } from "./test-helpers.js";

describe("provision backend flags", () => {
  it("emits bucket/key/region/lock/encrypt flags", () => {
    const flags = backendConfigFlags(
      makeConfig({ name: "danxbot-production", region: "us-east-1" }),
    );
    expect(flags).toContain("-backend-config=bucket=danxbot-production-terraform-state");
    expect(flags).toContain("-backend-config=key=danxbot/terraform.tfstate");
    expect(flags).toContain("-backend-config=region=us-east-1");
    expect(flags).toContain("-backend-config=dynamodb_table=danxbot-production-terraform-locks");
    expect(flags).toContain("-backend-config=encrypt=true");
  });

  it("includes profile flag (profile is always required)", () => {
    const flags = backendConfigFlags(makeConfig({ aws: { profile: "gpt" } }));
    expect(flags).toContain("-backend-config=profile=gpt");
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/provision.test.ts`

- [ ] **Step 3: Write `deploy/provision.ts`**

Straight port from `/home/newms/web/danxbot-gpt-manager/deploy/provision.ts`, with **two** adaptations in the `writeTfVars` function:

1. The config field lookup — flytebot's config uses `ssmPrefix` (already matching gpt-manager), so no change.
2. Because `aws.profile` is now required in config, drop the `profile ? ... : null` fallback in the generated tfvars — always pass `profile: config.aws.profile`.

Copy the file from gpt-manager and keep the small adaptation. The tests above lock in the observable behavior.

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/provision.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/provision.ts deploy/provision.test.ts
git commit -m "[Danxbot] Port deploy/provision.ts (Terraform wrapper)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 3: Build, health, and remote

These three modules handle everything that happens AFTER Terraform apply: building the image, verifying the endpoint, and running commands on the instance.

### Task 3.1: Port build.ts (docker build + ECR push)

**Files:**
- Create: `deploy/build.ts`
- Create: `deploy/build.test.ts`

- [ ] **Step 1: Write failing tests `deploy/build.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { buildImageTags } from "./build.js";

describe("build image tags", () => {
  it("emits latest + timestamp tags", () => {
    const tags = buildImageTags("123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production");
    expect(tags.latestTag).toBe(
      "123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production:latest",
    );
    expect(tags.timestampTag).toMatch(
      /^123\.dkr\.ecr\.us-east-1\.amazonaws\.com\/danxbot-production:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
    );
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/build.test.ts`

- [ ] **Step 3: Write `deploy/build.ts`**

Port from `/home/newms/web/danxbot-gpt-manager/deploy/build.ts`, with one refactor: extract the tag-building logic into a pure `buildImageTags(ecrRepositoryUrl): { latestTag, timestampTag }` function so it can be unit-tested without invoking docker. `buildAndPush` calls it internally. Full file:

```typescript
/**
 * Docker image build and ECR push for deploy.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployConfig } from "./config.js";
import { awsCmd, runStreaming } from "./exec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export interface ImageTags {
  latestTag: string;
  timestampTag: string;
}

/**
 * Compute :latest and :<timestamp> tags for a given ECR repository URL.
 * Pure function — no docker, no I/O. Unit-testable.
 */
export function buildImageTags(ecrRepositoryUrl: string): ImageTags {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    latestTag: `${ecrRepositoryUrl}:latest`,
    timestampTag: `${ecrRepositoryUrl}:${timestamp}`,
  };
}

function ecrLogin(config: DeployConfig, ecrRegistryUrl: string): void {
  const registry = ecrRegistryUrl.split("/")[0];
  console.log(`  Authenticating Docker to ECR: ${registry}`);
  runStreaming(
    `${awsCmd(config.aws.profile, `ecr get-login-password --region ${config.region}`)} | docker login --username AWS --password-stdin ${registry}`,
  );
}

export function buildAndPush(
  config: DeployConfig,
  ecrRepositoryUrl: string,
): string {
  console.log("\n── Building Docker image ──");
  const { latestTag, timestampTag } = buildImageTags(ecrRepositoryUrl);

  runStreaming(`docker build -t ${latestTag} -t ${timestampTag} .`, {
    cwd: REPO_ROOT,
  });

  console.log("\n── Pushing to ECR ──");
  ecrLogin(config, ecrRepositoryUrl);
  runStreaming(`docker push ${latestTag}`);
  runStreaming(`docker push ${timestampTag}`);

  console.log(`  Pushed: ${latestTag}`);
  console.log(`  Pushed: ${timestampTag}`);

  return latestTag;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/build.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/build.ts deploy/build.test.ts
git commit -m "[Danxbot] Port deploy/build.ts with unit-testable tag builder

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 3.2: Port health.ts

**Files:**
- Create: `deploy/health.ts`
- Create: `deploy/health.test.ts`

- [ ] **Step 1: Write failing tests `deploy/health.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitForHealthy } from "./health.js";

describe("waitForHealthy", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("returns healthy=true when endpoint returns 200 on first attempt", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const promise = waitForHealthy("https://example.com", 3, 100);
    const result = await promise;

    expect(result.healthy).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.attempts).toBe(1);
  });

  it("returns healthy=false after maxAttempts failures", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const promise = waitForHealthy("https://example.com", 2, 0);
    const result = await promise;

    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain("failed after 2 attempts");
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/health.test.ts`

- [ ] **Step 3: Write `deploy/health.ts`**

Straight port from `/home/newms/web/danxbot-gpt-manager/deploy/health.ts` — no adaptation. Verbatim.

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/health.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/health.ts deploy/health.test.ts
git commit -m "[Danxbot] Port deploy/health.ts endpoint polling

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 3.3: Port remote.ts (RemoteHost base class)

**Files:**
- Create: `deploy/remote.ts`
- Create: `deploy/remote.test.ts`

Only port the foundation in this task — SSH command building, SCP upload, template substitution. The extensions for flytebot's multi-repo (repo sync, bootstrap.sh run, worker compose launch) live in dedicated modules in Phases 4–5 that wrap `RemoteHost`. Keep this module narrow.

- [ ] **Step 1: Write failing tests `deploy/remote.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { applyTemplateVars, resolveKeyPath } from "./remote.js";
import { makeConfig } from "./test-helpers.js";
import { resolve } from "node:path";

describe("applyTemplateVars", () => {
  it("substitutes all occurrences of each key", () => {
    const result = applyTemplateVars("image: ${IMG}\nport: ${PORT}\nimage2: ${IMG}", {
      "${IMG}": "repo:latest",
      "${PORT}": "5555",
    });
    expect(result).toBe("image: repo:latest\nport: 5555\nimage2: repo:latest");
  });

  it("escapes regex metacharacters in the key", () => {
    const result = applyTemplateVars("x=${FOO:-bar}", { "${FOO:-bar}": "hello" });
    expect(result).toBe("x=hello");
  });
});

describe("resolveKeyPath", () => {
  it("returns config.instance.sshKey when set", () => {
    expect(resolveKeyPath(makeConfig({ instance: { ...makeConfig().instance, sshKey: "/tmp/my.pem" } }))).toBe("/tmp/my.pem");
  });

  it("returns ~/.ssh/<name>-key.pem when sshKey is empty", () => {
    const p = resolveKeyPath(makeConfig({ name: "danxbot-production" }));
    expect(p).toBe(resolve(process.env.HOME ?? "~", ".ssh", "danxbot-production-key.pem"));
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/remote.test.ts`

- [ ] **Step 3: Write `deploy/remote.ts`**

Pruned port — keeps the foundations (`RemoteHost` constructor, `sshRun`, `sshRunStreaming`, `scpUpload`, `uploadClaudeAuth`, `openSshSession`, `tailLogs`, `waitForSsh`) plus the `applyTemplateVars` and `resolveKeyPath` helpers as exported functions. The gpt-manager methods `uploadComposeFile`, `uploadReposEnv`, and `restartContainers` are deliberately omitted — semantically richer versions live in `compose-infra.ts` and `workers.ts` in Phase 5. Full file:

```typescript
/**
 * Remote operations on the EC2 instance via SSH and SCP.
 * RemoteHost encapsulates config + IP as instance state.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as _readFileSync, existsSync } from "node:fs";
import type { DeployConfig } from "./config.js";
import { run, runStreaming, tryRun } from "./exec.js";

/**
 * Resolve the SSH private key path from config. Exported for use outside the class.
 */
export function resolveKeyPath(config: DeployConfig): string {
  if (config.instance.sshKey) return config.instance.sshKey;
  return resolve(process.env.HOME ?? "~", ".ssh", `${config.name}-key.pem`);
}

/**
 * Apply template substitutions. Keys are treated as literal strings
 * (not regexes) — the function escapes regex metacharacters internally.
 */
export function applyTemplateVars(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [pattern, replacement] of Object.entries(vars)) {
    result = result.replace(
      new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      replacement,
    );
  }
  return result;
}

export class RemoteHost {
  private readonly keyPath: string;
  private readonly baseFlags: string;

  constructor(
    private readonly config: DeployConfig,
    private readonly ip: string,
  ) {
    this.keyPath = resolveKeyPath(config);
    this.baseFlags = `-i ${this.keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
  }

  sshRun(command: string): string {
    return run(
      `ssh ${this.baseFlags} ubuntu@${this.ip} '${command.replace(/'/g, "'\\''")}'`,
    );
  }

  sshRunStreaming(command: string): void {
    runStreaming(
      `ssh ${this.baseFlags} ubuntu@${this.ip} '${command.replace(/'/g, "'\\''")}'`,
    );
  }

  scpUpload(localPath: string, remotePath: string): void {
    run(`scp ${this.baseFlags} ${localPath} ubuntu@${this.ip}:${remotePath}`);
  }

  uploadClaudeAuth(): void {
    const authDir = this.config.claudeAuthDir;
    if (!existsSync(authDir)) {
      throw new Error(
        `Claude auth directory not found at ${authDir}. Deploy cannot proceed without it.`,
      );
    }
    console.log("\n── Uploading Claude Code auth ──");

    const claudeJson = resolve(authDir, ".claude.json");
    const credentialsJson = resolve(authDir, ".credentials.json");

    if (existsSync(claudeJson)) {
      this.scpUpload(claudeJson, "/tmp/.claude.json");
      this.sshRun(
        "sudo mv /tmp/.claude.json /danxbot/claude-auth/.claude.json && sudo chown ubuntu:ubuntu /danxbot/claude-auth/.claude.json",
      );
      console.log("  Uploaded .claude.json");
    }

    if (existsSync(credentialsJson)) {
      this.scpUpload(credentialsJson, "/tmp/.credentials.json");
      this.sshRun(
        "sudo mv /tmp/.credentials.json /danxbot/claude-auth/.credentials.json && sudo chown ubuntu:ubuntu /danxbot/claude-auth/.credentials.json",
      );
      console.log("  Uploaded .credentials.json");
    }
  }

  openSshSession(): void {
    runStreaming(`ssh ${this.baseFlags} ubuntu@${this.ip}`);
  }

  tailLogs(): void {
    this.sshRunStreaming(
      "cd /danxbot && docker compose -f docker-compose.prod.yml logs -f --tail=100",
    );
  }

  async waitForSsh(
    maxAttempts: number = 40,
    intervalMs: number = 5000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = tryRun(
        `ssh ${this.baseFlags} -o ConnectTimeout=5 ubuntu@${this.ip} echo ok`,
      );
      if (result === "ok") {
        console.log(`  SSH ready (attempt ${attempt}/${maxAttempts})`);
        return;
      }
      console.log(`  Waiting for SSH... (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `SSH connection to ${this.ip} failed after ${maxAttempts} attempts`,
    );
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/remote.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/remote.ts deploy/remote.test.ts
git commit -m "[Danxbot] Port base RemoteHost (SSH/SCP/template subst)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 4: Secrets (local → SSM, SSM → instance)

This phase introduces the only genuinely new logic vs gpt-manager: bi-directional secrets flow. `secrets.ts` pushes local `.env` files to SSM; `templates/materialize-secrets.sh` pulls from SSM on the instance and writes `.env` files back in the expected locations.

### Task 4.1: Write secrets.ts SSM push helper

**Files:**
- Create: `deploy/secrets.ts`
- Create: `deploy/secrets.test.ts`

Shape:

- `parseEnvFile(path: string): Record<string, string>` — tolerant .env parser (KEY=VALUE lines, # comments, trimming).
- `collectDeploymentSecrets(config): { shared, perRepo }` — reads the LOCAL files this repo knows about and returns the aggregated secret map. Sources:
  - Shared: `./.env` in `danxbot-flytebot/` (the CWD when running the CLI).
  - Per-repo danxbot: `repos/<name>/.danxbot/.env`.
  - Per-repo app env: `repos/<name>/.env` — these are tagged with a `REPO_ENV_` prefix on push, stripped on materialize.
- `buildSsmPutCommands(config, collected): string[]` — returns the list of `aws ssm put-parameter ...` commands the push step will execute. Pure function; no AWS call. This is what the tests verify.
- `pushSecrets(config)` — orchestrator: runs `collectDeploymentSecrets`, then `buildSsmPutCommands`, then `runStreaming` each command.

- [ ] **Step 1: Write failing tests `deploy/secrets.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseEnvFile,
  collectDeploymentSecrets,
  buildSsmPutCommands,
} from "./secrets.js";
import { makeConfig } from "./test-helpers.js";

const TMP = resolve("/tmp/danxbot-secrets-test");

describe("parseEnvFile", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("parses KEY=VALUE lines, ignores comments and blank lines", () => {
    const p = resolve(TMP, "x.env");
    writeFileSync(p, "# comment\nFOO=bar\n\nBAZ=hello world\nQUX=\n");
    expect(parseEnvFile(p)).toEqual({
      FOO: "bar",
      BAZ: "hello world",
      QUX: "",
    });
  });

  it("returns empty object when file does not exist", () => {
    expect(parseEnvFile(resolve(TMP, "missing.env"))).toEqual({});
  });

  it("strips surrounding quotes on values", () => {
    const p = resolve(TMP, "q.env");
    writeFileSync(p, 'FOO="bar baz"\nQUOTED=\'single\'\n');
    expect(parseEnvFile(p)).toEqual({ FOO: "bar baz", QUOTED: "single" });
  });
});

describe("collectDeploymentSecrets", () => {
  const CWD = resolve(TMP, "cwd");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(resolve(CWD, "repos/app/.danxbot"), { recursive: true });
    writeFileSync(resolve(CWD, ".env"), "ANTHROPIC_API_KEY=sk-xxx\n");
    writeFileSync(
      resolve(CWD, "repos/app/.danxbot/.env"),
      "DANX_SLACK_BOT_TOKEN=xoxb-yyy\n",
    );
    writeFileSync(
      resolve(CWD, "repos/app/.env"),
      "APP_KEY=base64:zzz\nDB_PASSWORD=secret\n",
    );
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("collects shared + per-repo danxbot + per-repo app env", () => {
    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [{ name: "app", url: "https://github.com/x/app.git" }],
      }),
      CWD,
    );

    expect(result.shared).toEqual({ ANTHROPIC_API_KEY: "sk-xxx" });
    expect(result.perRepo.app.danxbot).toEqual({
      DANX_SLACK_BOT_TOKEN: "xoxb-yyy",
    });
    expect(result.perRepo.app.app).toEqual({
      APP_KEY: "base64:zzz",
      DB_PASSWORD: "secret",
    });
  });
});

describe("buildSsmPutCommands", () => {
  it("emits put-parameter commands for shared and per-repo keys", () => {
    const cfg = makeConfig({
      name: "danxbot-production",
      ssmPrefix: "/danxbot-gpt",
      aws: { profile: "gpt" },
      repos: [{ name: "app", url: "https://github.com/x/app.git" }],
    });
    const collected = {
      shared: { ANTHROPIC_API_KEY: "sk-xxx" },
      perRepo: {
        app: {
          danxbot: { DANX_SLACK_BOT_TOKEN: "xoxb" },
          app: { APP_KEY: "base64:zz" },
        },
      },
    };
    const cmds = buildSsmPutCommands(cfg, collected);

    expect(cmds).toContainEqual(
      expect.stringMatching(
        /aws --profile gpt ssm put-parameter --name "\/danxbot-gpt\/shared\/ANTHROPIC_API_KEY" --type SecureString --overwrite --region us-west-2 --value "sk-xxx"/,
      ),
    );
    expect(cmds).toContainEqual(
      expect.stringMatching(
        /--name "\/danxbot-gpt\/repos\/app\/DANX_SLACK_BOT_TOKEN"/,
      ),
    );
    expect(cmds).toContainEqual(
      expect.stringMatching(
        /--name "\/danxbot-gpt\/repos\/app\/REPO_ENV_APP_KEY"/,
      ),
    );
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/secrets.test.ts`

- [ ] **Step 3: Write `deploy/secrets.ts`**

```typescript
/**
 * Secrets orchestration: local .env files → SSM (push) and vice versa (materialize via remote script).
 *
 * Local file → SSM path mapping:
 *   ./.env                              → <ssm_prefix>/shared/<KEY>
 *   ./repos/<name>/.danxbot/.env        → <ssm_prefix>/repos/<name>/<KEY>
 *   ./repos/<name>/.env                 → <ssm_prefix>/repos/<name>/REPO_ENV_<KEY>
 *
 * The instance-side materializer (templates/materialize-secrets.sh) reverses this.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DeployConfig } from "./config.js";
import { awsCmd, runStreaming } from "./exec.js";

export interface CollectedSecrets {
  shared: Record<string, string>;
  perRepo: Record<string, { danxbot: Record<string, string>; app: Record<string, string> }>;
}

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function collectDeploymentSecrets(
  config: DeployConfig,
  cwd: string = process.cwd(),
): CollectedSecrets {
  const shared = parseEnvFile(resolve(cwd, ".env"));
  const perRepo: CollectedSecrets["perRepo"] = {};
  for (const repo of config.repos) {
    perRepo[repo.name] = {
      danxbot: parseEnvFile(resolve(cwd, "repos", repo.name, ".danxbot/.env")),
      app: parseEnvFile(resolve(cwd, "repos", repo.name, ".env")),
    };
  }
  return { shared, perRepo };
}

export function buildSsmPutCommands(
  config: DeployConfig,
  collected: CollectedSecrets,
): string[] {
  const cmds: string[] = [];
  const putOne = (name: string, value: string): string =>
    awsCmd(
      config.aws.profile,
      `ssm put-parameter --name "${name}" --type SecureString --overwrite --region ${config.region} --value "${value.replace(/"/g, '\\"')}"`,
    );

  for (const [k, v] of Object.entries(collected.shared)) {
    cmds.push(putOne(`${config.ssmPrefix}/shared/${k}`, v));
  }
  for (const [repoName, groups] of Object.entries(collected.perRepo)) {
    for (const [k, v] of Object.entries(groups.danxbot)) {
      cmds.push(putOne(`${config.ssmPrefix}/repos/${repoName}/${k}`, v));
    }
    for (const [k, v] of Object.entries(groups.app)) {
      cmds.push(putOne(`${config.ssmPrefix}/repos/${repoName}/REPO_ENV_${k}`, v));
    }
  }
  return cmds;
}

export function pushSecrets(
  config: DeployConfig,
  cwd: string = process.cwd(),
): void {
  const collected = collectDeploymentSecrets(config, cwd);
  const cmds = buildSsmPutCommands(config, collected);

  console.log(`\n── Pushing ${cmds.length} secret(s) to SSM ──`);
  for (const cmd of cmds) {
    runStreaming(cmd);
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/secrets.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/secrets.ts deploy/secrets.test.ts
git commit -m "[Danxbot] Add deploy/secrets.ts SSM push helper

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 4.2: Write materialize-secrets.sh template

**Files:**
- Create: `deploy/templates/materialize-secrets.sh`
- Create: `deploy/materialize-secrets.test.ts` (shell-level integration test via bash)

- [ ] **Step 1: Write failing test `deploy/materialize-secrets.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const WORK = resolve("/tmp/danxbot-materialize-test");
const SCRIPT = resolve(__dirname, "templates/materialize-secrets.sh");

/**
 * Build a fake `aws` that responds to `aws ssm get-parameters-by-path --path <p>`
 * with the contents of a JSON file keyed by the path.
 */
function fakeAwsDir(paths: Record<string, Array<{ Name: string; Value: string }>>): string {
  const bin = resolve(WORK, "bin");
  mkdirSync(bin, { recursive: true });
  const payload = resolve(WORK, "paths.json");
  writeFileSync(payload, JSON.stringify(paths));
  const fakeAws = resolve(bin, "aws");
  writeFileSync(
    fakeAws,
    `#!/bin/bash
# Expect: aws ssm get-parameters-by-path --path <p> --recursive --with-decryption --region <r> --query "Parameters[*].[Name,Value]" --output text
path=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --path) path=$2; shift 2 ;;
    *) shift ;;
  esac
done
node -e '
  const paths = require("${payload}");
  const entries = paths[process.argv[1]] || [];
  for (const e of entries) console.log(e.Name + "\\t" + e.Value);
' "$path"
`,
  );
  execSync(`chmod +x ${fakeAws}`);
  return bin;
}

describe("materialize-secrets.sh", () => {
  beforeEach(() => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    mkdirSync(resolve(WORK, "danxbot/repos/app/.danxbot"), { recursive: true });
  });

  afterEach(() => {
    rmSync(WORK, { recursive: true, force: true });
  });

  it("writes shared keys to /danxbot/.env and per-repo keys to the right files", () => {
    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [
        { Name: "/danxbot-test/shared/ANTHROPIC_API_KEY", Value: "sk-xxx" },
        { Name: "/danxbot-test/shared/DANXBOT_GIT_EMAIL", Value: "bot@x.io" },
      ],
      "/danxbot-test/repos/app/": [
        { Name: "/danxbot-test/repos/app/DANX_SLACK_BOT_TOKEN", Value: "xoxb" },
        { Name: "/danxbot-test/repos/app/REPO_ENV_APP_KEY", Value: "base64:z" },
        { Name: "/danxbot-test/repos/app/REPO_ENV_DB_PASSWORD", Value: "sec" },
      ],
    });

    execSync(
      `bash ${SCRIPT} /danxbot-test us-east-1 app`,
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DANXBOT_ROOT: resolve(WORK, "danxbot"),
        },
      },
    );

    const sharedEnv = readFileSync(resolve(WORK, "danxbot/.env"), "utf-8");
    expect(sharedEnv).toContain("ANTHROPIC_API_KEY=sk-xxx");
    expect(sharedEnv).toContain("DANXBOT_GIT_EMAIL=bot@x.io");

    const danxbotRepoEnv = readFileSync(
      resolve(WORK, "danxbot/repos/app/.danxbot/.env"),
      "utf-8",
    );
    expect(danxbotRepoEnv).toContain("DANX_SLACK_BOT_TOKEN=xoxb");

    const appEnv = readFileSync(
      resolve(WORK, "danxbot/repos/app/.env"),
      "utf-8",
    );
    expect(appEnv).toContain("APP_KEY=base64:z");
    expect(appEnv).toContain("DB_PASSWORD=sec");
    expect(appEnv).not.toContain("DANX_SLACK_BOT_TOKEN");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run deploy/materialize-secrets.test.ts`
Expected: fails because the script doesn't exist yet.

- [ ] **Step 3: Write `deploy/templates/materialize-secrets.sh`**

```bash
#!/bin/bash
# Materialize SSM secrets for one deployment into the expected file layout.
#
# Usage:
#   materialize-secrets.sh <ssm_prefix> <region> [<repo_name>...]
#
# For each repo_name, materializes /<ssm_prefix>/repos/<repo_name>/* into
# the repo's .danxbot/.env (non-REPO_ENV keys) and .env (REPO_ENV_* with
# prefix stripped). Shared keys go to $DANXBOT_ROOT/.env.
#
# DANXBOT_ROOT defaults to /danxbot when unset (production); tests can
# override it to point at a temp directory.

set -euo pipefail

SSM_PREFIX="${1:?ssm_prefix required}"
REGION="${2:?region required}"
shift 2
REPOS=("$@")

ROOT="${DANXBOT_ROOT:-/danxbot}"

fetch_path() {
  aws ssm get-parameters-by-path \
    --path "$1" \
    --recursive \
    --with-decryption \
    --region "$REGION" \
    --query "Parameters[*].[Name,Value]" \
    --output text
}

echo "── Materializing shared keys to $ROOT/.env ──"
mkdir -p "$ROOT"
: > "$ROOT/.env"
fetch_path "$SSM_PREFIX/shared/" | while IFS=$'\t' read -r name value; do
  [ -z "$name" ] && continue
  key="${name##*/}"
  printf '%s=%s\n' "$key" "$value" >> "$ROOT/.env"
done

for repo in "${REPOS[@]}"; do
  repo_root="$ROOT/repos/$repo"
  mkdir -p "$repo_root/.danxbot"
  danxbot_env="$repo_root/.danxbot/.env"
  app_env="$repo_root/.env"
  : > "$danxbot_env"
  : > "$app_env"

  echo "── Materializing $SSM_PREFIX/repos/$repo/ → $repo_root ──"
  fetch_path "$SSM_PREFIX/repos/$repo/" | while IFS=$'\t' read -r name value; do
    [ -z "$name" ] && continue
    key="${name##*/}"
    if [[ "$key" == REPO_ENV_* ]]; then
      stripped="${key#REPO_ENV_}"
      printf '%s=%s\n' "$stripped" "$value" >> "$app_env"
    else
      printf '%s=%s\n' "$key" "$value" >> "$danxbot_env"
    fi
  done
done

echo "── Done materializing ──"
```

Then `chmod +x deploy/templates/materialize-secrets.sh`.

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run deploy/materialize-secrets.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/templates/materialize-secrets.sh deploy/materialize-secrets.test.ts
git commit -m "[Danxbot] Add materialize-secrets.sh + tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 5: Repo sync + workers + infra compose

These modules replace the `restartContainers`/`uploadComposeFile` methods that gpt-manager bundled into `RemoteHost`. They give us a per-repo compose orchestration model on top of `RemoteHost.sshRun`/`scpUpload`.

### Task 5.1: Write bootstrap-repos.ts (clone/pull + bootstrap.sh)

**Files:**
- Create: `deploy/bootstrap-repos.ts`
- Create: `deploy/bootstrap-repos.test.ts`

Shape:

- `buildCloneOrPullCommand(repo, githubToken): string` — returns the shell command (executed inside `/danxbot/repos/`) that clones if `<name>/` is absent, otherwise `git fetch && git reset --hard origin/main`. Pure function.
- `syncRepos(remote: RemoteHost, config: DeployConfig, tokensPerRepo: Record<string, string>)` — iterates `config.repos` and runs the clone/pull command for each via `remote.sshRun`.
- `runBootstrapScripts(remote: RemoteHost, config: DeployConfig)` — for each repo, runs `bash /danxbot/repos/<name>/.danxbot/scripts/bootstrap.sh` streaming the output.

- [ ] **Step 1: Write failing tests `deploy/bootstrap-repos.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { buildCloneOrPullCommand } from "./bootstrap-repos.js";

describe("buildCloneOrPullCommand", () => {
  it("emits clone-or-pull with token substituted into URL", () => {
    const cmd = buildCloneOrPullCommand(
      { name: "app", url: "https://github.com/x/app.git" },
      "ghp_xxx",
    );
    expect(cmd).toContain("if [ -d /danxbot/repos/app ]");
    expect(cmd).toContain(
      "https://x-access-token:ghp_xxx@github.com/x/app.git",
    );
    expect(cmd).toContain("git -C /danxbot/repos/app fetch");
    expect(cmd).toContain("git -C /danxbot/repos/app reset --hard origin/main");
    expect(cmd).toContain("git clone");
  });

  it("rejects non-https github URLs (we only support github.com HTTPS)", () => {
    expect(() =>
      buildCloneOrPullCommand({ name: "app", url: "git@github.com:x/app.git" }, "t"),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/bootstrap-repos.test.ts`

- [ ] **Step 3: Write `deploy/bootstrap-repos.ts`**

```typescript
/**
 * Per-repo clone/pull + bootstrap.sh execution on the remote instance.
 */

import type { DeployConfig } from "./config.js";
import type { RemoteHost } from "./remote.js";

export function buildCloneOrPullCommand(
  repo: { name: string; url: string },
  githubToken: string,
): string {
  const m = repo.url.match(/^https:\/\/github\.com\/(.+\.git)$/);
  if (!m) {
    throw new Error(
      `Unsupported repo URL (need https://github.com/...): ${repo.url}`,
    );
  }
  const authedUrl = `https://x-access-token:${githubToken}@github.com/${m[1]}`;

  return [
    `if [ -d /danxbot/repos/${repo.name} ]; then`,
    `  git -C /danxbot/repos/${repo.name} fetch origin main`,
    `  && git -C /danxbot/repos/${repo.name} reset --hard origin/main;`,
    `else`,
    `  git clone ${authedUrl} /danxbot/repos/${repo.name};`,
    `fi`,
  ].join("\n");
}

export function syncRepos(
  remote: RemoteHost,
  config: DeployConfig,
  tokensPerRepo: Record<string, string>,
): void {
  for (const repo of config.repos) {
    const token = tokensPerRepo[repo.name];
    if (!token) {
      throw new Error(
        `No DANX_GITHUB_TOKEN found for repo "${repo.name}" (expected in SSM at repos/${repo.name}/DANX_GITHUB_TOKEN)`,
      );
    }
    console.log(`\n── Syncing ${repo.name} ──`);
    remote.sshRunStreaming(buildCloneOrPullCommand(repo, token));
  }
}

export function runBootstrapScripts(
  remote: RemoteHost,
  config: DeployConfig,
): void {
  for (const repo of config.repos) {
    const script = `/danxbot/repos/${repo.name}/.danxbot/scripts/bootstrap.sh`;
    console.log(`\n── Running bootstrap for ${repo.name} ──`);
    remote.sshRunStreaming(`test -x ${script} && bash ${script}`);
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/bootstrap-repos.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/bootstrap-repos.ts deploy/bootstrap-repos.test.ts
git commit -m "[Danxbot] Add per-repo clone/pull + bootstrap.sh orchestrator

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 5.2: Write workers.ts

**Files:**
- Create: `deploy/workers.ts`
- Create: `deploy/workers.test.ts`

Shape:

- `buildLaunchCommand(repo)` — returns the `docker compose -f <repo>/.danxbot/config/compose.yml -p worker-<name> up -d --remove-orphans` command.
- `launchWorkers(remote, config)` — iterates.
- `stopWorkers(remote, config)` — for teardown.

- [ ] **Step 1: Write failing tests `deploy/workers.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { buildLaunchCommand, buildStopCommand } from "./workers.js";

describe("worker commands", () => {
  it("builds a compose up command scoped to the repo", () => {
    expect(buildLaunchCommand({ name: "app", url: "x" })).toBe(
      "docker compose -f /danxbot/repos/app/.danxbot/config/compose.yml -p worker-app up -d --remove-orphans",
    );
  });

  it("builds a matching stop command", () => {
    expect(buildStopCommand({ name: "app", url: "x" })).toBe(
      "docker compose -p worker-app down",
    );
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/workers.test.ts`

- [ ] **Step 3: Write `deploy/workers.ts`**

```typescript
/**
 * Per-repo worker compose orchestration on the remote instance.
 */

import type { DeployConfig } from "./config.js";
import type { RemoteHost } from "./remote.js";

export function buildLaunchCommand(repo: { name: string; url: string }): string {
  return `docker compose -f /danxbot/repos/${repo.name}/.danxbot/config/compose.yml -p worker-${repo.name} up -d --remove-orphans`;
}

export function buildStopCommand(repo: { name: string; url: string }): string {
  return `docker compose -p worker-${repo.name} down`;
}

export function launchWorkers(remote: RemoteHost, config: DeployConfig): void {
  for (const repo of config.repos) {
    console.log(`\n── Launching worker for ${repo.name} ──`);
    remote.sshRunStreaming(buildLaunchCommand(repo));
  }
}

export function stopWorkers(remote: RemoteHost, config: DeployConfig): void {
  for (const repo of config.repos) {
    console.log(`\n── Stopping worker for ${repo.name} ──`);
    remote.sshRunStreaming(buildStopCommand(repo));
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/workers.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/workers.ts deploy/workers.test.ts
git commit -m "[Danxbot] Add per-repo worker compose orchestrator

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 5.3: Write compose-infra.ts + prod compose template

**Files:**
- Create: `deploy/compose-infra.ts`
- Create: `deploy/compose-infra.test.ts`
- Create: `deploy/templates/docker-compose.prod.yml`

Replaces gpt-manager's `RemoteHost.uploadComposeFile` with a small dedicated module, and swaps in flytebot's infra (dashboard + mysql + playwright, no single `danxbot` service).

- [ ] **Step 1: Write the template `deploy/templates/docker-compose.prod.yml`**

```yaml
# Flytebot production infra compose (dashboard + mysql + playwright).
# The deploy CLI SCPs this file to /danxbot/docker-compose.prod.yml with
# ${ECR_IMAGE} and ${DASHBOARD_PORT} substituted.
# Per-repo workers run from /danxbot/repos/<name>/.danxbot/config/compose.yml
# via separate compose projects (`worker-<name>`) on the shared danxbot-net.

services:
  dashboard:
    image: ${ECR_IMAGE}
    restart: always
    stop_grace_period: 30s
    env_file: /danxbot/.env
    ports:
      - "${DASHBOARD_PORT}:${DASHBOARD_PORT}"
    volumes:
      - /danxbot/repos:/danxbot/app/repos
      - /danxbot/threads:/danxbot/threads
      - /danxbot/logs:/danxbot/logs
      - /danxbot/claude-auth:/danxbot/claude-auth:ro
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - danxbot-net
    depends_on:
      mysql:
        condition: service_healthy
    healthcheck:
      test: curl -f http://localhost:${DASHBOARD_PORT}/health || exit 1
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  playwright:
    image: mcr.microsoft.com/playwright:v1.40.0-jammy
    restart: always
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      PORT: "3000"
    networks:
      - danxbot-net
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      start_period: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "1"

  mysql:
    image: mysql/mysql-server:8.0
    restart: always
    env_file: /danxbot/.env
    volumes:
      - /danxbot/mysql-data:/var/lib/mysql
    environment:
      MYSQL_ROOT_PASSWORD: ${DANXBOT_DB_PASSWORD}
      MYSQL_ROOT_HOST: "%"
      MYSQL_DATABASE: ${DANXBOT_DB_NAME:-danxbot_chat}
      MYSQL_USER: ${DANXBOT_DB_USER}
      MYSQL_PASSWORD: ${DANXBOT_DB_PASSWORD}
    networks:
      - danxbot-net
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-p${DANXBOT_DB_PASSWORD}"]
      interval: 5s
      retries: 5
      timeout: 3s
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "1"

networks:
  danxbot-net:
    name: danxbot-net
    driver: bridge
```

- [ ] **Step 2: Write failing tests `deploy/compose-infra.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { renderProdCompose } from "./compose-infra.js";

describe("renderProdCompose", () => {
  it("substitutes ECR image and dashboard port", () => {
    const out = renderProdCompose(
      "123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production:latest",
      5555,
    );
    expect(out).toContain("image: 123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production:latest");
    expect(out).toMatch(/"5555:5555"/);
    expect(out).toMatch(/localhost:5555\/health/);
    expect(out).not.toContain("${ECR_IMAGE}");
    expect(out).not.toContain("${DASHBOARD_PORT}");
  });
});
```

- [ ] **Step 3: Write `deploy/compose-infra.ts`**

```typescript
/**
 * Render + upload the shared-infra prod compose file to the instance.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTemplateVars, type RemoteHost } from "./remote.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(__dirname, "templates/docker-compose.prod.yml");

export function renderProdCompose(ecrImage: string, dashboardPort: number): string {
  return applyTemplateVars(readFileSync(TEMPLATE, "utf-8"), {
    "${ECR_IMAGE}": ecrImage,
    "${DASHBOARD_PORT}": String(dashboardPort),
  });
}

export function uploadAndRestartInfra(
  remote: RemoteHost,
  ecrImage: string,
  dashboardPort: number,
  region: string,
): void {
  const { writeFileSync } = require("node:fs");
  console.log("\n── Uploading /danxbot/docker-compose.prod.yml ──");
  const rendered = renderProdCompose(ecrImage, dashboardPort);
  const tmp = "/tmp/docker-compose.prod.yml";
  writeFileSync(tmp, rendered);
  remote.scpUpload(tmp, "/tmp/docker-compose.prod.yml");
  remote.sshRun(
    "sudo mv /tmp/docker-compose.prod.yml /danxbot/docker-compose.prod.yml && sudo chown ubuntu:ubuntu /danxbot/docker-compose.prod.yml",
  );

  const registry = ecrImage.split("/")[0];
  remote.sshRun(
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
  );
  remote.sshRunStreaming(`docker pull ${ecrImage}`);
  remote.sshRunStreaming(
    "cd /danxbot && docker compose -f docker-compose.prod.yml up -d --remove-orphans --force-recreate",
  );
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/compose-infra.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/compose-infra.ts deploy/compose-infra.test.ts deploy/templates/docker-compose.prod.yml
git commit -m "[Danxbot] Add infra compose renderer + flytebot-specific template

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 6: Cloud-init

Cloud-init runs once on first boot and provisions the OS: Docker, Caddy, AWS CLI, mounts the data volume, creates directory structure, registers the danxbot systemd unit. It does NOT clone repos or materialize secrets — those are the deploy CLI's job on every deploy.

### Task 6.1: Port cloud-init template adapted for flytebot

**Files:**
- Create: `deploy/templates/cloud-init.yaml.tpl`

- [ ] **Step 1: Write the template**

Port from `/home/newms/web/danxbot-gpt-manager/deploy/templates/cloud-init.yaml.tpl`. Adaptations:

- Remove the embedded SSM → .env writer from cloud-init (deploy CLI owns this via `materialize-secrets.sh`, not cloud-init).
- Remove the embedded ECR pull from cloud-init (deploy CLI does it).
- Keep Docker, Caddy, AWS CLI install, volume mount, directory creation, systemd unit.
- The systemd unit still runs `docker compose -f /danxbot/docker-compose.prod.yml up -d` — this is the shared-infra compose. Workers are managed by the deploy CLI, not systemd (they start on every deploy).

```yaml
#cloud-config
package_update: true
package_upgrade: true

packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
  - lsb-release
  - unattended-upgrades
  - jq
  - unzip

bootcmd:
  - |
    if ! blkid ${data_device}; then
      mkfs.ext4 ${data_device}
    fi

mounts:
  - ["${data_device}", "/danxbot", "ext4", "defaults,nofail", "0", "2"]

runcmd:
  # ── Docker CE ──
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - usermod -aG docker ubuntu

  # ── Caddy (auto-TLS reverse proxy) ──
  - curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  - curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  - apt-get update
  - apt-get install -y caddy

  # ── Caddyfile ──
  - |
    cat > /etc/caddy/Caddyfile <<'CADDY'
    ${domain} {
        reverse_proxy localhost:${dashboard_port}
    }
    CADDY
  - systemctl restart caddy
  - systemctl enable caddy

  # ── Create data directories ──
  - mkdir -p /danxbot/repos /danxbot/threads /danxbot/data /danxbot/logs /danxbot/claude-auth /danxbot/mysql-data
  - chown -R ubuntu:ubuntu /danxbot

  # ── AWS CLI v2 ──
  - curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip
  - unzip -q /tmp/awscli.zip -d /tmp/awscli
  - /tmp/awscli/aws/install
  - rm -rf /tmp/awscli /tmp/awscli.zip

  # ── ECR login helper ──
  - |
    cat > /usr/local/bin/ecr-login.sh <<'SCRIPT'
    #!/bin/bash
    set -euo pipefail
    /usr/local/bin/aws ecr get-login-password --region ${region} | /usr/bin/docker login --username AWS --password-stdin ${ecr_registry}
    SCRIPT
    chmod +x /usr/local/bin/ecr-login.sh

  # ── danxbot systemd unit (starts shared-infra compose on boot) ──
  - |
    cat > /etc/systemd/system/danxbot.service <<'UNIT'
    [Unit]
    Description=Danxbot shared infra compose
    After=docker.service
    Requires=docker.service

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    WorkingDirectory=/danxbot
    ExecStartPre=/usr/local/bin/ecr-login.sh
    ExecStart=/usr/bin/docker compose -f /danxbot/docker-compose.prod.yml up -d --remove-orphans
    ExecStop=/usr/bin/docker compose -f /danxbot/docker-compose.prod.yml down
    Restart=on-failure
    RestartSec=10

    [Install]
    WantedBy=multi-user.target
    UNIT
  - systemctl daemon-reload
  - systemctl enable danxbot.service

final_message: "Danxbot instance bootstrap complete. Cloud-init finished at $UPTIME seconds."
```

- [ ] **Step 2: Commit**

```bash
git add deploy/templates/cloud-init.yaml.tpl
git commit -m "[Danxbot] Add cloud-init template (flytebot: no embedded secrets)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 7: CLI

Puts everything together. `cli.ts` parses the command + TARGET, dispatches to the right action, and orchestrates the deploy pipeline.

### Task 7.1: Write cli.ts

**Files:**
- Create: `deploy/cli.ts`
- Create: `deploy/cli.test.ts`

- [ ] **Step 1: Write failing tests `deploy/cli.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseCliArgs } from "./cli.js";

describe("parseCliArgs", () => {
  it("parses `deploy gpt`", () => {
    expect(parseCliArgs(["deploy", "gpt"])).toEqual({
      command: "deploy",
      target: "gpt",
      dryRun: false,
      confirm: false,
    });
  });

  it("parses `status flytedesk`", () => {
    expect(parseCliArgs(["status", "flytedesk"])).toEqual({
      command: "status",
      target: "flytedesk",
      dryRun: false,
      confirm: false,
    });
  });

  it("parses --dry-run", () => {
    expect(parseCliArgs(["deploy", "gpt", "--dry-run"])).toEqual({
      command: "deploy",
      target: "gpt",
      dryRun: true,
      confirm: false,
    });
  });

  it("parses --confirm for destroy", () => {
    expect(parseCliArgs(["destroy", "gpt", "--confirm"])).toEqual({
      command: "destroy",
      target: "gpt",
      dryRun: false,
      confirm: true,
    });
  });

  it("throws on unknown command", () => {
    expect(() => parseCliArgs(["frobnicate", "gpt"])).toThrow("Unknown command");
  });

  it("throws when target is missing", () => {
    expect(() => parseCliArgs(["deploy"])).toThrow("TARGET is required");
  });

  it("parses `secrets-push gpt`", () => {
    expect(parseCliArgs(["secrets-push", "gpt"])).toEqual({
      command: "secrets-push",
      target: "gpt",
      dryRun: false,
      confirm: false,
    });
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run deploy/cli.test.ts`

- [ ] **Step 3: Write `deploy/cli.ts`**

```typescript
#!/usr/bin/env npx tsx
/**
 * Flytebot deploy CLI — multi-deployment entry point.
 *
 * Usage:
 *   npx tsx deploy/cli.ts <command> <target> [--dry-run] [--confirm]
 *
 * Commands:
 *   deploy        Full pipeline (provision + build + push + sync + launch + verify)
 *   status        Show Terraform outputs + health
 *   destroy       Tear down all AWS resources (requires --confirm)
 *   ssh           Interactive SSH to the instance
 *   logs          Tail dashboard + worker container logs
 *   secrets-push  Sync local .env files to the deployment's SSM subtree
 *   smoke         Dispatch a trivial prompt against the deployed API
 */

import { findConfigPath, loadConfig, type DeployConfig } from "./config.js";
import { bootstrapBackend } from "./bootstrap.js";
import {
  terraformInit,
  terraformApply,
  terraformDestroy,
  getTerraformOutputs,
  saveGeneratedSshKey,
} from "./provision.js";
import { buildAndPush } from "./build.js";
import { RemoteHost } from "./remote.js";
import { waitForHealthy } from "./health.js";
import { pushSecrets } from "./secrets.js";
import { syncRepos, runBootstrapScripts } from "./bootstrap-repos.js";
import { launchWorkers } from "./workers.js";
import { uploadAndRestartInfra } from "./compose-infra.js";
import { awsCmd, run } from "./exec.js";

const COMMANDS = [
  "deploy",
  "status",
  "destroy",
  "ssh",
  "logs",
  "secrets-push",
  "smoke",
] as const;
type Command = (typeof COMMANDS)[number];

export interface CliArgs {
  command: Command;
  target: string;
  dryRun: boolean;
  confirm: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const rawCommand = argv[0];
  if (!rawCommand || !COMMANDS.includes(rawCommand as Command)) {
    throw new Error(
      `Unknown command: ${rawCommand}\nUsage: deploy/cli.ts <${COMMANDS.join("|")}> <TARGET> [--dry-run] [--confirm]`,
    );
  }
  const target = argv[1];
  if (!target || target.startsWith("--")) {
    throw new Error("TARGET is required (e.g., deploy gpt)");
  }
  return {
    command: rawCommand as Command,
    target,
    dryRun: argv.includes("--dry-run"),
    confirm: argv.includes("--confirm"),
  };
}

function ensureBackend(config: DeployConfig): void {
  bootstrapBackend(config);
  terraformInit(config);
}

/**
 * Fetch each repo's DANX_GITHUB_TOKEN from SSM so we can clone private repos.
 */
function fetchRepoTokens(config: DeployConfig): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const repo of config.repos) {
    const cmd = awsCmd(
      config.aws.profile,
      `ssm get-parameter --name "${config.ssmPrefix}/repos/${repo.name}/DANX_GITHUB_TOKEN" --with-decryption --region ${config.region} --query Parameter.Value --output text`,
    );
    tokens[repo.name] = run(cmd);
  }
  return tokens;
}

async function deploy(config: DeployConfig): Promise<void> {
  console.log("\n═══════════════════════════════════════");
  console.log(`  DEPLOYING ${config.name}`);
  console.log("═══════════════════════════════════════");

  ensureBackend(config);
  const outputs = terraformApply(config);

  console.log(`\n  Instance: ${outputs.instanceId}`);
  console.log(`  IP: ${outputs.publicIp}`);
  console.log(`  ECR: ${outputs.ecrRepositoryUrl}`);

  saveGeneratedSshKey(config);

  const remote = new RemoteHost(config, outputs.publicIp);

  console.log("\n── Waiting for instance SSH readiness ──");
  await remote.waitForSsh();

  const ecrImage = buildAndPush(config, outputs.ecrRepositoryUrl);

  remote.uploadClaudeAuth();

  // Materialize secrets: upload the script, run it with the deployment's ssm prefix
  remote.scpUpload(
    new URL("./templates/materialize-secrets.sh", import.meta.url).pathname,
    "/tmp/materialize-secrets.sh",
  );
  remote.sshRun("sudo mv /tmp/materialize-secrets.sh /usr/local/bin/materialize-secrets.sh && sudo chmod +x /usr/local/bin/materialize-secrets.sh");
  const repoArgs = config.repos.map((r) => r.name).join(" ");
  remote.sshRunStreaming(
    `sudo DANXBOT_ROOT=/danxbot /usr/local/bin/materialize-secrets.sh ${config.ssmPrefix} ${config.region} ${repoArgs}`,
  );

  // Sync repos (clone/pull) using per-repo tokens
  const tokens = fetchRepoTokens(config);
  syncRepos(remote, config, tokens);

  // Run each repo's bootstrap.sh
  runBootstrapScripts(remote, config);

  // Launch shared-infra compose
  uploadAndRestartInfra(remote, ecrImage, config.dashboard.port, config.region);

  // Launch per-repo workers
  launchWorkers(remote, config);

  // Health
  const health = await waitForHealthy(`https://${config.domain}`);

  console.log("\n═══════════════════════════════════════");
  if (health.healthy) {
    console.log("  DEPLOY SUCCESSFUL");
    console.log(`  Dashboard: https://${config.domain}`);
    console.log(`  SSH: ${outputs.sshCommand}`);
  } else {
    console.log("  DEPLOY COMPLETED — HEALTH CHECK FAILED");
    console.log(`  Check logs: npx tsx deploy/cli.ts logs ${config.name}`);
    process.exit(1);
  }
  console.log("═══════════════════════════════════════\n");
}

async function status(config: DeployConfig): Promise<void> {
  console.log("\n── Infrastructure Status ──");
  try {
    ensureBackend(config);
    const outputs = getTerraformOutputs();
    console.log(`  Instance: ${outputs.instanceId}`);
    console.log(`  IP: ${outputs.publicIp}`);
    console.log(`  Domain: ${outputs.domain}`);
    console.log(`  ECR: ${outputs.ecrRepositoryUrl}`);
    console.log(`  Data Volume: ${outputs.dataVolumeId}`);
    console.log(`  SSH: ${outputs.sshCommand}`);

    const health = await waitForHealthy(`https://${config.domain}`, 3, 2000);
    console.log(`\n  Health: ${health.healthy ? "HEALTHY" : "UNHEALTHY"}`);
  } catch {
    console.log("  No infrastructure deployed yet.");
    console.log(`  Run: npx tsx deploy/cli.ts deploy <target>`);
  }
}

async function destroy(config: DeployConfig, confirm: boolean): Promise<void> {
  console.log("\n── DESTROYING INFRASTRUCTURE ──");
  console.log("  This will permanently delete EC2, EBS, EIP, ECR, Route53, SG, IAM.");
  if (!confirm) {
    console.log("\n  Add --confirm to proceed.");
    process.exit(1);
  }
  ensureBackend(config);
  terraformDestroy(config);
  console.log("\n  All infrastructure destroyed.");
}

async function ssh(config: DeployConfig): Promise<void> {
  ensureBackend(config);
  const outputs = getTerraformOutputs();
  new RemoteHost(config, outputs.publicIp).openSshSession();
}

async function logs(config: DeployConfig): Promise<void> {
  ensureBackend(config);
  const outputs = getTerraformOutputs();
  new RemoteHost(config, outputs.publicIp).tailLogs();
}

async function secretsPush(config: DeployConfig): Promise<void> {
  pushSecrets(config);
}

async function smoke(config: DeployConfig): Promise<void> {
  console.log("\n── Smoke: dispatching trivial prompt ──");
  const url = `https://${config.domain}`;
  const response = await fetch(`${url}/api/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "echo", repo: config.repos[0]?.name ?? "default" }),
  });
  if (!response.ok) {
    throw new Error(`Smoke failed: ${response.status}`);
  }
  console.log(`  ✓ Smoke OK (${response.status})`);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const path = findConfigPath(process.cwd(), args.target);
  const config = loadConfig(path);

  console.log(`\nDanxbot Deploy — ${config.name} (target: ${args.target})`);
  console.log(`  Region: ${config.region}`);
  console.log(`  Domain: ${config.domain}`);

  if (args.dryRun) {
    console.log("  DRY RUN — no commands will be executed (not yet implemented)");
    process.exit(0);
  }

  switch (args.command) {
    case "deploy":
      await deploy(config);
      break;
    case "status":
      await status(config);
      break;
    case "destroy":
      await destroy(config, args.confirm);
      break;
    case "ssh":
      await ssh(config);
      break;
    case "logs":
      await logs(config);
      break;
    case "secrets-push":
      await secretsPush(config);
      break;
    case "smoke":
      await smoke(config);
      break;
  }
}

// Only run when invoked directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("\nDeploy failed:", err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run deploy/cli.test.ts`

- [ ] **Step 5: Commit**

```bash
git add deploy/cli.ts deploy/cli.test.ts
git commit -m "[Danxbot] Add deploy CLI with multi-deployment TARGET routing

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 8: Makefile + example config + gitignore

### Task 8.1: Add deploy Make targets

**Files:**
- Modify: `/home/newms/web/danxbot-flytebot/Makefile`

- [ ] **Step 1: Append deploy section to Makefile**

Add these targets at the bottom of `Makefile` (after the existing system test targets):

```makefile
# --- Deploy ---
#
# Production AWS deploy — per-deployment config at .danxbot/deployments/<TARGET>.yml
#

.PHONY: deploy deploy-status deploy-destroy deploy-ssh deploy-logs \
        deploy-secrets-push deploy-smoke

_require_target:
	@if [ -z "$(TARGET)" ]; then \
		echo "Error: TARGET is required. Usage: make deploy TARGET=gpt"; exit 1; \
	fi

deploy: _require_target ## Deploy to AWS (usage: make deploy TARGET=gpt)
	npx tsx deploy/cli.ts deploy $(TARGET) $(ARGS)

deploy-status: _require_target ## Show infra state + health (usage: make deploy-status TARGET=gpt)
	npx tsx deploy/cli.ts status $(TARGET)

deploy-destroy: _require_target ## Tear down all AWS resources (usage: make deploy-destroy TARGET=gpt ARGS=--confirm)
	npx tsx deploy/cli.ts destroy $(TARGET) $(ARGS)

deploy-ssh: _require_target ## SSH to the deployed instance (usage: make deploy-ssh TARGET=gpt)
	npx tsx deploy/cli.ts ssh $(TARGET)

deploy-logs: _require_target ## Tail container logs (usage: make deploy-logs TARGET=gpt)
	npx tsx deploy/cli.ts logs $(TARGET)

deploy-secrets-push: _require_target ## Sync local .env files to SSM (usage: make deploy-secrets-push TARGET=gpt)
	npx tsx deploy/cli.ts secrets-push $(TARGET)

deploy-smoke: _require_target ## Smoke-test the deployed dashboard (usage: make deploy-smoke TARGET=gpt)
	npx tsx deploy/cli.ts smoke $(TARGET)
```

Also add `deploy deploy-status deploy-destroy deploy-ssh deploy-logs deploy-secrets-push deploy-smoke` to the top-level `.PHONY` line.

- [ ] **Step 2: Verify help rendering**

Run: `make help`
Expected: new `deploy*` targets appear in the help output.

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "[Danxbot] Add deploy-* Make targets with TARGET= gating

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Task 8.2: Add deployments.example.yml + gitignore rules

**Files:**
- Create: `.danxbot/deployments.example.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Write `.danxbot/deployments.example.yml`**

```yaml
# Danxbot deployment config — copy to .danxbot/deployments/<name>.yml
# and fill in. The filename stem becomes the deployment TARGET.
# Multiple deployments can coexist; deploy one with `make deploy TARGET=<name>`.

# Deployment identifier (AWS resource prefix). Lowercase alphanumeric + hyphens.
# For upgrade-in-place of the existing danxbot-gpt-manager deploy, use the
# same name it uses (e.g. `danxbot-production`).
name: example-deployment

# AWS region
region: us-east-1

# Dashboard domain (must be in hosted_zone below, Route53)
domain: danxbot.example.com
hosted_zone: example.com

# AWS CLI profile — REQUIRED. No default-chain fallback (multi-deploy safety).
aws:
  profile: default

# EC2 instance
instance:
  type: t3.small          # new minimum default; bump per deployment as needed
  volume_size: 30         # root volume (GB) — OS + Docker layers
  data_volume_size: 100   # data volume (GB) — repos, mysql, logs; default is generous
  ssh_key: ""             # empty = auto-generate and save to ~/.ssh/<name>-key.pem
  ssh_allowed_cidrs:
    - "0.0.0.0/0"         # restrict to your IP in real deployments

# SSM Parameter Store subtree root — defaults to /danxbot-<TARGET> when omitted
ssm_prefix: /danxbot-example

# Path to a local directory containing .claude.json and .credentials.json.
# Resolved relative to this file. Default /danxbot-flytebot/claude-auth/.
claude_auth_dir: ../../claude-auth

# Dashboard port (inside the container)
dashboard:
  port: 5555

# Git repos that get cloned and run as workers on the instance.
# Each listed repo MUST have .danxbot/config/compose.yml and
# .danxbot/scripts/bootstrap.sh committed in its repo.
repos:
  - name: danxbot
    url: https://github.com/newms87/danxbot-flytebot.git
```

- [ ] **Step 2: Update `.gitignore`**

Append:

```
# Real deploy configs (contain deployment-specific identifiers)
.danxbot/deployments/*.yml
!.danxbot/deployments.example.yml
```

- [ ] **Step 3: Commit**

```bash
git add .danxbot/deployments.example.yml .gitignore
git commit -m "[Danxbot] Add deployments.example.yml + gitignore real configs

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 9: Type-check + full suite

### Task 9.1: Type-check the whole deploy/ tree

- [ ] **Step 1: Run typecheck**

Run: `cd /home/newms/web/danxbot-flytebot && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run full unit suite**

Run: `npx vitest run deploy/`
Expected: every test file from Phases 1–7 passes.

- [ ] **Step 3: Run all tests**

Run: `make test`
Expected: previously green suite remains green — no regressions.

If any fail, fix before proceeding. No commit — this is a verification pass.

---

## Phase 10: Real-deployment configs + cutover

Concretize the two planned deployments and execute cutover. Configs are gitignored (they aren't secrets but they are deployment-specific identifiers).

### Task 10.1: Write .danxbot/deployments/gpt.yml

**Files:**
- Create: `.danxbot/deployments/gpt.yml` (gitignored — not checked in)

- [ ] **Step 1: Confirm both bootstrap scripts from Phases 1 and 2 of the Trello epic are in place**

Run:
```bash
test -x /home/newms/web/danxbot-flytebot/.danxbot/scripts/bootstrap.sh || echo "MISSING: flytebot bootstrap"
test -x /home/newms/web/gpt-manager/.danxbot/scripts/bootstrap.sh || echo "MISSING: gpt-manager bootstrap"
```

If either is missing, stop. Those are prerequisites (see Trello epic https://trello.com/c/cVamGD7X). Do not proceed until both exist and have been manually smoke-tested.

- [ ] **Step 2: Write `.danxbot/deployments/gpt.yml`**

```yaml
# gpt deployment — upgrade in place of existing danxbot-production
name: danxbot-production
region: us-east-1
domain: danxbot.sageus.ai
hosted_zone: sageus.ai

aws:
  profile: gpt

instance:
  type: t3.large          # bumped one size from current t3.medium per user direction
  volume_size: 30
  data_volume_size: 100
  ssh_key: ""             # reuse existing generated key from gpt-manager if present
  ssh_allowed_cidrs:
    - "0.0.0.0/0"

ssm_prefix: /danxbot-gpt

claude_auth_dir: ../../claude-auth

dashboard:
  port: 5555

repos:
  - name: danxbot
    url: https://github.com/newms87/danxbot-flytebot.git
  - name: gpt-manager
    url: https://github.com/newms87/gpt-manager.git
```

- [ ] **Step 3: Push secrets to /danxbot-gpt/ SSM tree**

Before this step: verify local `.env` files are populated for this deployment's repos:
- `/home/newms/web/danxbot-flytebot/.env` (shared)
- `/home/newms/web/danxbot-flytebot/repos/danxbot/.danxbot/.env`
- `/home/newms/web/danxbot-flytebot/repos/gpt-manager/.danxbot/.env`
- `/home/newms/web/danxbot-flytebot/repos/gpt-manager/.env` (if it has app-level secrets)

Run: `cd /home/newms/web/danxbot-flytebot && make deploy-secrets-push TARGET=gpt`
Expected: streaming `aws ssm put-parameter` output for each secret, no errors.

Verify in the AWS console that parameters now exist under `/danxbot-gpt/shared/` and `/danxbot-gpt/repos/danxbot/` and `/danxbot-gpt/repos/gpt-manager/`.

- [ ] **Step 4: Dry-run the deploy to sanity-check**

Run: `make deploy TARGET=gpt ARGS=--dry-run`

Expected: prints its planned Terraform apply, build, push, SSH commands. Confirms no surprises before a real deploy. If anything looks wrong, fix before proceeding.

- [ ] **Step 5: Execute the real deploy (upgrade-in-place)**

Run: `make deploy TARGET=gpt`

Expected:
- Terraform picks up existing `danxbot-production-terraform-state` bucket
- Reports minimal changes (instance type bump + any new IAM policies)
- Brief stop/start of the EC2 as instance type changes
- Dashboard comes back up; health check passes at `https://danxbot.sageus.ai/health`

If Terraform reports unexpected create/destroy actions, STOP and review — do not auto-approve.

- [ ] **Step 6: Smoke test**

Run: `make deploy-smoke TARGET=gpt`
Expected: 200 response + logs visible via `make deploy-logs TARGET=gpt`.

- [ ] **Step 7: Manual dispatch test**

Add a trivial Trello card to the danxbot repo's board (assigned to the `danxbot-production` poller). Verify the worker picks it up and processes it. Then do the same for gpt-manager's board.

- [ ] **Step 8: Clean up legacy SSM tree**

Once satisfied, delete the old flat `/danxbot/*` SSM params manually via AWS console or:

```bash
aws --profile gpt ssm get-parameters-by-path --path /danxbot/ --recursive --query "Parameters[*].Name" --output text \
  | tr '\t' '\n' | while read -r name; do
      [ -n "$name" ] && aws --profile gpt ssm delete-parameter --name "$name"
    done
```

No commit from this task — `.danxbot/deployments/gpt.yml` is gitignored.

### Task 10.2: Write .danxbot/deployments/flytedesk.yml (after platform bootstrap lands)

This task is BLOCKED on Phase 3 of the Trello epic (platform bootstrap script). Do not start until `/home/newms/web/platform/.danxbot/scripts/bootstrap.sh` exists and has been smoke-tested.

**Files:**
- Create: `.danxbot/deployments/flytedesk.yml` (gitignored)

- [ ] **Step 1: Gather the required inputs**

Ask the user for:
- Desired domain and hosted zone
- AWS profile name (flytedesk credentials)
- Instance type appropriate for platform's Sail stack (likely `t3.medium` or `t3.large`)

- [ ] **Step 2: Write `.danxbot/deployments/flytedesk.yml`**

Use the values gathered above:

```yaml
name: flytedesk-platform
region: us-east-1
domain: <provided>
hosted_zone: <provided>

aws:
  profile: flytedesk

instance:
  type: t3.medium
  volume_size: 30
  data_volume_size: 100

ssm_prefix: /danxbot-flytedesk

claude_auth_dir: ../../claude-auth

dashboard:
  port: 5555

repos:
  - name: platform
    url: https://github.com/flytedesk/platform.git
```

- [ ] **Step 3: Push secrets**

Run: `make deploy-secrets-push TARGET=flytedesk`

- [ ] **Step 4: Deploy (fresh — no existing state)**

Run: `make deploy TARGET=flytedesk`
Expected: first deploy creates all AWS resources from scratch. Takes ~5 minutes.

- [ ] **Step 5: Smoke test**

Run: `make deploy-smoke TARGET=flytedesk`
Expected: 200 response.

- [ ] **Step 6: Manual dispatch test on the platform Trello board**

---

## Phase 11: Manual verification checklist

Walk through the spec's verification checklist at least once before marking the work complete:

- [ ] **Fresh deploy from zero** — use a throwaway deployment name (e.g., `throwaway`). `make deploy TARGET=throwaway` from zero. Every step of the CLI completes. Dashboard answers at its domain. Smoke passes.

- [ ] **Idempotent redeploy** — `make deploy TARGET=throwaway` a second time. Terraform reports no changes. Image rebuilds, pushes, containers restart cleanly. No errors.

- [ ] **Config-change deploy** — add a second repo to `deployments/throwaway.yml` and redeploy. Verify the new repo is cloned, bootstrapped, and a worker comes up, WITHOUT disturbing the first worker.

- [ ] **Destroy + recreate** — `make deploy-destroy TARGET=throwaway ARGS=--confirm`. All AWS resources removed. Data volume gone. Then redeploy from zero to verify the full pipeline.

- [ ] **Upgrade-in-place gpt cutover** — completed in Task 10.1.

- [ ] **Flytedesk fresh deploy** — completed in Task 10.2 (if platform bootstrap is ready).

---

## Self-Review

Before handing this plan to implementation:

- [ ] **Spec coverage** — every requirement in `docs/superpowers/specs/2026-04-17-production-deploy-port-design.md` maps to a task above. The only spec items not covered here are the three bootstrap.sh scripts (tracked separately as the Trello epic).

- [ ] **Placeholder scan** — no TBD, TODO, "implement later", "handle edge cases" without concrete behavior. Every test has real assertions. Every code step has complete code.

- [ ] **Type consistency** — `DeployConfig` shape is consistent across `config.ts`, `test-helpers.ts`, and all consumers. `RemoteHost` constructor signature is stable. `CollectedSecrets`/`ImageTags`/`CliArgs` types have single authoritative definitions.

- [ ] **Incremental testability** — each phase produces a commit-worthy, testable increment. Phases 1–7 produce a fully unit-tested CLI even before any real AWS call. Phases 8–10 exercise it against live AWS.
