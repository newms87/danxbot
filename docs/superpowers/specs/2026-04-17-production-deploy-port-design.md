# Production Deploy Port Design

Port the AWS deployment system from `danxbot-gpt-manager` into `danxbot-flytebot`, adapted for flytebot's multi-repo worker architecture, and extended to support multiple independent production deployments in different AWS accounts.

## Goals

- **Parity with local.** The production environment mirrors the local development model: shared infra (dashboard + mysql + playwright) plus one worker container per connected repo. Each repo's full development stack (Sail, npm dev server, etc.) runs on the prod box so agents have true dev parity — they can execute tests, hit live services, run migrations, and commit against real state.
- **Multiple independent deployments.** Support N production deployments, each in a potentially different AWS account, with its own EC2, ECR, Elastic IP, Route53 record, EBS data volume, SSM parameter tree, and set of connected repos. Deployments are fully isolated — destroying one must not touch another.
- **Single-command deploy.** `make deploy TARGET=<name>` provisions, builds, pushes, configures, and verifies everything. Idempotent on every subsequent run.
- **Reuse gpt-manager's shape.** The existing `danxbot-gpt-manager` deploy system (CLI, Terraform, cloud-init, templates) is well-designed. Port it module-by-module; extend only where flytebot's multi-repo model requires it. Do not reinvent the solved pieces.
- **Upgrade-in-place cutover for the existing gpt-manager deploy.** The live `danxbot.sageus.ai` instance should be adopted by the new system without tearing it down.

## Non-Goals

- No Kubernetes, ECS, or managed orchestration. A single EC2 per deployment is enough for now.
- No blue/green or canary. Deploys are in-place container restarts.
- No multi-region per deployment. One region per deployment.
- No SSO or multi-user dashboard auth changes. Caddy terminates HTTPS; the dashboard's existing auth model is unchanged.
- No changes to `src/` or `dashboard/` application code. This is pure ops/infra work.

## Initial Deployments

Two deployments are planned immediately:

- **`gpt`** — upgrade-in-place of the existing `danxbot-gpt-manager` deploy. Hosts the `danxbot` and `gpt-manager` repos as workers on a single EC2 in the `gpt` AWS profile. Keeps the existing domain `danxbot.sageus.ai`, existing hosted zone `sageus.ai`, and existing Terraform state bucket. Instance bumped one size up from `t3.medium` to `t3.large` to absorb the added worker for danxbot itself.
- **`flytedesk`** — new deployment in the default (flytedesk) AWS profile. Hosts the `platform` repo as its sole worker, running platform's full Sail stack alongside the danxbot worker. Instance size to be set per deployment based on Sail's footprint (likely `t3.medium` or `t3.large`).

Both deployments share the same danxbot image built from this repo. Each deployment has its own ECR repo; the image is built once per deploy and pushed to the relevant ECR.

## Deployment Config

Every deployment is defined by one YAML file at `.danxbot/deployments/<name>.yml` in this repo. The file is gitignored (contains no secrets, but contains account-specific identifiers). A committed example lives at `.danxbot/deployments.example.yml`.

The config file fields:

- **`name`** — deployment identifier. Becomes the AWS resource prefix (ECR repo name, security group name, key pair name, tfstate bucket name). Lowercase alphanumeric plus hyphens. For `gpt`, this must be `danxbot-production` to match the existing resources.
- **`region`** — AWS region. Defaults to `us-east-1`.
- **`domain`** — full dashboard hostname, e.g., `danxbot.sageus.ai`. Must sit inside the `hosted_zone`.
- **`hosted_zone`** — Route53 hosted zone name.
- **`aws.profile`** — AWS CLI profile used for every AWS call for this deployment. No credential-chain fallback.
- **`instance.type`** — EC2 instance type. Default `t3.small` (new minimum). For `gpt`: `t3.large`. Per-deployment override expected.
- **`instance.volume_size`** — root EBS volume in GB. Default 30.
- **`instance.data_volume_size`** — persistent EBS volume in GB. Default 100 (2× gpt-manager's 50 to give buffer for Docker images, repo clones, logs, and each repo's mysql data). This volume holds `/danxbot/{repos,threads,logs,claude-auth,mysql-data}`.
- **`instance.ssh_key`** — name of an existing AWS key pair. Empty string auto-generates one (saved to `~/.ssh/<name>-key.pem`).
- **`instance.ssh_allowed_cidrs`** — list of CIDRs allowed to SSH. Defaults to `["0.0.0.0/0"]`; real deployments should restrict.
- **`ssm_prefix`** — SSM Parameter Store subtree root. Convention: `/danxbot-<TARGET>` where TARGET is the yml filename stem. `name` and TARGET are allowed to differ — for upgrade-in-place of the gpt deployment, `name: danxbot-production` matches the existing AWS resources while `TARGET=gpt` matches the new yml filename. Used both for reading secrets at runtime and for the deploy CLI's push helper.
- **`claude_auth_dir`** — path to a local directory containing `.claude.json` and `.credentials.json`. Resolved relative to the yml file.
- **`dashboard.port`** — dashboard port inside the container. Default 5555.
- **`repos`** — list of `{ name, url }` entries. Each listed repo must contain `.danxbot/config/compose.yml` and `.danxbot/scripts/bootstrap.sh`; the deploy CLI validates this before any AWS call.

