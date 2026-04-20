# Production Access — You DO Have Direct Shell Access

## The rule I keep getting wrong

Production workers run on AWS EC2 instances per-target (e.g. `gpt`). The EC2 instance is remote, but **my local Bash tool can reach it through three established paths**: the deploy CLI, direct SSH, and the authenticated HTTP proxy on the dashboard. "It's on a production worker" is NOT a reason to say "I can't reach it from here." It is reachable — use the right command.

When a user asks about a deployed job, dispatch, session, or container — go pull the data instead of listing what I'd need.

## Deployments

Per-target config: `.danxbot/deployments/<TARGET>.yml`. Current targets: `gpt` (gpt-manager). Each target is its own AWS account/region/resources — complete isolation, per-target SSM prefix (e.g. `/danxbot-gpt/...`), per-target EC2.

## Reach paths

### 1. HTTP API (preferred for job/dispatch queries — no SSH, no streaming)

The dashboard proxies auth-gated requests to the right worker on `danxbot-net`. For the `gpt` target the public base is `https://danxbot.sageus.ai`. Routes (from `.claude/rules/agent-dispatch.md`):

| Route | Method | Notes |
|-------|--------|-------|
| `/api/launch` | POST | Body `{repo, task, api_token, ...}` |
| `/api/status/:jobId?repo=<name>` | GET | Returns `{job_id, status, summary, started_at, completed_at, elapsed_seconds, input_tokens, ...}` |
| `/api/cancel/:jobId?repo=<name>` | POST | |
| `/api/stop/:jobId?repo=<name>` | POST | External stop (not the in-agent MCP callback) |

All require `Authorization: Bearer <token>`. The token lives in SSM:

```bash
DANXBOT_DISPATCH_TOKEN=$(aws --profile gpt ssm get-parameter \
  --name /danxbot-gpt/shared/DANXBOT_DISPATCH_TOKEN \
  --with-decryption --region us-east-1 \
  --query Parameter.Value --output text)

curl -sS -H "Authorization: Bearer $DANXBOT_DISPATCH_TOKEN" \
  "https://danxbot.sageus.ai/api/status/<jobId>?repo=gpt-manager"
```

This is the right tool for questions like "why did job X time out / what was its summary / how long did it run".

### 2. Container logs on the EC2 instance

```bash
# Tails `docker compose -f docker-compose.prod.yml logs -f --tail=100` via SSH.
# Streaming — cap with `timeout` or background + grep.
timeout 20 make deploy-logs TARGET=gpt 2>&1 | grep <jobId>
```

Use for timeout reasons, stall detection traces, HTTP request errors, any `[Job <id>] ...` line from `src/agent/launcher.ts` or `src/worker/dispatch.ts`.

### 3. SSH for arbitrary shell on the instance

**CRITICAL: do not use bare `terraform output -raw public_ip`.** Terraform's backend is per-target and the last-initialized workspace wins — reading outputs without running `terraform init -reconfigure` first gives the IP of whichever target you last deployed, not the one you want. The deploy CLI does this correctly:

```bash
# Get the real IP for a target by running the deploy CLI's init-then-output pipeline:
cd /home/newms/web/danxbot-flytebot
IP=$(timeout 30 npx tsx deploy/cli.ts status gpt 2>&1 | grep -oE 'public[_ ]ip[^0-9]*[0-9.]+' | grep -oE '[0-9.]+$')
# Or parse from deploy-logs stdout (it prints the exact SSH command including the IP).

KEY=~/.ssh/danxbot-production-key.pem
ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR ubuntu@$IP \
    "cd /danxbot && docker compose -f docker-compose.prod.yml ps"

# Interactive session (user-driven — not ideal from Bash tool):
make deploy-ssh TARGET=gpt
```

From inside the instance, the entire worker container is reachable: `docker exec danxbot-worker-gpt-manager ...` for `mysql` queries against the dispatches DB, file reads on `~/.claude/projects/...` (claude session JSONLs live there), or any diagnostic shell.

### 4. SSM + Terraform state for infra questions

```bash
make deploy-status TARGET=gpt           # health + instance state
aws --profile gpt ssm get-parameters-by-path --path /danxbot-gpt/ --recursive --region us-east-1
```

## Canonical debugging recipes

**"Why did job X time out?"** → HTTP status (path 1) gives the `summary` string (`"Agent timed out after N seconds of inactivity"` vs `"Agent exceeded max runtime of N minutes"`). If I need more: `make deploy-logs TARGET=<target>` + grep for the jobId.

**"What session ID maps to job X?"** → Either path 1 (if we add session_id to getJobStatus) or SSH + `grep <dispatchId> ~/.claude/projects/*/*/*.jsonl` inside the worker container.

**"Is worker X alive?"** → `make deploy-status TARGET=<target>` (health probe).

**"What's in the dispatches DB?"** → SSH + `docker exec danxbot-mysql mysql ...` (never delete rows — read-only queries only unless the user explicitly asks).

## Forbidden

- Saying "I don't have access to the production worker" when `make deploy-*` targets exist.
- Running production read commands in a `run_in_background` loop — use `timeout` to cap streaming commands.
- Pushing to SSM, destroying infra, restarting the instance, or running `make deploy-destroy` / `make deploy-secrets-push` without explicit user approval.
- Assuming the Laravel dispatch row mirrors worker state — neither timeout path in `launcher.ts` PUTs terminal status (`cleanup()` + `onComplete()` only), so the Laravel row can be stale while the worker already finalized. Pull the worker's HTTP status or container logs as ground truth.
