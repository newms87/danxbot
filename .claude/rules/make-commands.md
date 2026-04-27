# Make Commands

Canonical list of every `make` target in this repo. Source of truth: the `Makefile` itself (`make help` regenerates this table).

## CRITICAL: Check Make First, Docker/Curl Last

**Before running ANY of `docker restart`, `docker logs`, `docker exec`, `docker ps`, `docker inspect`, or a hand-rolled `curl` against a worker/dashboard endpoint, check the table below for an equivalent make target and use it.** Make targets are the documented, reproducible entry points — ad-hoc docker commands are a leak of implementation detail that other agents can't re-run and that drift as compose files evolve.

Common substitutions you will be tempted to skip:

| Tempting ad-hoc | Use instead |
|---|---|
| `docker restart danxbot-worker-<repo>` | `make launch-worker REPO=<repo>` |
| `docker logs danxbot-worker-<repo>` | `make logs REPO=<repo>` |
| `curl -X POST .../api/launch` to smoke-test dispatch | `make test-system-dispatch` |
| `curl .../health` to check a worker | `make test-system-health` |
| `docker compose up -d` (dev stack) | `make launch-infra` |

**When NO make target covers your need** (e.g. inspecting `claude auth status` inside a worker, reading a specific file inside the container, comparing env vars host-vs-container): reaching for `docker exec` is legitimate, but call it out explicitly — "no make target covers per-user auth state inside the worker, dropping to `docker exec`" — so the escape is visible, intentional, and re-evaluable next time someone reads the session. Silent use of docker commands is how the rule rots.

## Build & Lifecycle

| Command | Purpose |
|---------|---------|
| `make help` | Show all targets with their `##` descriptions |
| `make build` | Build the danxbot Docker image (rebuild after Dockerfile or pip pin changes) |
| `make validate-repos` | Pre-flight check that connected repos have their dev stacks running on host |

## Local Infrastructure

| Command | Purpose |
|---------|---------|
| `make launch-infra` | Start shared MySQL + dashboard (Docker compose) |
| `make stop-infra` | Stop shared infrastructure |
| `make logs` | Tail infra logs |
| `make logs REPO=<name>` | Tail a specific worker's logs |

## Local Workers

| Command | Purpose |
|---------|---------|
| `make launch-worker REPO=<name>` | Start a Docker worker (headless) for a connected repo |
| `make launch-worker-host REPO=<name>` | Start a host-mode worker (interactive Windows Terminal tabs) |
| `make launch-dashboard-host` | Start the dashboard on the host (no Docker) |
| `make launch-all-workers` | Start Docker workers for every configured repo |
| `make stop-worker REPO=<name>` | Stop a Docker worker |
| `make stop-all-workers` | Stop every running worker |

## Deployment (per-target AWS)

Per-target deploys live at `.danxbot/deployments/<target>.yml`. Current targets: `gpt`.

| Command | Purpose |
|---------|---------|
| `make deploy TARGET=<t>` | Build, push to ECR, recreate containers on EC2 |
| `make deploy-status TARGET=<t>` | Show terraform state + dashboard health |
| `make deploy-logs TARGET=<t>` | Tail production container logs (streaming — cap with `timeout`) |
| `make deploy-ssh TARGET=<t>` | Interactive SSH to the EC2 instance |
| `make deploy-smoke TARGET=<t>` | End-to-end smoke test against the deployed dashboard |
| `make deploy-secrets-push TARGET=<t>` | Sync local `.env` files to SSM (destructive — overwrites SSM) |
| `make deploy-destroy TARGET=<t> ARGS=--confirm` | Tear down ALL AWS resources (irreversible) |

**"Deploy the X danxbot" always means `make deploy TARGET=<x>`** — never `make launch-worker` (local docker) and never the connected repo's own app deploy.

## Dashboard User Management

| Command | Purpose |
|---------|---------|
| `make create-user LOCALHOST=1 USERNAME=<u>` | Create / rotate a dashboard user against the local danxbot stack |
| `make create-user TARGET=<t> USERNAME=<u>` | Create / rotate a dashboard user on a deployed target |

Pass the password via `DANXBOT_CREATE_USER_PASSWORD='<password>'` env-var prefix, NOT a make variable assignment (the latter doesn't export to the recipe shell). Example: `DANXBOT_CREATE_USER_PASSWORD='secret' make create-user TARGET=gpt USERNAME=dan`. The CLI prints the API token exactly once — capture it from stdout. Re-running the command with the same username **rotates the token** (old token becomes invalid).

## Testing

Three layers — pick the one that matches your change.

| Command | Layer | Cost | Purpose |
|---------|-------|------|---------|
| `make test` | 1 | free | All unit + integration tests (mocked + fake-claude) |
| `make test-unit` | 1 | free | Unit only |
| `make test-integration` | 1 | free | Integration only (fake-claude + capture server) |
| `make test-validate` | 2 | ~$1 | Real Claude API, budget-capped at 150k tokens. Excluded from `make test`. |
| `make test-system` | 3 | ~$1 | Full stack — needs running infra+worker+`ANTHROPIC_API_KEY` |
| `make test-system-health` | 3 | low | Worker `/health` endpoint |
| `make test-system-dispatch` | 3 | ~$1 | Dispatch happy path |
| `make test-system-heartbeat` | 3 | low | Heartbeat + event forwarding via capture server |
| `make test-system-cancel` | 3 | low | Job cancellation |
| `make test-system-error` | 3 | low | Error recovery |
| `make test-system-stall` | 3 | varies | Stall detection (host-mode only) |
| `make test-system-poller` | 3 | low | Trello poller card lifecycle (needs TRELLO_API_KEY/TOKEN) |
| `make test-system-cleanup` | 3 | low | Orphaned temp dirs + zombie jobs |
| `make test-system-slack` | 3 | free | Slack agent E2E — 10 scenarios (fake bolt + fake pool + mocked dispatch). Verifies router→dispatch→reply→reactions→sql substitution chain. `REAL_CLAUDE=1` reserved for real Haiku+Opus case #11 (not yet wired; see Trello CudG7AJy). |

## Conventions

- **Always `cd` into `/home/newms/web/danxbot` first** before running any `make` target — Make resolves the Makefile relative to the working directory.
- **Long-running commands** (`deploy`, `test-system*`, `test-validate`): use a generous timeout or `run_in_background`. Never poll in a sleep loop.
- **Production-affecting targets** (`deploy`, `deploy-secrets-push`, `deploy-destroy`, `create-user TARGET=...`): require explicit user authorization before invoking — these are visible to others or destructive.
- **Local-only targets** (`build`, `launch-*`, `stop-*`, `logs`, `test*` Layer 1, `validate-repos`): safe to run without prompting.