Validation is done by `deploy/config.ts` before the CLI touches AWS. Missing fields, invalid types, invalid names, unreadable `claude_auth_dir`, and unavailable AWS profiles all fail fast with a clear error message.

## Per-Repo Bootstrap Convention

Every repo listed in a deployment's `repos:` must contain an executable script at `.danxbot/scripts/bootstrap.sh`. The script is idempotent: on a fresh clone it brings up the repo's full development stack (composer install, sail up, npm install, migrations, whatever the repo needs); on an existing clone it reapplies any changes without breakage. The script streams output, never blocks on input, and exits 0 only when the stack is healthy.

This convention is out-of-scope for this spec's implementation — it is being tracked as a separate Trello epic (`Production bootstrap scripts for connected repos`) with one phase card per target repo (danxbot-flytebot, gpt-manager, platform). Those scripts are a hard prerequisite for the deploy CLI's repo-sync step to do anything useful.

## On-Instance File Layout

Once deployed, the EC2 instance holds everything under `/danxbot/` on the attached EBS data volume, so data survives instance replacement:

- `/danxbot/.env` — shared infra env (ANTHROPIC_API_KEY, DANXBOT_DB_*, DANXBOT_GIT_EMAIL, DASHBOARD_PORT). Runtime is auto-detected from `/.dockerenv`.
- `/danxbot/docker-compose.prod.yml` — the shared-infra compose (dashboard + mysql + playwright), uploaded by the deploy CLI from a template
- `/danxbot/claude-auth/` — Claude Code auth files uploaded by the deploy CLI (read-only inside the dashboard container)
- `/danxbot/repos/<repo>/` — full clone of each configured repo
- `/danxbot/repos/<repo>/.env` — the repo's own application env (e.g., Laravel's), materialized from SSM
- `/danxbot/repos/<repo>/.danxbot/.env` — the repo's danxbot-specific env, materialized from SSM
- `/danxbot/repos/<repo>/.claude/settings.local.json` — MCP settings for Claude Code, regenerated on every deploy from the materialized env vars
- `/danxbot/threads/`, `/danxbot/logs/`, `/danxbot/mysql-data/` — persistent app state

Paths inside the container map these to the same locations the local setup uses (`/danxbot/app/src` etc. via bind mount; repo paths via bind mount), so the app code requires no conditional branches.

## SSM Secret Layout

Internal implementation detail — the user never manually interacts with SSM. Secrets live on local `.env` files during authoring; the push helper (`make deploy-secrets-push TARGET=<name>`) syncs them to SSM; the materializer on the instance pulls them back into the expected file paths on every deploy.

Under each deployment's `ssm_prefix`:

- `shared/<KEY>` — parameters that land in `/danxbot/.env` on the instance. Sourced from local `danxbot-flytebot/.env`.
- `repos/<repo>/<KEY>` — parameters without the `REPO_ENV_` prefix land in `/danxbot/repos/<repo>/.danxbot/.env`. Sourced from local `<repo>/.danxbot/.env`.
- `repos/<repo>/REPO_ENV_<KEY>` — parameters with the `REPO_ENV_` prefix (prefix stripped on materialization) land in `/danxbot/repos/<repo>/.env`. Sourced from local `<repo>/.env`.

Every parameter is a `SecureString`. The EC2 instance's IAM role is scoped to read only its own deployment's subtree, nothing else.

## Deploy CLI

`make deploy TARGET=<name>` invokes `npx tsx deploy/cli.ts deploy <name>` and runs the following sequence:

