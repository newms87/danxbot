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

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findConfigPath,
  loadConfig,
  type DeployConfig,
  type DeployRepo,
} from "./config.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Compose the positional repo args for the remote `materialize-secrets.sh`
 * invocation. Each repo becomes `name` or `name:app_env_subpath` (the latter
 * when the repo's app .env lives in a subdirectory — e.g. platform's `ssap`).
 * Args are joined by a single space — the repo name regex in config.ts
 * forbids whitespace so no quoting is required.
 */
export function buildMaterializeRepoArgs(repos: DeployRepo[]): string {
  return repos
    .map((r) => (r.appEnvSubpath ? `${r.name}:${r.appEnvSubpath}` : r.name))
    .join(" ");
}

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

  // Step 0: push local .env files to SSM. Runs every deploy so local secret
  // changes reach the instance on the next deploy without a separate command.
  // Idempotent — put-parameter uses --overwrite; unchanged values are a no-op
  // from the instance's perspective. Secrets are redacted from stdout (see
  // pushSecrets + runStreaming logLabel).
  console.log("\n── Syncing local .env → SSM ──");
  pushSecrets(config);

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

  // Clone repos FIRST so the materializer writes .env files into existing
  // git checkouts (not into empty dirs that would block a later clone).
  // Tokens come from SSM directly via aws get-parameter, not via materialize,
  // so there is no chicken-and-egg here.
  const tokens = fetchRepoTokens(config);
  syncRepos(remote, config, tokens);

  // Materialize secrets: /danxbot/.env (shared) + per-repo .env into the
  // cloned repo dirs.
  const materializeScript = resolve(
    __dirname,
    "templates/materialize-secrets.sh",
  );
  remote.scpUpload(materializeScript, "/tmp/materialize-secrets.sh");
  remote.sshRun(
    "sudo mv /tmp/materialize-secrets.sh /usr/local/bin/materialize-secrets.sh && sudo chmod +x /usr/local/bin/materialize-secrets.sh",
  );
  const repoArgs = buildMaterializeRepoArgs(config.repos);
  remote.sshRunStreaming(
    `sudo DANXBOT_ROOT=/danxbot /usr/local/bin/materialize-secrets.sh ${config.ssmPrefix} ${config.region} ${repoArgs}`,
  );

  // Run each repo's bootstrap.sh (deps install now that code + .env both exist)
  runBootstrapScripts(remote, config);

  // Launch shared-infra compose
  uploadAndRestartInfra(remote, ecrImage, config.dashboard.port, config.region);

  // Launch per-repo workers. Worker compose files reference
  // ${DANXBOT_WORKER_IMAGE} + ${CLAUDE_AUTH_DIR} which only exist in prod —
  // inject them inline so the same compose works in dev without changes.
  launchWorkers(remote, config, {
    workerImage: ecrImage,
    claudeAuthDir: "/danxbot/claude-auth",
  });

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
  } catch (err) {
    console.log("  No infrastructure deployed yet (or status check failed).");
    console.log(
      `  Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(`  Run: npx tsx deploy/cli.ts deploy ${config.name}`);
  }
}

async function destroy(
  config: DeployConfig,
  confirm: boolean,
): Promise<void> {
  console.log("\n── DESTROYING INFRASTRUCTURE ──");
  console.log(
    "  This will permanently delete EC2, EBS, EIP, ECR, Route53, SG, IAM.",
  );
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
  if (config.repos.length === 0) {
    throw new Error(
      `Cannot smoke-test ${config.name}: no repos configured in the deployment yml`,
    );
  }
  console.log("\n── Smoke: dispatching trivial prompt ──");
  const url = `https://${config.domain}`;
  const response = await fetch(`${url}/api/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "echo", repo: config.repos[0].name }),
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
