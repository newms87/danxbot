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
  // Single-quote the value so the shell does not interpolate `$VAR` or
  // evaluate backticks. Laravel-style values like `${APP_NAME}` are stored
  // literally in SSM and resolved later by the app reading the materialized
  // .env. Single-quote escape for embedded quotes: `'` → `'\''`.
  const putOne = (name: string, value: string): string =>
    awsCmd(
      config.aws.profile,
      `ssm put-parameter --name "${name}" --type SecureString --overwrite --region ${config.region} --value '${value.replace(/'/g, "'\\''")}'`,
    );
  // SSM rejects empty values — skip them. A key with an empty local value is
  // effectively "not set" and will be absent from the materialized .env.
  const pushIfSet = (name: string, value: string): void => {
    if (value !== "") cmds.push(putOne(name, value));
  };

  for (const [k, v] of Object.entries(collected.shared)) {
    pushIfSet(`${config.ssmPrefix}/shared/${k}`, v);
  }
  for (const [repoName, groups] of Object.entries(collected.perRepo)) {
    for (const [k, v] of Object.entries(groups.danxbot)) {
      pushIfSet(`${config.ssmPrefix}/repos/${repoName}/${k}`, v);
    }
    for (const [k, v] of Object.entries(groups.app)) {
      pushIfSet(`${config.ssmPrefix}/repos/${repoName}/REPO_ENV_${k}`, v);
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