1. **Load + validate** `.danxbot/deployments/<name>.yml`. Abort on any validation error.
2. **Preflight check** — verify the AWS profile exists, required shared SSM parameters exist (at least `ANTHROPIC_API_KEY`), and every repo listed has a fetchable `.danxbot/config/compose.yml` and `.danxbot/scripts/bootstrap.sh` at its HEAD.
3. **Bootstrap Terraform backend** — create S3 state bucket + DynamoDB lock table if missing. Named `<name>-terraform-state` and `<name>-terraform-locks`. Idempotent.
4. **Terraform init + apply** — provision all AWS resources (EC2, EIP, SG, EBS, ECR, Route53, IAM, key pair). Cloud-init runs once at first boot to install Docker, Caddy, AWS CLI, mount the data volume, and register the danxbot systemd service. Subsequent applies ignore `user_data` changes.
5. **Wait for SSH readiness** — poll up to ~3 minutes while cloud-init finishes.
6. **Build + push image** — build the danxbot Docker image locally, tag as `:latest` and `:<timestamp>`, push both to this deployment's ECR.
7. **Upload Claude auth** — SCP `.claude.json` and `.credentials.json` from `claude_auth_dir` to `/danxbot/claude-auth/` on the instance.
8. **Materialize secrets** — SCP a remote script that pulls the deployment's SSM subtree and writes `.env` files into the expected paths (shared and per-repo). Execute it on the instance.
9. **Sync repos** — for each configured repo: clone into `/danxbot/repos/<name>/` if absent; otherwise `git fetch` + `git reset --hard origin/main`. Uses the per-repo `DANX_GITHUB_TOKEN` from the freshly materialized env.
10. **Run per-repo bootstrap.sh** — execute each repo's `.danxbot/scripts/bootstrap.sh` on the instance. This brings up every repo's full development stack.
11. **Upload + restart infra compose** — render `docker-compose.prod.yml` (dashboard + mysql + playwright, with the deployment's ECR image URL), SCP it to `/danxbot/docker-compose.prod.yml`, run `docker compose up -d --remove-orphans`.
12. **Launch per-repo workers** — for each repo: run `docker compose -f /danxbot/repos/<name>/.danxbot/config/compose.yml -p worker-<name> up -d --remove-orphans`. Identical invocation to `make launch-all-workers` locally.
13. **Verify health** — poll `https://<domain>/health` until it returns 200 or the timeout (~3 minutes). On failure, print the logs command for diagnosis.

All steps except (4)'s initial cloud-init and (9)'s first clone are idempotent on subsequent deploys. Adding a repo to the yml triggers a fresh clone + bootstrap + worker launch on next deploy. Removing a repo leaves its clone on disk but tears down its worker.

Other Make targets (all require `TARGET=<name>`):

- `deploy-status` — show Terraform outputs and dashboard health.
- `deploy-logs` — tail the dashboard + all worker containers via SSH.
- `deploy-ssh` — interactive SSH session to the instance.
- `deploy-destroy ARGS=--confirm` — Terraform destroy. Requires the confirm flag.
- `deploy-smoke` — fire a trivial dispatch against the deployed API, verify round-trip through the dashboard SSE stream, then cancel. Reuses `test-system-*` infrastructure, pointed at the deployed URL.
- `deploy-secrets-push` — read local `.env` files and sync to the deployment's SSM subtree.

## Terraform Stack

Per deployment, Terraform manages:

- **EC2 instance** — latest Ubuntu 22.04 Canonical AMI, sized per yml. Root volume encrypted. `ignore_changes` on `user_data` and `ami` — deploy CLI owns subsequent changes.
- **Elastic IP** + association — stable public IP across instance replacement.
- **Security group** — inbound 443 (HTTPS), 80 (ACME), 22 (SSH, restricted). Full outbound.
- **EBS data volume** — gp3, encrypted, mounted at `/danxbot` via `/dev/xvdf`. `force_detach=false` so data survives instance replacement.
- **Route53 A record** — `<domain>` → Elastic IP.
- **ECR repository** — named `<deployment>`, with a lifecycle policy keeping the last 10 untagged images.
- **IAM role + instance profile** — grants scoped `ssm:GetParametersByPath` for the deployment's subtree, ECR pull, CloudWatch Logs, and the AWS-managed `AmazonSSMManagedInstanceCore` policy (enables `aws ssm start-session` as an SSH alternative).
- **Key pair** — either references an existing AWS key pair or generates a new ED25519 one and writes the private key to `~/.ssh/<deployment>-key.pem`.
- **S3 state bucket + DynamoDB lock table** — bootstrapped outside Terraform before the first `init`.

Every AWS resource carries default tags `Project=danxbot`, `ManagedBy=terraform`, `Name=<deployment>`.

## Cloud-Init

Runs once at first boot of each instance. Installs `docker-ce`, `docker-compose-plugin`, `caddy`, `jq`, `unzip`, AWS CLI v2. Formats the data volume if unformatted and mounts it at `/danxbot`. Writes `/etc/caddy/Caddyfile` with a reverse proxy from `<domain>` to `localhost:<dashboard_port>`, enabling Let's Encrypt auto-TLS. Creates data subdirectories under `/danxbot`. Registers a `danxbot.service` systemd unit that runs `ecr-login.sh` and `docker compose -f /danxbot/docker-compose.prod.yml up -d` — this gives the dashboard+mysql+playwright stack a clean boot story after host reboots. Per-repo workers are started by the deploy CLI, not cloud-init (so adding a repo doesn't require an instance reboot).

