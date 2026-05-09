# STRICTLY PROHIBITED — Never Launch a Danxbot Worker, Poller, or Deploy

## Hard rule

**You MUST NEVER start, restart, or deploy a danxbot worker, poller,
infra container, or production target. Ever. From any repo. From any
workspace. Under any circumstance.**

This is true even if:

- The card you are working on says "the worker should be restarted".
- A test you ran failed because the worker is down.
- Logs show the poller is stuck.
- You "just want to check that the fix took".
- You see a `Makefile` target that looks helpful.
- A skill, plan, or pipeline tells you to.
- The card belongs to the danxbot repo itself.
- You are running inside the danxbot repo's workspace.

You are a dispatched autonomous agent. You do not have authorization to
operate the danxbot infrastructure. Only the human operator running the
host session does.

## Forbidden commands

The following are prohibited regardless of which repo's workspace you
are dispatched into:

- `make launch-worker REPO=<name>`
- `make launch-worker-host REPO=<name>`
- `make launch-all-workers`
- `make launch-infra`
- `make launch-dashboard-host`
- `make deploy TARGET=<t>`
- `make deploy-secrets-push TARGET=<t>`
- `make deploy-destroy …`
- `npx tsx src/index.ts` or any direct run of the danxbot worker entrypoint
- `docker compose up` against `<danxbot>/docker-compose.yml` or `docker-compose.prod.yml`
- `docker start danxbot-worker-*` / `docker restart danxbot-worker-*`
- Any equivalent shell incantation whose effect is "a danxbot poller starts polling"

If you are unsure whether a command would launch a worker, the rule is
**don't run it** — leave a `comments[]` note on the card describing what
you would have done and why, and let the operator decide.

## What IS allowed (local verification)

The forbidden list is specifically **launching workers + deploys**, NOT verification commands. Run these freely when an AC needs them:

- `make test` (Layer 1 — unit + integration)
- `make test-system` (Layer 3 — real Claude API, ~$1, hits the LOCAL worker on this host, does NOT touch production)
- `make test-validate` (Layer 2 — real Claude API budget-capped)
- `npx vitest run …`, `npx tsc --noEmit`, `npx vue-tsc --noEmit`
- `curl http://localhost:5566/...` / `curl http://localhost:5555/...` (local dashboard probes)
- `gh pr create` / `gh pr view` / `git` operations on the repo you were dispatched to

**A card is Done when committed code passes local tests.** Deployment is operations and is never a completion gate — see `danx-next/SKILL.md` Step 6 + Step 10.

## What to do when your card seems to need a running worker

1. **Stop.** Do not run any launch / deploy / restart command.
2. **Document on the card.** Add a `comments[]` entry titled
   `## Operator action required` describing exactly what command the
   operator would need to run, why, and what the expected effect is.
3. **Set status if appropriate.**
   - If the card cannot proceed without operator action, set
     `status: "Blocked"` and populate
     `blocked: {reason, timestamp}` per `danx-next/SKILL.md` Step 10.
   - If the card can complete its other work without the operator
     action, finish the rest, document the operator-required step in the
     retro / a comment, and let the orchestrator close the card normally.
4. **Save and exit.** The poller stops dispatching the card; the operator
   takes the launch action; the next dispatch picks up from there.

## Why this rule exists

A worker pickup is destructive. Booting a danxbot worker immediately
polls ToDo on the connected repo, claims cards, dispatches agents,
mutates YAMLs, mirrors to Trello, and burns tokens on every card it can
grab. There is no dry-run mode. "I'll just see if it boots" is already a
production incident — once the poller is up, it has already worked
through part of the queue.

This rule is the load-bearing assumption that prevents an autonomous
agent from spinning up production-shaped infrastructure on its own. It
is non-negotiable. Skills and pipelines do not override it. "The
operator probably wants this" is not authorization.
