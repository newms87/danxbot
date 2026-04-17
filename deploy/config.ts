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