Cloud-init does NOT clone repos — the deploy CLI owns repo sync because it runs on every deploy, not just first boot.

## File Layout Added to This Repo

```
.danxbot/
  deployments/
    gpt.yml                         (gitignored — real config)
    flytedesk.yml                   (gitignored — real config)
  deployments.example.yml           (committed — template)

deploy/
  cli.ts                            (entry; parses command + TARGET; dispatches)
  config.ts                         (YAML parser + validator)
  bootstrap.ts                      (S3/DynamoDB backend bootstrap)
  provision.ts                      (Terraform wrapper: init/apply/output/destroy)
  build.ts                          (docker build + ECR push)
  remote.ts                         (RemoteHost: SSH/SCP encapsulated)
  health.ts                         (post-deploy HTTPS health poll)
  exec.ts                           (run/runStreaming/tryRun helpers)
  secrets.ts                        (NEW — local .env → SSM push, materializer renderer)
  bootstrap-repos.ts                (NEW — per-repo git clone/pull + bootstrap.sh run)
  workers.ts                        (NEW — per-repo worker compose orchestration)
  test-helpers.ts
  *.test.ts                         (unit tests per module)
  terraform/
    versions.tf, data.tf,
    networking.tf, compute.tf,
    ecr.tf, iam.tf,
    outputs.tf, variables.tf
  templates/
    cloud-init.yaml.tpl
    docker-compose.prod.yml         (infra only: dashboard + mysql + playwright)
    materialize-secrets.sh          (NEW — remote script for SSM → .env materialization)

Makefile                            (extend with deploy/deploy-* targets)
package.json                        (add `yaml` dependency)
.gitignore                          (add .danxbot/deployments/*.yml except the example)
```

No changes under `src/` or `dashboard/`. The application code does not need to know it is running in production.

## Testing Strategy

Three layers:

1. **Unit tests** — one `.test.ts` per deploy module. Shell and AWS SDK calls mocked. Run with `npx vitest run deploy/`. Fast, free. Every new module and every ported module must have unit tests that verify config parsing, validation errors, command construction, template rendering, and SSM path logic.
2. **Dry-run mode** — `make deploy TARGET=<name> ARGS=--dry-run` walks the full CLI flow and prints every command it would execute (AWS CLI, SSH, SCP, Docker) without running any of them. Used as a sanity gate before real deploys and as a debugging aid.
3. **Post-deploy smoke** — `make deploy-smoke TARGET=<name>` dispatches a trivial prompt to the deployed worker API, verifies the event round-trips through the dashboard SSE stream, and cancels. Reuses `test-system-*` infrastructure, pointed at the deployed URL.

No automated end-to-end integration test of the full deploy pipeline — too expensive and too slow to run in CI. A manual verification checklist (fresh deploy from zero, upgrade-in-place deploy, destroy-and-redeploy) lives in this spec and must be walked before each cut.

## Cutover Plan for the Existing gpt-manager Deploy

The live `danxbot.sageus.ai` instance was provisioned by the current `danxbot-gpt-manager` deploy CLI. Cutting over to the new flytebot-based system:

1. **Write `deployments/gpt.yml`** in this repo with `name: danxbot-production`, `domain: danxbot.sageus.ai`, `hosted_zone: sageus.ai`, `aws.profile: gpt`, `instance.type: t3.large` (bumped one size from current `t3.medium`), `claude_auth_dir: ../../claude-auth` (resolves to `danxbot-flytebot/claude-auth/`, which already contains `.claude.json` + `.credentials.json`), `ssm_prefix: /danxbot-gpt`, and `repos:` listing both `danxbot` and `gpt-manager`. The gpt-manager repo has its own separate `claude-auth/` copy; that one stays with `danxbot-gpt-manager` and is no longer the source of truth once cutover is complete.
2. **Push secrets** — run `make deploy-secrets-push TARGET=gpt` to populate `/danxbot-gpt/shared/*` and `/danxbot-gpt/repos/danxbot/*` and `/danxbot-gpt/repos/gpt-manager/*` from the local `.env` files. The old `/danxbot/*` SSM tree remains untouched for rollback and is cleaned up manually after cutover succeeds.
3. **Deploy** — run `make deploy TARGET=gpt`. Terraform picks up the existing `danxbot-production-terraform-state` S3 bucket, recognizes all existing resources, and applies only the instance-type change (brief stop/start) plus the addition of any new SSM subtree policy grants. The instance comes back up with the new image and both workers running.
4. **Verify** — smoke test via `make deploy-smoke TARGET=gpt`, check `https://danxbot.sageus.ai/health`, check each worker's logs, dispatch a real Trello card through each worker to confirm end-to-end.
5. **Clean up** — once satisfied, delete the stale `/danxbot/*` SSM parameters manually, and optionally archive or delete the `danxbot-gpt-manager` repo's `.danxbot/deploy.yml`.

No DNS change. No Elastic IP change. Certificate continues to work (same domain, same box). Brief dashboard downtime during the instance restart for the type bump — seconds to a minute.

## Cutover Plan for the Flytedesk Deploy

This is a fresh deploy — no existing resources to reconcile.

1. Write `deployments/flytedesk.yml` with `aws.profile` pointing at the flytedesk credentials profile, `domain` and `hosted_zone` pointing at whatever domain the user wants to use, instance size appropriate for platform's Sail stack (likely `t3.medium` or `t3.large`).
2. Ensure platform's `.danxbot/scripts/bootstrap.sh` exists (tracked by Phase 3 of the epic).
3. Push secrets, deploy, verify, as above.

## Manual Verification Checklist

Before marking this work complete:

- **Fresh deploy** — choose a throwaway deployment name, run `make deploy TARGET=<throwaway>` from zero. Verify every step of the CLI completes, the dashboard answers at `https://<domain>/health`, and a `make deploy-smoke` round-trip succeeds.
- **Idempotent redeploy** — run `make deploy TARGET=<throwaway>` a second time without any config change. Verify Terraform reports no changes, the image rebuild and push succeed, and the containers restart cleanly.
- **Config change deploy** — add a repo to the yml and redeploy. Verify the new repo is cloned, bootstrapped, and its worker comes up without disturbing the other workers.
- **Destroy** — `make deploy-destroy TARGET=<throwaway> ARGS=--confirm`. Verify all AWS resources are torn down, the S3 state bucket is emptied (but kept; it is cheap), and no orphans remain in the `gpt` or `flytedesk` accounts.
- **Upgrade-in-place gpt cutover** — execute the `gpt` cutover against the live `danxbot.sageus.ai` deployment.
- **Flytedesk fresh deploy** — execute the `flytedesk` cutover against the flytedesk account.

## Open Questions Deferred to Implementation

- The exact form of `--dry-run` for steps that depend on live remote state (e.g., "sync repos" needs a real SSH to know what to pull). Likely answer: dry-run prints the `ssh ...` command without executing and stops.
- Whether to add a `POLLER_ENABLED=false` toggle to cleanly pause all Trello pollers during a deploy to avoid Trello lock contention. Likely answer: yes; the deploy CLI flips it off before restarting and back on after verify.
- Cloudwatch log shipping is provisioned via IAM but not currently wired into the compose logging driver. Decide during implementation whether to switch from `json-file` to `awslogs` or keep stdout + a later log-aggregation phase.

## Related Work

- **Trello epic**: `Production bootstrap scripts for connected repos` (https://trello.com/c/cVamGD7X). Its three phase cards are hard prerequisites for step 10 of the deploy CLI flow to succeed against the `gpt` and `flytedesk` deployments.
