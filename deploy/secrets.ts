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
import { execSync, exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);
import type { DeployConfig } from "./config.js";
import { awsCmd, isDryRun, runStreaming, runStreamingParallel } from "./exec.js";
import { DRY_RUN_DISPATCH_TOKEN } from "./dry-run-placeholders.js";
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
 *   REPO_WORKER_HOSTS — "<name>:<host>,..." for repos that declare a
 *     worker_host override; empty when none do (the dashboard then falls
 *     back to the default `danxbot-worker-<name>` for every repo). The key
 *     is always present in the override map so it overwrites any
 *     operator-local REPO_WORKER_HOSTS that might leak via .env, even
 *     though `pushIfSet` skips the SSM put when the value is empty.
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
  const hostsValue = config.repos
    .filter((r) => r.workerHost)
    .map((r) => `${r.name}:${r.workerHost}`)
    .join(",");
  return {
    REPOS: reposValue,
    REPO_WORKER_PORTS: portsValue,
    REPO_WORKER_HOSTS: hostsValue,
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
 *
 * Defense-in-depth dry-run guard: the function returns the placeholder
 * unconditionally when `isDryRun()` is set, so a future caller that bypasses
 * `pushSecrets` (which already substitutes the placeholder) cannot leak a
 * real token to stdout via the generation path's printed banner.
 */
export function getOrCreateDispatchToken(
  config: DeployConfig,
  exec: (cmd: string) => string = defaultTokenFetch,
): string {
  if (isDryRun()) return DRY_RUN_DISPATCH_TOKEN;
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

/**
 * Reverse `buildSsmPutCommands`'s output: pull the SSM path and the raw
 * (unescaped) secret value back out of a built `aws ssm put-parameter` command.
 *
 * The diff filter (`filterUnchangedPuts`) compares values byte-for-byte
 * against what SSM already holds, so the parser MUST exactly invert the
 * shell-escape that `buildSsmPutCommands` applies — otherwise a value
 * containing a literal single quote would always look "changed" and never
 * skip the put.
 *
 * Returns null for unparseable input so the caller can pass the command
 * through verbatim instead of silently dropping it. We never want a parse
 * mistake to translate into a missing SSM update.
 */
export function parsePutParameterCommand(
  cmd: string,
): { path: string; value: string } | null {
  const nameMatch = cmd.match(/--name "([^"]+)"/);
  if (!nameMatch) return null;
  // The value is single-quoted; embedded single quotes are escaped as
  // `'\''` (close-quote, escaped quote, reopen). Match the entire content
  // between the outer single quotes — the alternation `(?:[^']|'\\'')*` is
  // greedy on non-quotes and on the literal `'\''` escape sequence.
  const valueMatch = cmd.match(/--value '((?:[^']|'\\'')*)'/);
  if (!valueMatch) return null;
  const value = valueMatch[1].replace(/'\\''/g, "'");
  return { path: nameMatch[1], value };
}

/**
 * Drop puts whose value already matches what SSM holds. Returns the puts
 * still worth running plus the list of paths skipped (for log output).
 *
 * Unparseable commands fall through to `toPush` defensively — better to
 * re-push a command we couldn't introspect than to silently skip it.
 */
export function filterUnchangedPuts(
  cmds: string[],
  existing: Map<string, string>,
): { toPush: string[]; skipped: string[] } {
  const toPush: string[] = [];
  const skipped: string[] = [];
  for (const cmd of cmds) {
    const parsed = parsePutParameterCommand(cmd);
    if (!parsed) {
      toPush.push(cmd);
      continue;
    }
    if (existing.get(parsed.path) === parsed.value) {
      skipped.push(parsed.path);
    } else {
      toPush.push(cmd);
    }
  }
  return { toPush, skipped };
}

/**
 * Build `aws ssm get-parameters` commands batched at the AWS limit of 10
 * names per call. Going over emits a 400 ValidationException, so the slice
 * is load-bearing.
 *
 * Each batch reads SecureStrings (`--with-decryption`) and emits JSON the
 * caller feeds to `parseGetParametersOutput`.
 */
export function buildGetParametersCommands(
  config: DeployConfig,
  paths: string[],
): string[] {
  const BATCH = 10;
  const cmds: string[] = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const names = batch.map((p) => `"${p}"`).join(" ");
    cmds.push(
      awsCmd(
        config.aws.profile,
        `ssm get-parameters --names ${names} --with-decryption --region ${config.region} --query "Parameters[*].{Name:Name,Value:Value}" --output json`,
      ),
    );
  }
  return cmds;
}

/**
 * Parse the JSON shape produced by `buildGetParametersCommands`. Empty
 * input (skipped batch, no paths) yields an empty Map. Missing parameters
 * are absent from the array — they'll naturally fall through to "must push"
 * in `filterUnchangedPuts`.
 */
export function parseGetParametersOutput(json: string): Map<string, string> {
  if (!json.trim()) return new Map();
  const arr = JSON.parse(json) as Array<{ Name: string; Value: string }>;
  return new Map(arr.map((p) => [p.Name, p.Value]));
}

