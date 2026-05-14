# Shared SFC Deps Provisioning (DX-540)

The `/api/template-build` endpoint (DX-539) compiles per-template Vue
sources against a host-shared `node_modules/` tree. This document
specifies how that tree gets populated.

## TL;DR

- A consumer repo (e.g. gpt-manager) publishes `shared_deps_lock.json`
  to `s3://<bucket>/template-shell/<shell_version>/shared_deps_lock.json`
  declaring the exact deps it ships to per-template modules.
- The danxbot host runs `provision-sfc-deps` once at deploy time +
  hourly via cron. The provisioner materializes
  `/srv/sfc-deps/<shell_version>/node_modules/` for every active
  manifest.
- `prune-sfc-deps` runs daily, removing inactive deps dirs older than 30d.
- DX-539's build handler resolves a build by symlinking the matching
  `/srv/sfc-deps/<shell_version>/node_modules/` into a scratch dir
  and running `vite build`.

## Manifest schema

`shared_deps_lock.json`:

```json
{
  "shell_version": "1.0.0",
  "deps": {
    "vue": "3.5.13",
    "@thehammer/danx-ui": "0.7.2"
  },
  "generated_at": "2026-05-14T12:00:00Z"
}
```

- `shell_version` — free-form identifier. Doubles as the dir name
  under `/srv/sfc-deps/`. MUST match `^[A-Za-z0-9._-]+$` (safe path
  chars). The provisioner refuses any manifest whose `shell_version`
  fails this check.
- `deps` — flat `package -> exact version` map. Versions MUST be
  exact (no ranges) — DX-539's caller assumes deterministic deps per
  `shell_version`.
- `generated_at` — optional ISO 8601 timestamp. Logged + surfaced
  in the dashboard but not used for ordering.

## S3 layout (production)

```
s3://<bucket>/template-shell/
├── 1.0.0/shared_deps_lock.json
├── 1.1.0/shared_deps_lock.json
└── 2.0.0/shared_deps_lock.json
```

The provisioner lists `s3://<bucket>/template-shell/` to discover
active versions, then fetches each `shared_deps_lock.json`.

## Provisioning lifecycle

`provisionSfcDeps()` (`src/sfc-deps/provisioner.ts`):

1. List manifests from the configured source (S3 or local dir).
2. For each `shell_version`:
   - Compare the live manifest's `deps` against the on-disk snapshot
     at `/srv/sfc-deps/<v>/shared_deps_lock.json`.
   - If they match AND `node_modules/` is present → SKIP (idempotent).
   - Otherwise: write `package.json` from `deps`, run
     `npm install --omit=dev`, write the snapshot.
3. Per-version failures are isolated — one bad manifest does not
   block the rest.

`pruneStaleSfcDeps()` (`src/sfc-deps/prune.ts`):

1. List active manifests from the source.
2. For each dir under `/srv/sfc-deps/`:
   - In the active set → KEEP.
   - Inactive but younger than 30d → KEEP (grace window for
     in-flight builds against just-unpublished manifests).
   - Inactive AND older than 30d → DELETE.

## When the provisioner runs

| Trigger | File | Frequency |
|---|---|---|
| `make deploy` post-hook | `deploy/hooks/post-deploy-provision-deps.sh` | Once per deploy |
| Host system cron | `src/cron/jobs/provision-sfc-deps.ts` | Every 1h |
| Stale-dir prune cron | `src/cron/jobs/prune-sfc-deps.ts` | Every 24h |
| Operator ad-hoc | `npx tsx scripts/provision-sfc-deps.ts` | Manual |

Cron jobs fire from `src/cron/tick.ts`, which is wired into the
host crontab by `make install-cron`. On a fresh prod host, run
`make install-cron` once after the first deploy to register the
per-minute tick.

## Environment variables

Set in `<repo>/.danxbot/.env` (dev) or pushed via
`make deploy-secrets-push` (prod).

