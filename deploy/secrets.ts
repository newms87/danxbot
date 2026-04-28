/**
 * Secrets orchestration: local .env files → SSM (push) and vice versa (materialize via remote script).
 *
 * Local file → SSM path mapping:
 *   ./.env                              → <ssm_prefix>/shared/<KEY>
 *   ./repos/<name>/.danxbot/.env        → <ssm_prefix>/repos/<name>/<KEY>
 *   ./repos/<name>/.env                 → <ssm_prefix>/repos/<name>/REPO_ENV_<KEY>
 *
 * The instance-side materializer (templates/materialize-secrets.sh) reverses this.
 *
 * Per-target overrides: when collectDeploymentSecrets is called with a target
 * name (e.g. "platform"), each .env file is layered with a sibling .env.<target>
 * file at the SAME directory. Override keys win; base-only keys are preserved;
 * override-only keys are added; a missing override file is a no-op. Local files
 * are never modified — the merge is in-memory only, applied before SSM push.
 * This keeps prod-only values (Slack channel ID, prod-specific endpoints) out
 * of the dev .env without forcing every operator to share one .env between
 * deployments. Override files are gitignored.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import type { DeployConfig } from "./config.js";
import { awsCmd, runStreaming } from "./exec.js";
import {
  sharedKeyPath,
  repoKeyPath,
  repoAppKeyPath,
} from "./ssm-paths.js";

export interface CollectedSecrets {
  shared: Record<string, string>;
  perRepo: Record<
    string,
    { danxbot: Record<string, string>; app: Record<string, string> }
  >;
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

/**
 * Read `<basePath>` and, when `target` is provided, layer the sibling
 * `<basePath>.<target>` file on top with override semantics. Missing files
 * (base or override) are treated as empty maps.
 */
function readEnvWithOverride(
  basePath: string,
  target: string | undefined,
): Record<string, string> {
  const base = parseEnvFile(basePath);
  if (!target) return base;
  const override = parseEnvFile(`${basePath}.${target}`);
  return { ...base, ...override };
}

export function collectDeploymentSecrets(
  config: DeployConfig,
  cwd: string = process.cwd(),
  target?: string,
): CollectedSecrets {
  const shared = readEnvWithOverride(resolve(cwd, ".env"), target);
  const perRepo: CollectedSecrets["perRepo"] = {};
  for (const repo of config.repos) {
    // When app_env_subpath is set the app .env lives under the subpath
    // (e.g., platform's Sail env at ssap/.env). The danxbot agent env path
    // is unchanged — it's a danxbot convention, not app-defined.
    const appEnvPath = repo.appEnvSubpath
      ? resolve(cwd, "repos", repo.name, repo.appEnvSubpath, ".env")
      : resolve(cwd, "repos", repo.name, ".env");
    perRepo[repo.name] = {
      danxbot: readEnvWithOverride(
        resolve(cwd, "repos", repo.name, ".danxbot/.env"),
        target,
      ),
      app: readEnvWithOverride(appEnvPath, target),
    };
  }
  return { shared, perRepo };
}

export function buildSsmPutCommands(
  config: DeployConfig,
  collected: CollectedSecrets,
): string[] {
  const cmds: string[] = [];
  // Single-quote the value so the shell does not interpolate `$VAR` or
  // evaluate backticks. Laravel-style values like `${APP_NAME}` are stored
  // literally in SSM and resolved later by the app reading the materialized
  // .env. Single-quote escape for embedded quotes: `'` → `'\''`.
  // `--tier Intelligent-Tiering` lets SSM auto-promote parameters that exceed
  // the 4KB Standard-tier limit (e.g. base64-encoded RSA keys) to Advanced
  // tier automatically, without charging Advanced rates for sub-4KB params.
  // Without this, any secret > 4KB fails deploy with a ValidationException.
  const putOne = (name: string, value: string): string =>
    awsCmd(
      config.aws.profile,
      `ssm put-parameter --name "${name}" --type SecureString --overwrite --tier Intelligent-Tiering --region ${config.region} --value '${value.replace(/'/g, "'\\''")}'`,
    );
  // SSM rejects empty values — skip them. A key with an empty local value is
  // effectively "not set" and will be absent from the materialized .env.
  const pushIfSet = (name: string, value: string): void => {
    if (value !== "") cmds.push(putOne(name, value));
  };

  for (const [k, v] of Object.entries(collected.shared)) {
    pushIfSet(sharedKeyPath(config.ssmPrefix, k), v);
  }
  for (const [repoName, groups] of Object.entries(collected.perRepo)) {
    for (const [k, v] of Object.entries(groups.danxbot)) {
      pushIfSet(repoKeyPath(config.ssmPrefix, repoName, k), v);
    }
    for (const [k, v] of Object.entries(groups.app)) {
      pushIfSet(repoAppKeyPath(config.ssmPrefix, repoName, k), v);
    }
  }
  return cmds;
}

