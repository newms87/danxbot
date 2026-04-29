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
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Expand a leading `~` to the operator's home directory. Mirrors POSIX
 * shell behavior: `~` and `~/sub` are treated as `$HOME` / `$HOME/sub`,
 * but a `~` anywhere else in the path is left literal (matches `bash`,
 * `zsh`, and Python's `os.path.expanduser`). Letting `~` work in
 * `claude_auth_dir` lets the deploy yml point at the live `claude` CLI's
 * auth dir directly (`claude_auth_dir: "~"`) — no stamp-in-time snapshot,
 * no manual refresh needed.
 *
 * YAML quirk: bare `~` is YAML's canonical representation of null.
 * Configs MUST quote it as `"~"` for the value to survive parsing as a
 * string. With unquoted `~`, the YAML parser yields null, the
 * `optionalString` helper falls back to the default, and this function
 * never gets a chance to see the tilde.
 */
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * One connected repo in a deployment. `appEnvSubpath`, when set, is the
 * relative subdirectory (e.g. "ssap") where the app's .env lives for repos
 * whose application does not sit at the repo root. `workerHost`, when set,
 * overrides the default `danxbot-worker-<name>` docker hostname the
 * dashboard uses to proxy to this worker — required for repos whose compose
 * file renames the container.
 */
export interface DeployRepo {
  name: string;
  url: string;
  appEnvSubpath?: string;
  /** Host port the worker's dispatch API binds to (must be unique per repo on an instance). */
  workerPort: number;
  /**
   * Docker hostname the dashboard uses to proxy to this worker. Defaults to
   * `danxbot-worker-<name>` (see `workerHost` in `src/dashboard/dispatch-proxy.ts`)
   * when omitted. Set this when the repo's compose `container_name` deviates
   * from the default — without it the dashboard silently 502s on dispatch.
   */
  workerHost?: string;
  /**
   * Default branch to fetch + reset to during clone-or-pull. Defaults to
   * `"main"` when omitted in the deployment yml. Set explicitly for repos
   * that track a different default (e.g. `master`, `develop`) — without it
   * the deploy syncs against `origin/main` which doesn't exist on those
   * repos and dies with a confusing git error.
   */
  branch: string;
}

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
  repos: DeployRepo[];
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
  // Tilde expansion happens BEFORE `resolve` — otherwise `resolve(configDir, "~")`
  // produces `<configDir>/~` (literal), defeating the point.
  const claudeAuthDir = resolve(configDir, expandTilde(claudeAuthRaw));

  const repos: DeployRepo[] = [];
  if (Array.isArray(yaml.repos)) {
    for (const repo of yaml.repos) {
      if (typeof repo === "object" && repo !== null) {
        const r = repo as Record<string, unknown>;
        const rName = requireString(r, "name", "repos[].name");
        const rUrl = requireString(r, "url", "repos[].url");

        // app_env_subpath — optional relative subdirectory (e.g., "ssap") where
        // the app .env lives, for repos whose app does not sit at the repo root.
        // Validated to prevent path traversal or absolute writes during materialize.
        let appEnvSubpath: string | undefined;
        const rawSubpath = r["app_env_subpath"];
        if (rawSubpath !== undefined && rawSubpath !== null) {
          if (typeof rawSubpath !== "string") {
            errors.push(
              `repos[].app_env_subpath must be a string (got ${typeof rawSubpath})`,
            );
          } else {
            // Strip a trailing slash ("ssap/") — normalizes the one case where
            // authors write either form and we'd otherwise build "repo//.env".
            const normalized = rawSubpath.trim().replace(/\/+$/, "");
            if (normalized === "") {
              // Empty or whitespace-only is a config mistake — omit the key
              // instead. We used to silently collapse to "unset" but that is
              // a silent fallback on a config key (per code-quality.md).
              errors.push(
                `repos[].app_env_subpath must not be empty — omit the key to use repo root`,
              );
            } else if (normalized.startsWith("/")) {
              errors.push(
                `repos[].app_env_subpath must not be absolute: "${normalized}"`,
              );
            } else if (normalized.split("/").some((seg) => seg === "..")) {
              errors.push(
                `repos[].app_env_subpath must not contain ".." path traversal: "${normalized}"`,
              );
            } else {
              appEnvSubpath = normalized;
            }
          }
        }

        const rawPort = r["worker_port"];
        let workerPort = 0;
        if (rawPort === undefined || rawPort === null) {
          errors.push(
            `repos[].worker_port is required (unique port per repo, e.g. 5561)`,
          );
        } else if (
          typeof rawPort !== "number" ||
          !Number.isInteger(rawPort) ||
          rawPort < 1 ||
          rawPort > 65535
        ) {
          errors.push(
            `repos[].worker_port must be an integer in [1, 65535] (got ${typeof rawPort === "number" ? rawPort : typeof rawPort})`,
          );
        } else {
          workerPort = rawPort;
        }

        // worker_host — optional override for the default
        // `danxbot-worker-<name>` docker hostname. Validated as a non-empty
        // whitespace-free string; whitespace inside a hostname is never
        // legal (Docker DNS labels can't contain spaces) and an empty
        // string would silently revert to the default — both are config
        // mistakes the loader rejects loudly per the no-silent-fallback
        // rule on config keys.
        let workerHost: string | undefined;
        const rawHost = r["worker_host"];
        if (rawHost !== undefined && rawHost !== null) {
          if (typeof rawHost !== "string") {
            errors.push(
              `repos[].worker_host must be a string (got ${typeof rawHost})`,
            );
          } else {
            const trimmed = rawHost.trim();
            if (trimmed === "") {
              errors.push(
                `repos[].worker_host must not be empty — omit the key to use the default danxbot-worker-<name>`,
              );
            } else if (/\s/.test(trimmed)) {
              errors.push(
                `repos[].worker_host must not contain whitespace: "${rawHost}"`,
              );
            } else {
              workerHost = trimmed;
            }
          }
        }

        // branch — optional override for the default branch (`main`).
        // Trimmed and validated like worker_host: empty / non-string /
        // whitespace-containing values are loud config errors. The default
        // is applied here so the runtime DeployRepo always carries a
        // concrete branch — consumers (buildCloneOrPullCommand) never
        // need to fallback.
        let branch = "main";
        const rawBranch = r["branch"];
        if (rawBranch !== undefined && rawBranch !== null) {
          if (typeof rawBranch !== "string") {
            errors.push(
              `repos[].branch must be a string (got ${typeof rawBranch})`,
            );
          } else {
            const trimmed = rawBranch.trim();
            if (trimmed === "") {
              errors.push(
                `repos[].branch must not be empty — omit the key to use the default "main"`,
              );
            } else if (/\s/.test(trimmed)) {
              errors.push(
                `repos[].branch must not contain whitespace: "${rawBranch}"`,
              );
            } else {
              branch = trimmed;
            }
          }
        }

        if (rName && rUrl && workerPort) {
          const base: DeployRepo = { name: rName, url: rUrl, workerPort, branch };
          if (appEnvSubpath !== undefined) base.appEnvSubpath = appEnvSubpath;
          if (workerHost !== undefined) base.workerHost = workerHost;
          repos.push(base);
        }
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