| Variable | Purpose | Default |
|---|---|---|
| `SFC_DEPS_S3_BUCKET` | Bucket holding manifest tree | (unset — disables S3 path) |
| `SFC_DEPS_S3_PREFIX` | Prefix within the bucket | `template-shell/` |
| `SFC_DEPS_AWS_PROFILE` | AWS CLI profile | `AWS_PROFILE` |
| `SFC_DEPS_AWS_REGION` | AWS region | `AWS_REGION` |
| `SFC_DEPS_LOCAL_MANIFEST_DIR` | Local dev override — disables S3 | (unset) |
| `SFC_DEPS_BASE_DIR` | Where deps are materialized | `/srv/sfc-deps` |

When `SFC_DEPS_LOCAL_MANIFEST_DIR` is set it ALWAYS wins. Useful
for dev + integration tests. When neither env var is set the
provisioner + prune are no-ops with a log line — fresh installs
do not page on a missing bucket.

## Local dev

Two options, pick whichever matches your workflow.

### Option A — local manifest dir

```bash
# In your .danxbot/.env
SFC_DEPS_LOCAL_MANIFEST_DIR=/home/me/sfc-manifests
SFC_DEPS_BASE_DIR=/home/me/.local/sfc-deps   # avoid /srv permissions
```

Drop a manifest under `/home/me/sfc-manifests/<version>/shared_deps_lock.json`
and run:

```bash
npx tsx scripts/provision-sfc-deps.ts
```

The provisioner materializes `/home/me/.local/sfc-deps/<version>/node_modules/`.

### Option B — point at a colleague's S3 bucket

Set `SFC_DEPS_S3_BUCKET` + the AWS profile that can read it. Same
script.

## Deploy hook

The hook is one SSH-runnable bash script
(`deploy/hooks/post-deploy-provision-deps.sh`) that:

1. Sources `/danxbot/.env` (where `materialize-secrets.sh` wrote
   `SFC_DEPS_S3_BUCKET` + any AWS overrides earlier in the deploy
   flow).
2. Ensures `/srv/sfc-deps/` exists with danxbot-user ownership.
3. Invokes `npx tsx scripts/provision-sfc-deps.ts` from
   `/danxbot/app/`.

Failures inside the hook do NOT abort the deploy — they are logged
with `WARN: provision-sfc-deps hook failed: <reason>`. The hourly
cron picks up the next opportunity.

## Failure modes

| Symptom | Likely cause | Recovery |
|---|---|---|
| `deps_missing` from `/api/template-build` | No manifest published for this `shell_version`, OR the provisioner has not yet run since the manifest was published. | Publish the manifest. Wait one hour OR run `npx tsx scripts/provision-sfc-deps.ts` manually. |
| `vite_build_failed` from `/api/template-build` | The deps dir is provisioned but the consumer's source references a package that is not in the manifest. | Update the consumer's `shared_deps_lock.json` and re-publish. |
| `aws s3 ls` failure in provisioner log | Bucket name typo OR missing IAM perms on the worker host. | Check `SFC_DEPS_S3_BUCKET` + the IAM role on the EC2 instance allows `s3:ListBucket` + `s3:GetObject` on the bucket. |
| `npm install` exits non-zero | Manifest version is yanked from npm OR network/proxy issue. | Inspect stderr in the provisioner log. Republish a working version. |

## Implementation map

| File | Role |
|---|---|
| `src/sfc-deps/types.ts` | Schema types + safe-path regex |
| `src/sfc-deps/manifest-source.ts` | S3 + local-dev manifest sources |
| `src/sfc-deps/provisioner.ts` | Materializes one `node_modules/` per version |
| `src/sfc-deps/prune.ts` | Drops stale inactive dirs |
| `src/cron/jobs/provision-sfc-deps.ts` | Hourly cron entry |
| `src/cron/jobs/prune-sfc-deps.ts` | Daily cron entry |
| `scripts/provision-sfc-deps.ts` | CLI (provision + prune one-shot) |
| `deploy/hooks/post-deploy-provision-deps.sh` | SSH-invoked deploy hook |
| `deploy/provision-sfc-deps-hook.ts` | TS wrapper called from `deploy/cli.ts` |
