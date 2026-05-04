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
  saveGeneratedSshKey,
} from "./provision.js";
import { buildAndPush } from "./build.js";
import { RemoteHost } from "./remote.js";
import { waitForHealthy } from "./health.js";
import { pushSecrets } from "./secrets.js";
import { syncRepos, runBootstrapScripts } from "./bootstrap-repos.js";
import { clearCachedOutputs, writeCachedOutputs } from "./output-cache.js";
import { resolveOutputs } from "./outputs-resolver.js";
import { launchWorkers } from "./workers.js";
import {
  pruneStaleDockerImages,
  uploadAndRestartInfra,
} from "./compose-infra.js";
import { awsCmd, isDryRun, run, setDryRun } from "./exec.js";
import { DRY_RUN_GITHUB_TOKEN } from "./dry-run-placeholders.js";
import { sharedKeyPath, repoKeyPath } from "./ssm-paths.js";
import { createUser } from "./create-user.js";
import { ensureRootUser } from "./ensure-root-user.js";
import {
  preflightClaudeAuth,
  buildRealDeps as buildClaudeAuthDeps,
} from "./preflight-claude-auth.js";

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
  "create-user",
  "ensure-root-user",
] as const;
type Command = (typeof COMMANDS)[number];

interface CliArgsBase {
  target: string;
  dryRun: boolean;
  confirm: boolean;
}

/**
 * Discriminated union: `username` is structurally present iff `command` is
 * "create-user". Lets callers access `args.username` without a non-null
 * assertion — the type narrows once the switch arm is matched.
 */
export type CliArgs =
  | (CliArgsBase & { command: Exclude<Command, "create-user"> })
  | (CliArgsBase & { command: "create-user"; username: string });

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

  const command = rawCommand as Command;
  const base: CliArgsBase = {
    target,
    dryRun: argv.includes("--dry-run"),
    confirm: argv.includes("--confirm"),
  };

  if (command === "create-user") {
    const third = argv[2];
    if (!third || third.startsWith("--")) {
      throw new Error(
        "USERNAME is required for create-user (e.g., create-user gpt alice)",
      );
    }
    return { ...base, command, username: third };
  }
  return { ...base, command };
}

function ensureBackend(config: DeployConfig): void {
  bootstrapBackend(config);
  terraformInit(config);
}

/**
 * Fetch each repo's DANX_GITHUB_TOKEN from SSM so we can clone private repos.
 *
 * Exported so it's testable; the optional `runCmd` injection lets tests
 * supply a fake aws-cli without a real ssm round-trip.
 */
export function fetchRepoTokens(
  config: DeployConfig,
  runCmd: (cmd: string) => string = run,
): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const repo of config.repos) {
    const cmd = awsCmd(
      config.aws.profile,
      `ssm get-parameter --name "${repoKeyPath(config.ssmPrefix, repo.name, "DANX_GITHUB_TOKEN")}" --with-decryption --region ${config.region} --query Parameter.Value --output text`,
    );
    tokens[repo.name] = runCmd(cmd);
  }
  return tokens;
}