/**
 * Build per-target overrides that are ALWAYS synthesized from the deploy YML
 * (never from local .env). These keys must match the target's actual repo
 * list — NOT the operator's local dev list, which may include unrelated
 * repos. Returns:
 *   REPOS — "<name>:<url>,..." for each repo in this deployment
 *   REPO_WORKER_PORTS — "<name>:<port>,..." matching REPOS entries
 */
export function buildTargetOverrides(
  config: DeployConfig,
): Record<string, string> {
  const reposValue = config.repos
    .map((r) => `${r.name}:${r.url}`)
    .join(",");
  const portsValue = config.repos
    .map((r) => `${r.name}:${r.workerPort}`)
    .join(",");
  return {
    REPOS: reposValue,
    REPO_WORKER_PORTS: portsValue,
  };
}

/**
 * Dispatch token lookup — existing SSM value wins; otherwise generate a fresh
 * 64-hex token, print it once to stdout so the operator can save it, and
 * return it for upload.
 *
 * Regenerating silently would invalidate active callers' credentials on every
 * deploy, so we ONLY treat `ParameterNotFound` as "generate a new one." Any
 * other AWS error (expired auth, throttling, network) re-throws and aborts
 * the deploy — forcing the operator to fix the underlying problem instead of
 * rotating every external caller's credentials.
 */
export function getOrCreateDispatchToken(
  config: DeployConfig,
  exec: (cmd: string) => string = defaultTokenFetch,
): string {
  const paramName = sharedKeyPath(config.ssmPrefix, "DANXBOT_DISPATCH_TOKEN");
  try {
    const raw = exec(
      awsCmd(
        config.aws.profile,
        `ssm get-parameter --name "${paramName}" --with-decryption --region ${config.region} --query Parameter.Value --output text`,
      ),
    );
    const existing = raw.trim();
    // `aws ssm get-parameter --output text` writes the literal string "None"
    // when the parameter exists but has no value. Reject that as invalid —
    // never treat it as a real token.
    if (existing && existing !== "None") return existing;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("ParameterNotFound")) {
      throw new Error(
        `Failed to read ${paramName} from SSM (not a ParameterNotFound): ${msg}`,
      );
    }
    // ParameterNotFound — fall through to generate below.
  }
  const generated = randomBytes(32).toString("hex");
  console.log("");
  console.log(
    `  Generated new DANXBOT_DISPATCH_TOKEN for ${config.name}:`,
  );
  console.log(`    ${generated}`);
  console.log(
    "  SAVE THIS — required by external callers (Authorization: Bearer <token>).",
  );
  console.log("");
  return generated;
}

/**
 * Run an AWS CLI command, capturing stderr so ParameterNotFound can be
 * distinguished from real errors. Throws an Error whose message includes the
 * aws-cli stderr text — callers inspect `message` for `"ParameterNotFound"`.
 */
function defaultTokenFetch(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    throw new Error(`${e.message ?? "exec failed"}\n${stderr}`);
  }
}

/**
 * Pure orchestrator-of-pure-helpers: collect + layer overrides + merge token,
 * return the full SSM put-parameter command list. Side-effect-free so tests
 * can verify the merge order (overrides win over local .env, dispatch token
 * always lands in shared) without mocking the runner.
 *
 * `pushSecrets` calls this and then runs each command through `runStreaming`.
 */
export function buildPushSecretsCommands(
  config: DeployConfig,
  collected: CollectedSecrets,
  overrides: Record<string, string>,
  dispatchToken: string,
): string[] {
  // Target overrides win over local .env — prevents an operator's local
  // REPOS (which lists every repo they work with) from leaking into a
  // target that should only see its own repos.
  const merged: CollectedSecrets = {
    ...collected,
    shared: {
      ...collected.shared,
      ...overrides,
      DANXBOT_DISPATCH_TOKEN: dispatchToken,
    },
  };
  return buildSsmPutCommands(config, merged);
}

export function pushSecrets(
  config: DeployConfig,
  cwd: string = process.cwd(),
  target?: string,
): void {
  const collected = collectDeploymentSecrets(config, cwd, target);
  const overrides = buildTargetOverrides(config);
  const token = getOrCreateDispatchToken(config);
  const cmds = buildPushSecretsCommands(config, collected, overrides, token);

  console.log(`\n── Pushing ${cmds.length} secret(s) to SSM ──`);
  for (const cmd of cmds) {
    // `aws ssm put-parameter --name "<path>" ... --value '<SECRET>'` — strip
    // to the --name path for log output so secret values never hit stdout.
    // Idempotent: put-parameter uses --overwrite in buildSsmPutCommands.
    const nameMatch = cmd.match(/--name "([^"]+)"/);
    const label = nameMatch ? `aws ssm put-parameter ${nameMatch[1]}` : "aws ssm put-parameter";
    runStreaming(cmd, { logLabel: label });
  }
}