/**
 * Read the current SSM values for the given paths in batches of 10.
 * Batches run in parallel up to `DEFAULT_DIFF_CONCURRENCY` since each
 * `aws ssm get-parameters` call costs ~1.5s of aws-cli boot overhead and
 * a serial loop quickly dominates the deploy. AWS's GetParameters
 * throttle is generous (~40 TPS), so 10 in flight stays well within budget.
 *
 * Errors per batch degrade gracefully — a transient AWS issue on one
 * batch never poisons the whole diff phase. The put step still runs and
 * surfaces real auth failures loudly.
 */
export async function fetchExistingSsmValues(
  config: DeployConfig,
  paths: string[],
  exec: (cmd: string) => Promise<string> = defaultGetParametersExec,
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const cmds = buildGetParametersCommands(config, paths);
  const result = new Map<string, string>();

  // Bounded-concurrency worker pool. Same shape as `runStreamingParallel`
  // in exec.ts but with stdout capture (the put-parameter version is
  // fire-and-forget, so it can't be reused here).
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= cmds.length) return;
      let out: string;
      try {
        out = await exec(cmds[i]);
      } catch {
        // Best-effort: skip this batch. Other batches' results still merge.
        continue;
      }
      // Map writes are synchronous + atomic per call — safe under
      // single-threaded JS even with multiple workers in flight.
      for (const [k, v] of parseGetParametersOutput(out)) {
        result.set(k, v);
      }
    }
  };
  const workerCount = Math.max(1, Math.min(DEFAULT_DIFF_CONCURRENCY, cmds.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}

function defaultGetParametersExec(cmd: string): Promise<string> {
  return execAsync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024 }).then(
    (r) => r.stdout.toString(),
  );
}

/**
 * Default concurrency for parallel `get-parameters` diff calls. Same
 * rationale as `DEFAULT_PUSH_CONCURRENCY` — comfortably under AWS's
 * throttle, big enough that the aws-cli boot overhead is fully hidden.
 */
const DEFAULT_DIFF_CONCURRENCY = 10;

/**
 * Default concurrency for parallel SSM put-parameter calls. AWS PutParameter
 * has a default soft throttle of ~40 TPS per account; 10 concurrent fits
 * well below that with headroom for retries and stays kind to other
 * SSM consumers.
 */
const DEFAULT_PUSH_CONCURRENCY = 10;

export interface PushSecretsOptions {
  /** Override the default concurrency for parallel `put-parameter` calls. */
  concurrency?: number;
  /** Inject a custom SSM reader (tests / dry-run; defaults to fetchExistingSsmValues). */
  ssmReader?: (
    config: DeployConfig,
    paths: string[],
  ) => Promise<Map<string, string>>;
  /** Inject a custom command runner (tests; defaults to runStreamingParallel). */
  runner?: (
    cmds: { cmd: string; logLabel?: string }[],
    concurrency: number,
  ) => Promise<void>;
  /** Inject the dispatch token instead of reading from SSM (tests). */
  dispatchToken?: string;
}

export async function pushSecrets(
  config: DeployConfig,
  cwd: string = process.cwd(),
  target?: string,
  options: PushSecretsOptions = {},
): Promise<void> {
  const collected = collectDeploymentSecrets(config, cwd, target);
  const overrides = buildTargetOverrides(config);
  // `getOrCreateDispatchToken` returns DRY_RUN_DISPATCH_TOKEN when isDryRun()
  // is set (defense-in-depth), so this call is dry-run-safe even though the
  // production path hits SSM. Keeping the call here rather than gating with
  // a second isDryRun() check avoids drift between this caller's notion of
  // "what's a dry-run-safe token source" and the function's internal guard.
  const token = options.dispatchToken ?? getOrCreateDispatchToken(config);
  const cmds = buildPushSecretsCommands(config, collected, overrides, token);

  // Diff phase — skipped in dry-run (no real SSM read available, and the
  // intent of dry-run is to show the full would-run pipeline, not a
  // simulated incremental one). In production, fetch existing values and
  // drop puts whose value matches; first-time deploys see an empty Map and
  // push everything.
  let toPush: string[];
  let skipped: string[];
  if (isDryRun()) {
    toPush = cmds;
    skipped = [];
  } else {
    const paths = cmds
      .map((c) => parsePutParameterCommand(c)?.path)
      .filter((p): p is string => Boolean(p));
    const reader = options.ssmReader ?? fetchExistingSsmValues;
    const existing = await reader(config, paths);
    ({ toPush, skipped } = filterUnchangedPuts(cmds, existing));
  }

  console.log(
    `\n── Pushing ${toPush.length} secret(s) to SSM (${skipped.length} unchanged, skipped) ──`,
  );

  // `aws ssm put-parameter --name "<path>" ... --value '<SECRET>'` — strip to
  // the --name path for log output so secret values never hit stdout.
  // Idempotent: put-parameter uses --overwrite in buildSsmPutCommands.
  const labeled = toPush.map((cmd) => {
    const nameMatch = cmd.match(/--name "([^"]+)"/);
    return {
      cmd,
      logLabel: nameMatch
        ? `aws ssm put-parameter ${nameMatch[1]}`
        : "aws ssm put-parameter",
    };
  });

  const concurrency = options.concurrency ?? DEFAULT_PUSH_CONCURRENCY;
  const runner = options.runner ?? runStreamingParallel;
  await runner(labeled, concurrency);
}