async function deploy(config: DeployConfig, target: string): Promise<void> {
  console.log("\n═══════════════════════════════════════");
  console.log(`  DEPLOYING ${config.name}`);
  console.log("═══════════════════════════════════════");

  // Preflight: validate / refresh / reauth claude-auth BEFORE any
  // destructive deploy step (SSM push, Terraform apply, ECR build, scp).
  // Catches the case where `claude_auth_dir` points at a snapshot dir
  // (e.g. platform's `../../claude-auth/`) whose token expired since
  // the last login, and either silently refreshes via the OAuth refresh
  // grant or interactively launches `claude auth login` against the
  // snapshot dir so the operator can re-auth in their browser. Skipped
  // in dry-run because writing fresh creds + spawning interactive
  // claude both qualify as side effects. See preflight-claude-auth.ts.
  if (!isDryRun()) {
    console.log("\n── Validating claude-auth ──");
    const result = await preflightClaudeAuth(
      config.claudeAuthDir,
      buildClaudeAuthDeps(),
    );
    if (!result.ok) {
      console.error(`\n✗ claude-auth preflight failed: ${result.summary}`);
      process.exit(1);
    }
    console.log(`  claude-auth ${result.action}`);
  }

  // Step 0: push local .env files to SSM. Runs every deploy so local secret
  // changes reach the instance on the next deploy without a separate command.
  // Idempotent — put-parameter uses --overwrite; unchanged values are a no-op
  // from the instance's perspective. Secrets are redacted from stdout (see
  // pushSecrets + runStreaming logLabel).
  // Per-target .env.<target> overlays are layered over .env at this step —
  // see deploy/secrets.ts header for the override contract.
  console.log("\n── Syncing local .env → SSM ──");
  await pushSecrets(config, process.cwd(), target);

  ensureBackend(config);
  const outputs = terraformApply(config);

  // Cache outputs so read-only commands (create-user, ssh, smoke) skip the
  // ~10s bootstrap+init+output Terraform pre-flight on subsequent runs. See
  // output-cache.ts header for the full rationale.
  writeCachedOutputs(target, outputs);

  console.log(`\n  Instance: ${outputs.instanceId}`);
  console.log(`  IP: ${outputs.publicIp}`);
  console.log(`  ECR: ${outputs.ecrRepositoryUrl}`);

  saveGeneratedSshKey(config);

  const remote = new RemoteHost(config, outputs.publicIp);

  console.log("\n── Waiting for instance SSH readiness ──");
  await remote.waitForSsh();

  // Reclaim disk from prior deploys BEFORE any docker pull runs. Without
  // this, weeks of deploys leave 20+GB of orphaned image layers and the
  // EBS root volume fills up, breaking the next pull mid-deploy with "no
  // space left on device". See `pruneStaleDockerImages` docstring for why
  // this uses `image prune -af` instead of the more aggressive
  // `system prune` (which would remove the danxbot-net bridge).
  pruneStaleDockerImages(remote);

  const ecrImage = buildAndPush(config, outputs.ecrRepositoryUrl);

  remote.uploadClaudeAuth();

  // Clone repos FIRST so the materializer writes .env files into existing
  // git checkouts (not into empty dirs that would block a later clone).
  // Tokens come from SSM directly via aws get-parameter, not via materialize,
  // so there is no chicken-and-egg here.
  //
  // In dry-run, `fetchRepoTokens` would return empty strings (`run` short-
  // circuits), and `buildCloneOrPullCommand`'s regex rejects empty tokens —
  // the deploy would error out before printing the would-clone command. Worse,
  // a real fetched token would land verbatim in dry-run stdout via the
  // `https://x-access-token:<TOKEN>@github.com/...` URL inside `runStreaming`.
  // Substitute a placeholder so the dry-run output shows the URL shape
  // without leaking secrets.
  const tokens = isDryRun()
    ? Object.fromEntries(config.repos.map((r) => [r.name, DRY_RUN_GITHUB_TOKEN]))
    : fetchRepoTokens(config);
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
  uploadAndRestartInfra(
    remote,
    ecrImage,
    config.dashboard.port,
    config.region,
    config.repos.map((r) => r.name),
  );

  // Launch per-repo workers. Worker compose files reference
  // ${DANXBOT_WORKER_IMAGE} + ${CLAUDE_AUTH_DIR} which only exist in prod —
  // inject them inline so the same compose works in dev without changes.
  // The danxbot repo SHA is already baked into ecrImage via the Dockerfile
  // ARG/ENV (driven by deploy/build.ts) — getDanxbotCommit() reads
  // process.env.DANXBOT_COMMIT at runtime, no compose-side passthrough.
  launchWorkers(remote, config, {
    workerImage: ecrImage,
    claudeAuthDir: "/danxbot/claude-auth",
  });

  // Health
  const health = await waitForHealthy(`https://${config.domain}`);

  // Provision / refresh the dashboard root user from the materialized
  // DANX_DASHBOARD_ROOT_USER env. Idempotent — silent no-op when the
  // password already matches, so safe to run on every deploy.
  // `ensureRootUser` handles its own dry-run check internally (it uses
  // `execSync` directly, not `runStreaming`, so it can't lean on the
  // exec.ts gate).
  if (health.healthy) {
    try {
      await ensureRootUser(config, outputs.publicIp);
    } catch (err) {
      console.log(
        `  WARN: ensure-root-user failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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

async function status(config: DeployConfig, target: string): Promise<void> {
  console.log("\n── Infrastructure Status ──");
  try {
    const outputs = resolveOutputs(target, config);
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
  target: string,
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
  // Drop the IP cache — instance is gone; a stale IP would mislead the next
  // read-only command into SSHing to a dead host instead of failing fast.
  clearCachedOutputs(target);
  console.log("\n  All infrastructure destroyed.");
}

async function ssh(config: DeployConfig, target: string): Promise<void> {
  const outputs = resolveOutputs(target, config);
  new RemoteHost(config, outputs.publicIp).openSshSession();
}

async function logs(config: DeployConfig, target: string): Promise<void> {
  const outputs = resolveOutputs(target, config);
  new RemoteHost(config, outputs.publicIp).tailLogs();
}

async function secretsPush(config: DeployConfig, target: string): Promise<void> {
  await pushSecrets(config, process.cwd(), target);
}

async function smoke(config: DeployConfig): Promise<void> {
  if (config.repos.length === 0) {
    throw new Error(
      `Cannot smoke-test ${config.name}: no repos configured in the deployment yml`,
    );
  }
  const token = run(
    awsCmd(
      config.aws.profile,
      `ssm get-parameter --name "${sharedKeyPath(config.ssmPrefix, "DANXBOT_DISPATCH_TOKEN")}" --with-decryption --region ${config.region} --query Parameter.Value --output text`,
    ),
  );
  if (!token || token === "None") {
    throw new Error(
      `Cannot smoke-test ${config.name}: DANXBOT_DISPATCH_TOKEN is not set in SSM. Run secrets-push first.`,
    );
  }

  const repo = config.repos[0].name;
  console.log(
    `\n── Smoke: POST https://${config.domain}/api/launch (repo=${repo}) ──`,
  );
  // The worker's `api_token` is used as the bearer for status-callback POSTs
  // to the configured `status_url`. Smoke omits `status_url` entirely so no
  // callback is exercised, and we pass a placeholder api_token to keep the
  // dispatch-auth credential (the bearer we sent above) separate from the
  // worker-to-callback credential they represent at the semantic level.
  //
  // `workspace: "system-test"` references the danxbot-shipped workspace
  // (`src/poller/inject/workspaces/system-test/`) that every connected
  // repo's poller injects into `<repo>/.danxbot/workspaces/system-test/`
  // on every tick — so the workspace is available on every deployed
  // target by construction. Required since the P5 cutover (commit 9baf431)
  // retired the legacy `{repo, task, api_token}` shape; the worker now
  // 400s every body without an explicit workspace.
  const response = await fetch(`https://${config.domain}/api/launch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      repo,
      workspace: "system-test",
      task:
        "Connectivity smoke test. Reply with the word OK and immediately call danxbot_complete with status=completed and summary=\"smoke ok\". Do nothing else.",
      api_token: "smoke-test-no-callback",
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Smoke failed: HTTP ${response.status} — ${body.slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  console.log(`  ✓ Smoke OK (${response.status})`);
  console.log(`  Response: ${JSON.stringify(parsed)}`);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const path = findConfigPath(process.cwd(), args.target);
  const config = loadConfig(path);

  // `mode: local` marks a target as non-deployable (deploy/targets/local.yml).
  // Refuse every CLI command for it — accidentally running `make deploy
  // TARGET=local` would push the operator's dev repo list to AWS, which
  // is exactly what the local target exists to prevent.
  if (config.mode === "local") {
    throw new Error(
      `Refusing to run \`${args.command}\` against target "${args.target}" — its yml ` +
        `declares \`mode: local\` (non-deployable). This target is for local-runtime ` +
        `consumers only (src/target.ts#loadTarget). To deploy, pass a target with ` +
        `\`mode: deploy\` (the default) — e.g. gpt or platform.`,
    );
  }

  console.log(`\nDanxbot Deploy — ${config.name} (target: ${args.target})`);
  console.log(`  Region: ${config.region}`);
  console.log(`  Domain: ${config.domain}`);

  // Dry-run is currently scoped to `deploy` — it's the only multi-step
  // pipeline where "what would this do" has actionable value. Other commands
  // are either read-only (status), single-shot (smoke), or destructive
  // (destroy — guarded by --confirm instead). Honoring --dry-run only for
  // deploy avoids implementing dry-run handling in every command path.
  if (args.dryRun) {
    if (args.command !== "deploy") {
      console.log(
        `  --dry-run is only implemented for the deploy command (got: ${args.command})`,
      );
      process.exit(0);
    }
    setDryRun(true);
    console.log(
      "  DRY RUN — commands will be printed instead of executed; no AWS or remote state will change",
    );
  }

  switch (args.command) {
    case "deploy":
      await deploy(config, args.target);
      break;
    case "status":
      await status(config, args.target);
      break;
    case "destroy":
      await destroy(config, args.target, args.confirm);
      break;
    case "ssh":
      await ssh(config, args.target);
      break;
    case "logs":
      await logs(config, args.target);
      break;
    case "secrets-push":
      await secretsPush(config, args.target);
      break;
    case "smoke":
      await smoke(config);
      break;
    case "create-user": {
      const outputs = resolveOutputs(args.target, config);
      await createUser(config, args.username, outputs.publicIp);
      break;
    }
    case "ensure-root-user": {
      const outputs = resolveOutputs(args.target, config);
      await ensureRootUser(config, outputs.publicIp);
      break;
    }
    default: {
      const _exhaustive: never = args;
      throw new Error(
        `Unhandled command: ${(_exhaustive as { command: string }).command}`,
      );
    }
  }
}

// Only run when invoked directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("\nDeploy failed:", err.message);
    process.exit(1);
  });
}
