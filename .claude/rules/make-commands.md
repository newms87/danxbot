# Make Commands

Source of truth = `Makefile` (`make help`). Always `cd /home/newms/web/danxbot` before invoking.

## CRITICAL: Check Make First, Docker/Curl Last

**Before any `docker {restart,logs,exec,ps,inspect}` or hand-rolled `curl` against worker/dashboard endpoints, check the table for an equivalent make target.** Make targets are documented + reproducible; ad-hoc docker commands drift as compose evolves.

| Tempting ad-hoc | Use instead |
|---|---|
| `docker restart danxbot-worker-<repo>` | `make launch-worker REPO=<repo>` |
| `docker logs danxbot-worker-<repo>` | `make logs REPO=<repo>` |
| `curl -X POST .../api/launch` smoke | `make test-system-dispatch` |
| `curl .../health` | `make test-system-health` |
| `docker compose up -d` (dev) | `make launch-infra` |

**No make target?** `docker exec` is legitimate but call it out explicitly ("no make target covers per-user auth state inside the worker, dropping to `docker exec`") so the escape is visible. Silent docker use is how the rule rots.

## Local Targets (safe to run)

| Command | Purpose |
|---------|---------|
| `make help` | Show all targets |
| `make build` | Rebuild Docker image (after Dockerfile / pip pin changes) |
| `make validate-repos` | Pre-flight check connected repos' dev stacks |
| `make launch-infra` | Start shared MySQL + dashboard |
| `make stop-infra` | Stop shared infra |
| `make logs [REPO=<name>]` | Tail infra or worker logs |


> **DX-551 — `make install-cron` / `make uninstall-cron` retired.** The per-minute `tick.ts` dispatcher folded INTO the running worker (`src/cron/worker-loop.ts`): the same `jobs[]` registry fires on boot + every 60s while the worker is alive, with `lastRunMs` persisted in `<repo>/.danxbot/cron-state.json`. If you upgraded over an install that previously ran `make install-cron`, run `crontab -e` once and delete the `# danxbot-cron` line — the now-missing `src/cron/tick.ts` script will error silently every minute otherwise. Fresh installs require no cron action.

## Worker / Deploy Launch (STRICTLY PROHIBITED w/o user auth)

> **STOP — invoke `danxbot:no-unauthorized-worker-launch` skill BEFORE running ANY of these.** Every `launch-*` / `deploy*` starts a poller / prod target that immediately claims ToDo cards, dispatches agents, mutates YAMLs, burns tokens. Prior-session approvals do NOT carry forward.

| Command | Purpose |
|---------|---------|
| `make launch-worker REPO=<name>` | Docker worker |
| `make launch-worker-host REPO=<name>` | Host-mode worker (interactive terminals) |
| `make launch-dashboard-host` | Dashboard on host (no Docker) |
| `make launch-all-workers` | Docker workers for every repo |
| `make stop-worker REPO=<name>` / `make stop-all-workers` | Stop |

**Deploy targets, secrets push, destroy, deploy-status / deploy-logs / deploy-ssh / deploy-smoke, dashboard user create on prod** → invoke `danxbot:prod-access` skill (full table + recipes there). Local `make create-user LOCALHOST=1 USERNAME=<u>` is fine; pass password via `DANXBOT_CREATE_USER_PASSWORD='<pw>'` env-var prefix (NOT make var).

## Testing — three layers

| Command | Layer | Cost | Purpose |
|---------|-------|------|---------|
| `make test` / `make test-unit` / `make test-integration` | 1 | free | Mocked + fake-claude |
| `make test-validate` | 2 | ~$1 | Real Claude API, 150k token cap. Excluded from `make test`. |
| `make test-system[-dispatch,-health,-heartbeat,-cancel,-error,-stall,-poller,-cleanup,-slack,-prep,-orphan-reap]` | 3 | ~$1 max | Full stack; needs infra+worker+`ANTHROPIC_API_KEY`. `test-system-slack` + `test-system-prep` are free (deterministic — no Claude spend). `test-system-prep` covers the four prep-verdict paths (DX-291 / DX-297) via the prep-flow integration test. `test-system-orphan-reap` (DX-323 / DX-328) skips on docker workers — scope confinement is host-only. |

## Conventions

- **Long-running** (`deploy*`, `test-system*`, `test-validate`): generous timeout or `run_in_background`. Never sleep-poll.
- **Production-affecting** (`deploy*`, `create-user TARGET=...`): explicit user authorization required.
