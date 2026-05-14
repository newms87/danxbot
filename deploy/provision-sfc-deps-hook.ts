/**
 * DX-540 — deploy-side wrapper for the post-deploy SFC-deps hook.
 *
 * Runs ONCE per `make deploy`, after workers have come up. SCPs the
 * hook script to the remote host and invokes it via SSH. The hook
 * itself is a thin shell wrapper that re-sources `/danxbot/.env`
 * (where the deploy's `materialize-secrets.sh` step wrote
 * `SFC_DEPS_S3_BUCKET` + any `AWS_*` overrides) and then runs
 * `npx tsx scripts/provision-sfc-deps.ts` inside the danxbot repo
 * checkout.
 *
 * Exported as a separate module so it is unit-testable without
 * pulling the rest of `deploy/cli.ts`'s graph. The injection point
 * in `cli.ts` is one line: `await provisionSfcDepsOnHost(remote)`.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_REMOTE_PATH = "/tmp/post-deploy-provision-deps.sh";

export interface SfcDepsHookRemote {
  scpUpload(localPath: string, remotePath: string): void;
  sshRun(command: string): string;
  sshRunStreaming(command: string): void;
}

export interface ProvisionSfcDepsOnHostOptions {
  /** Override the local hook path. Tests use this to point at a fixture. */
  hookLocalPath?: string;
  /** Override the remote path. Tests use this to assert the path is stable. */
  hookRemotePath?: string;
  /** When true, the hook upload + run is skipped (dry-run). */
  dryRun?: boolean;
}

function defaultHookLocalPath(): string {
  // hook lives at deploy/hooks/post-deploy-provision-deps.sh relative
  // to the danxbot repo root. Resolve relative to this file's URL so
  // it works from both `npx tsx` and the production bundled invocation.
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "../hooks/post-deploy-provision-deps.sh");
}

export function provisionSfcDepsOnHost(
  remote: SfcDepsHookRemote,
  opts: ProvisionSfcDepsOnHostOptions = {},
): void {
  const localHook = opts.hookLocalPath ?? defaultHookLocalPath();
  const remoteHook = opts.hookRemotePath ?? HOOK_REMOTE_PATH;

  if (opts.dryRun) {
    process.stdout.write(
      `[provision-sfc-deps-hook] dry-run: would scp ${localHook} -> ${remoteHook} and ssh-run\n`,
    );
    return;
  }

  // Defense-in-depth: refuse a remote path with shell-metacharacters
  // before interpolating it into the ssh command. The default value
  // is hardcoded; this gate only fires on operator/test misuse.
  if (/[^A-Za-z0-9._/-]/.test(remoteHook)) {
    throw new Error(
      `provisionSfcDepsOnHost: refusing unsafe hookRemotePath "${remoteHook}"`,
    );
  }

  remote.scpUpload(localHook, remoteHook);
  remote.sshRunStreaming(`bash ${remoteHook}`);
}
