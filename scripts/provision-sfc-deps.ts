#!/usr/bin/env npx tsx
/**
 * DX-540 CLI — provision + prune SFC shared deps on demand.
 *
 * Invoked by:
 *   - `make deploy` (via `deploy/hooks/post-deploy-provision-deps.sh`,
 *     SSH'd onto the remote host after workers come up).
 *   - The danxbot user / operator on the host for ad-hoc refresh.
 *
 * The same module also runs hourly + daily from the system cron
 * tick (`src/cron/jobs/{provision,prune}-sfc-deps.ts`). This CLI is
 * the one-shot equivalent — runs ONE provision pass followed by ONE
 * prune pass and exits.
 *
 * Env contract (mirrors the cron job):
 *   - SFC_DEPS_LOCAL_MANIFEST_DIR  (dev — overrides S3)
 *   - SFC_DEPS_S3_BUCKET           (prod — S3 bucket holding manifests)
 *   - SFC_DEPS_S3_PREFIX           (prod — defaults to `template-shell/`)
 *   - SFC_DEPS_AWS_PROFILE / AWS_PROFILE
 *   - SFC_DEPS_AWS_REGION / AWS_REGION
 *   - SFC_DEPS_BASE_DIR            (defaults to `/srv/sfc-deps`)
 *
 * Exit codes:
 *   0  — provisioner + prune both ran cleanly
 *   1  — provisioner or prune surfaced per-version failures (logged)
 *   64 — neither manifest source env var is set (operator misconfig)
 */

import { runProvisionSfcDepsJob } from "../src/cron/jobs/provision-sfc-deps.js";
import { runPruneSfcDepsJob } from "../src/cron/jobs/prune-sfc-deps.js";
import { resolveManifestSourceFromEnv } from "../src/sfc-deps/manifest-source.js";

export async function _cliMainForTest(): Promise<void> {
  return main();
}

async function main(): Promise<void> {
  const env = process.env;
  if (!resolveManifestSourceFromEnv(env)) {
    process.stderr.write(
      `[provision-sfc-deps] no manifest source configured — set SFC_DEPS_LOCAL_MANIFEST_DIR (dev) or SFC_DEPS_S3_BUCKET (prod)\n`,
    );
    process.exit(64);
  }

  const errors: string[] = [];
  const captureLog = (line: object) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
    if ((line as { kind?: string }).kind === "error") {
      errors.push((line as { error?: string }).error ?? "unknown");
    }
  };

  try {
    await runProvisionSfcDepsJob({ log: captureLog });
  } catch (err) {
    process.stderr.write(
      `[provision-sfc-deps] provisioner threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  try {
    await runPruneSfcDepsJob({ log: captureLog });
  } catch (err) {
    process.stderr.write(
      `[provision-sfc-deps] prune threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  if (errors.length > 0) process.exit(1);
}

const isDirectEntry =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/scripts/provision-sfc-deps.ts") ||
  process.argv[1]?.endsWith("\\scripts\\provision-sfc-deps.ts");

if (isDirectEntry) {
  main().catch((err) => {
    process.stderr.write(
      `[provision-sfc-deps] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
