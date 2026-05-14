# Danxbot — shared infrastructure + per-repo workers
#
# Shared infra (MySQL + dashboard) runs from docker-compose.yml.
# Per-repo workers run from <repo>/.danxbot/config/compose.yml.

SHELL := /bin/bash

# Load .env for shared vars (Anthropic key, DB creds, dispatch token, etc).
# Connected-repo list comes from deploy/targets/<DANXBOT_TARGET>.yml
# (default `local`) — NOT from any REPOS env var, as of Phase B.
-include .env
export

REPOS_DIR := ./repos

# Active deploy target — selects deploy/targets/<DANXBOT_TARGET>.yml at
# every Makefile invocation. Override on the CLI: `make ... DANXBOT_TARGET=gpt`.
DANXBOT_TARGET ?= local

# Print the connected-repo names for the active target, one per line.
# Wraps `npx tsx src/cli/list-target-repos.ts` so every iteration loop
# reads from the same source as the runtime (`src/target.ts#loadTarget`).
TARGET_REPO_NAMES = $(shell DANXBOT_TARGET="$(DANXBOT_TARGET)" npx tsx src/cli/list-target-repos.ts 2>/dev/null)

.PHONY: help launch-infra stop-infra launch-worker stop-worker launch-all-workers stop-all-workers build logs validate-repos \
       generate-dev-override \
       test test-unit test-integration test-validate test-system \
       test-system-health test-system-dispatch test-system-heartbeat test-system-cancel \
       test-system-error test-system-stall test-system-poller test-system-yaml-memory test-system-cleanup \
       test-system-multi-worker test-system-slack test-system-agent-creation test-system-prep test-system-flesh-out test-system-chat test-system-orphan-reap \
       deploy deploy-status deploy-destroy deploy-ssh deploy-logs deploy-secrets-push deploy-smoke \
       create-user ensure-root-user reset-data \
       publish-danx-issue-mcp publish-playwright-mcp \
       install-cron uninstall-cron

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-25s\033[0m %s\n", $$1, $$2}'

build: ## Build the danxbot Docker image
	@set -e; \
	DANXBOT_COMMIT="$$(git rev-parse --short HEAD)"; \
	if [ -z "$$DANXBOT_COMMIT" ]; then \
		echo "Error: DANXBOT_COMMIT empty — run from a git checkout"; exit 1; \
	fi; \
	export DANXBOT_COMMIT; \
	echo "  Baking DANXBOT_COMMIT=$$DANXBOT_COMMIT into image"; \
	docker compose build
	docker tag danxbot-dashboard:latest danxbot:latest

generate-dev-override: ## Regenerate docker-compose.override.yml from deploy/targets/<TARGET>.yml (local dev only)
	@npx tsx src/cli/dev-compose-override.ts

launch-infra: generate-dev-override ## Start shared infrastructure (MySQL + dashboard)
	@# Per-repo realpath + env export mirrors `launch-worker`'s pattern.
	@# `./repos/<name>` is a symlink; binding it directly on WSL2 + Docker
	@# Desktop creates a container-local phantom directory disconnected
	@# from the host target (observed empirically: dashboard writes to
	@# `.danxbot/settings.json` never reached the host, and the worker's
	@# `CRITICAL_FAILURE` file was invisible to the dashboard). Exporting
	@# the resolved path bypasses the trap.
	@# Var-name scheme must match `repoRootVarName()` in
	@# src/cli/dev-compose-override.ts — uppercase + hyphens → underscores.
	@# Repo list comes from deploy/targets/$(DANXBOT_TARGET).yml via the
	@# TARGET_REPO_NAMES helper — single source of truth shared with the
	@# runtime (`src/target.ts#loadTarget`).
	@set -e; \
	NAMES="$(TARGET_REPO_NAMES)"; \
	if [ -z "$$NAMES" ]; then \
		echo "Warning: deploy/targets/$(DANXBOT_TARGET).yml lists no repos — dashboard starts with no repo binds; Agents tab will be empty"; \
		docker compose up -d; \
		exit 0; \
	fi; \
	for name in $$NAMES; do \
		var="DANXBOT_REPO_ROOT_$$(echo "$$name" | tr 'a-z-' 'A-Z_')"; \
		path="$$(realpath "$(REPOS_DIR)/$$name" 2>/dev/null)"; \
		if [ -z "$$path" ]; then \
			echo "Error: $(REPOS_DIR)/$$name does not exist (target $(DANXBOT_TARGET) lists repo: $$name)"; exit 1; \
		fi; \
		export "$$var=$$path"; \
	done; \
	docker compose up -d

stop-infra: ## Stop shared infrastructure
	docker compose down

launch-worker: ## Start a worker for a repo (usage: make launch-worker REPO=platform)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required. Usage: make launch-worker REPO=platform"; exit 1; fi
	@COMPOSE_FILE="$(REPOS_DIR)/$(REPO)/.danxbot/config/compose.yml"; \
	if [ ! -f "$$COMPOSE_FILE" ]; then echo "Error: $$COMPOSE_FILE not found"; exit 1; fi; \
	REPOS_DIR="$(REPOS_DIR)" . ./scripts/worker-env.sh "$(REPO)" || exit 1; \
	if [ "$(REPO)" = "danxbot" ]; then \
		./scripts/check-claude-auth-env.sh || exit 1; \
	fi; \
	./scripts/check-worker-port.sh container "$(REPO)" "$$DANXBOT_WORKER_PORT" || exit 1; \
	mkdir -p "$(REPOS_DIR)/$(REPO)/claude-projects"; \
	docker compose -f "$$COMPOSE_FILE" -p "danxbot-worker-$(REPO)" up -d || exit 1; \
	./scripts/check-worker-port.sh post-up "$(REPO)" "$$DANXBOT_WORKER_PORT" || exit 1

stop-worker: ## Stop a worker (usage: make stop-worker REPO=platform)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required. Usage: make stop-worker REPO=platform"; exit 1; fi
	docker compose -p "danxbot-worker-$(REPO)" down

launch-all-workers: ## Start workers for all configured repos
	@# Each iteration runs in a `( ... )` subshell so the per-repo
	@# exports from `scripts/worker-env.sh` (DANXBOT_WORKER_PORT etc.)
	@# do not leak between iterations. Without the subshell, repo A's
	@# port would still be exported when repo B sources the helper, and
	@# any failure mode in the helper that left the variable unchanged
	@# would silently reuse A's value for B (Trello oGbjLtjN).
	@#
	@# CRITICAL: do NOT chain the subshell with `( ... ) || exit 1`.
	@# Bash's `set -e` exemption applies to the entire left operand of
	@# a `||` list — including commands inside that operand's subshell.
	@# `( set -e; ... ) || exit 1` therefore silently disables `set -e`
	@# inside the subshell: a failing helper does NOT abort, the loop
	@# continues to the next repo, and make exits 0. Capture the
	@# subshell's `$$?` separately and check it. Verified empirically
	@# (Trello K2zQYIdX retro).
	@NAMES="$(TARGET_REPO_NAMES)"; \
	if [ -z "$$NAMES" ]; then echo "Error: deploy/targets/$(DANXBOT_TARGET).yml lists no repos"; exit 1; fi; \
	for name in $$NAMES; do \
		COMPOSE_FILE="$(REPOS_DIR)/$$name/.danxbot/config/compose.yml"; \
		if [ ! -f "$$COMPOSE_FILE" ]; then \
			echo "Warning: $$COMPOSE_FILE not found, skipping $$name"; \
			continue; \
		fi; \
		echo "Starting worker for $$name..."; \
		( set -e; \
		  REPOS_DIR="$(REPOS_DIR)" . ./scripts/worker-env.sh "$$name"; \
		  if [ "$$name" = "danxbot" ]; then \
		      ./scripts/check-claude-auth-env.sh; \
		  fi; \
		  mkdir -p "$(REPOS_DIR)/$$name/claude-projects"; \
		  docker compose -f "$$COMPOSE_FILE" -p "danxbot-worker-$$name" up -d ); \
		rc=$$?; \
		if [ $$rc -ne 0 ]; then exit $$rc; fi; \
	done

stop-all-workers: ## Stop all repo workers
	@NAMES="$(TARGET_REPO_NAMES)"; \
	if [ -z "$$NAMES" ]; then echo "Error: deploy/targets/$(DANXBOT_TARGET).yml lists no repos"; exit 1; fi; \
	for name in $$NAMES; do \
		echo "Stopping worker for $$name..."; \
		docker compose -p "danxbot-worker-$$name" down; \
	done

logs: ## Tail logs for infra or a worker (usage: make logs or make logs REPO=platform)
	@if [ -z "$(REPO)" ]; then \
		docker compose logs -f; \
	else \
		docker compose -p "danxbot-worker-$(REPO)" logs -f; \
	fi

# System cron tick dispatcher — DX-324 / parent epic DX-323.
#
# Installs ONE crontab line that fires `src/cron/tick.ts` every minute.
# `tick.ts` iterates `src/cron/jobs/index.ts` and runs each due job in
# isolation. Phase 1 ships an empty registry; later phases (DX-327
# reap-orphan-dispatches) register jobs here. The single crontab entry
# never changes — we add jobs in the registry, not in cron.
#
# Idempotent: removes any prior line ending in `# danxbot-cron` before
# appending so repeated `make install-cron` invocations converge on
# exactly one entry. The marker-comment filter is fixed-string (`-F`)
# + the literal `# ` prefix so we never accidentally match an unrelated
# line that happens to contain the substring `danxbot-cron`. `crontab
# -l` exits 1 when the user has no crontab yet — the `|| true` keeps
# the pipeline from short-circuiting on first install.
#
# `$(CURDIR)` resolves at `make` invocation time. Running install-cron
# from a git worktree (e.g. `.danxbot/worktrees/<agent>/`) pins cron
# to that worktree's path — invoke from the main clone for the
# intended persistent install.
CRON_LINE := * * * * * cd $(CURDIR) && /usr/bin/env npx tsx src/cron/tick.ts >> /tmp/danxbot-cron.log 2>&1 \# danxbot-cron

install-cron: ## Install/replace the per-minute danxbot system cron entry
	@( crontab -l 2>/dev/null || true ) | grep -vF '# danxbot-cron' | { cat; echo '$(CRON_LINE)'; } | crontab -
	@echo "Installed cron line: $(CRON_LINE)"
	@echo "Stderr lands in /tmp/danxbot-cron.log"

uninstall-cron: ## Remove the danxbot system cron entry (no-op when absent)
	@if crontab -l 2>/dev/null | grep -q 'danxbot-cron'; then \
		crontab -l 2>/dev/null | grep -vF '# danxbot-cron' | crontab -; \
		echo "Removed danxbot-cron line"; \
	else \
		echo "No danxbot-cron line installed; nothing to remove"; \
	fi

validate-repos: ## Check host prerequisites for all connected repos before launching workers
	@NAMES="$(TARGET_REPO_NAMES)"; \
	if [ -z "$$NAMES" ]; then echo "Error: deploy/targets/$(DANXBOT_TARGET).yml lists no repos"; exit 1; fi; \
	ERRORS=0; \
	for name in $$NAMES; do \
		repo_path="$(REPOS_DIR)/$$name"; \
		echo "Checking $$name..."; \
		if [ ! -d "$$repo_path" ] && [ ! -L "$$repo_path" ]; then \
			echo "  ERROR: $$repo_path does not exist (create symlink or clone repo)"; \
			ERRORS=$$((ERRORS + 1)); \
			continue; \
		fi; \
		REPO_OK=1; \
		if [ ! -f "$$repo_path/.danxbot/.env" ]; then \
			echo "  ERROR: $$repo_path/.danxbot/.env missing (repo secrets required)"; \
			ERRORS=$$((ERRORS + 1)); REPO_OK=0; \
		fi; \
		if [ ! -f "$$repo_path/.danxbot/config/compose.yml" ]; then \
			echo "  ERROR: $$repo_path/.danxbot/config/compose.yml missing"; \
			ERRORS=$$((ERRORS + 1)); REPO_OK=0; \
		fi; \
		if [ -f "$$repo_path/composer.json" ] && [ ! -d "$$repo_path/ssap/vendor" ] && [ ! -d "$$repo_path/vendor" ]; then \
			echo "  WARNING: No vendor/ found — run composer install on the host first"; \
		fi; \
		if [ -f "$$repo_path/package.json" ] && [ ! -d "$$repo_path/node_modules" ]; then \
			echo "  WARNING: No node_modules/ found — run npm install on the host first"; \
		fi; \
		if [ "$$REPO_OK" -eq 1 ]; then echo "  $$name OK"; fi; \
	done; \
	if [ "$$ERRORS" -gt 0 ]; then echo ""; echo "$$ERRORS error(s) found. Fix before launching workers."; exit 1; fi; \
	echo ""; echo "All repos validated."

# Host-mode targets (for local development without Docker workers)

launch-worker-host: ## Start a worker on the host (usage: make launch-worker-host REPO=platform)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required"; exit 1; fi
	@REPO_ENV="$(REPOS_DIR)/$(REPO)/.danxbot/.env"; \
	if [ ! -f "$$REPO_ENV" ]; then echo "Error: $$REPO_ENV not found — needs DANXBOT_WORKER_PORT"; exit 1; fi; \
	set -a && . ./.env && . "$$REPO_ENV" && set +a; \
	if [ -z "$$DANXBOT_WORKER_PORT" ]; then echo "Error: DANXBOT_WORKER_PORT missing in $$REPO_ENV"; exit 1; fi; \
	./scripts/check-worker-port.sh host "$(REPO)" "$$DANXBOT_WORKER_PORT" || exit 1; \
	DANXBOT_REPO_NAME=$(REPO) npx tsx src/index.ts

launch-dashboard-host: ## Start the dashboard on the host
	@set -a && . ./.env && set +a && npx tsx src/index.ts

# --- Testing ---
#
# Three test layers, each with different requirements:
#
# Layer 1 — Unit + Integration (no external deps, free)
#   make test           Run all unit + integration tests
#   make test-unit      Unit tests only (mocked, fast)
#   make test-integration  Integration tests only (fake-claude + capture server)
#
# Layer 2 — Validation (real Claude API, ~$0.50-1.00 per run)
#   make test-validate  Real Claude CLI/SDK calls, budget-capped at 150k tokens
#                       Requires ANTHROPIC_API_KEY in .env
#
# Layer 3 — System (real Docker workers + real Claude API, ~$0.50-1.00 per run)
#   make test-system    All system tests against running Docker workers
#   make test-system-*  Individual system test targets (see below)
#                       Requires: make launch-infra + make launch-worker
#

test: ## Run all unit + integration tests (Layer 1 — free, no external deps)
	@npx vitest run

test-unit: ## Run unit tests only (excludes integration + validation)
	@npx vitest run --exclude '**/integration/**' --exclude '**/validation/**'

test-integration: ## Run integration tests only (fake-claude + capture server)
	@npx vitest run src/__tests__/integration

test-validate: ## Run validation tests (Layer 2 — real Claude API, ~$1)
	@npx vitest run --config vitest.validation.config.ts

# --- System Tests (Layer 3 — real Docker dispatch, real Claude API) ---

SYSTEM_TEST_SCRIPT := ./src/__tests__/system/run-system-tests.sh
SYSTEM_TEST_FLAGS :=

test-system: ## Run all system tests (requires running workers + ANTHROPIC_API_KEY)
	@$(SYSTEM_TEST_SCRIPT) $(SYSTEM_TEST_FLAGS)

test-system-health: ## Test worker health endpoints
	@$(SYSTEM_TEST_SCRIPT) --test health

test-system-dispatch: ## Test dispatch API happy path
	@$(SYSTEM_TEST_SCRIPT) --test dispatch

test-system-heartbeat: ## Test heartbeat + event forwarding via capture server
	@$(SYSTEM_TEST_SCRIPT) --test heartbeat

test-system-cancel: ## Test job cancellation
	@$(SYSTEM_TEST_SCRIPT) --test cancel

test-system-error: ## Test error recovery
	@$(SYSTEM_TEST_SCRIPT) --test error

test-system-stall: ## Test stall detection (host mode only)
	@$(SYSTEM_TEST_SCRIPT) --test stall --host-mode

test-system-poller: ## Test Trello poller flow (requires TRELLO_API_KEY/TOKEN)
	@$(SYSTEM_TEST_SCRIPT) --test poller

test-system-yaml-memory: ## Phase 4 AC #6 — verify dispatched session JSONL has zero mcp__trello__ references (~$0.05)
	@$(SYSTEM_TEST_SCRIPT) --test yaml-memory

test-system-cleanup: ## Verify no orphaned temp dirs or zombie jobs
	@$(SYSTEM_TEST_SCRIPT) --test cleanup

test-system-orphan-reap: ## DX-323 / DX-328 — scope-stop reaps backgrounded grandchildren (host worker only, ~$0.05)
	@$(SYSTEM_TEST_SCRIPT) --test orphan-reap

test-system-agent-creation: ## DX-262 — agent CRUD + worktree validity E2E (free, no Claude API)
	@./src/__tests__/system/test-agent-creation.sh

test-system-prep: ## DX-291 / DX-297 — prep verdict route + onComplete chain (free, no Claude API)
	@./src/__tests__/system/run-prep-system-test.sh

test-system-flesh-out: ## DX-348 Phase 1 / DX-349 — /api/flesh-out route end-to-end (free, no Claude API)
	@./src/__tests__/system/run-flesh-out-system-test.sh

test-system-chat: ## DX-348 Phase 3 / DX-351 — /api/chat route + chat-sessions persistence (free, no Claude API)
	@./src/__tests__/system/run-chat-system-test.sh

test-system-multi-worker: ## DX-164 Phase 6 — multi-agent roster surface (free) + REAL_CLAUDE=1 concurrent dispatch (~$1)
	@$(SYSTEM_TEST_SCRIPT) --test multi-worker

# Slack agent E2E test (Trello CudG7AJy). Default = free mode (vitest +
# fake bolt + fake pool + mocked dispatch — no Anthropic spend, no
# external infrastructure). REAL_CLAUDE=1 is reserved for the real
# Haiku + real Opus harness (case #11), tracked in Trello Oos7TCZD —
# fail loud until that lands so an operator passing the flag never
# silently downgrades to free mode.
test-system-slack: ## Run Slack agent E2E scenarios (free mode by default; REAL_CLAUDE=1 fails loud until Trello Oos7TCZD lands)
ifeq ($(REAL_CLAUDE),1)
	@echo "ERROR: REAL_CLAUDE=1 mode is not yet wired — see Trello Oos7TCZD." >&2; exit 1
else
	@npx vitest run src/__tests__/system/slack-agent-e2e.test.ts
endif

# --- Deploy ---
#
# Production AWS deploy — per-deployment config at deploy/targets/<TARGET>.yml.
# Each TARGET is its own AWS account / region / resources — complete isolation.
#

_require_target:
	@if [ -z "$(TARGET)" ]; then \
		echo "Error: TARGET is required. Usage: make deploy TARGET=gpt"; exit 1; \
	fi

deploy: _require_target ## Deploy to AWS (usage: make deploy TARGET=gpt)
	npx tsx deploy/cli.ts deploy $(TARGET) $(ARGS)

deploy-status: _require_target ## Show infra state + health (usage: make deploy-status TARGET=gpt)
	npx tsx deploy/cli.ts status $(TARGET)

deploy-destroy: _require_target ## Tear down all AWS resources (usage: make deploy-destroy TARGET=gpt ARGS=--confirm)
	npx tsx deploy/cli.ts destroy $(TARGET) $(ARGS)

deploy-ssh: _require_target ## SSH to the deployed instance (usage: make deploy-ssh TARGET=gpt)
	npx tsx deploy/cli.ts ssh $(TARGET)

deploy-logs: _require_target ## Tail container logs (usage: make deploy-logs TARGET=gpt)
	npx tsx deploy/cli.ts logs $(TARGET)

deploy-secrets-push: _require_target ## Sync local .env files to SSM (usage: make deploy-secrets-push TARGET=gpt)
	npx tsx deploy/cli.ts secrets-push $(TARGET)

deploy-smoke: _require_target ## Smoke-test the deployed dashboard (usage: make deploy-smoke TARGET=gpt)
	npx tsx deploy/cli.ts smoke $(TARGET)

# --- Operator: create / rotate dashboard users ---
#
# Creates a new dashboard user OR updates an existing user's password and
# rotates their API token. Prints the raw token to local stdout exactly once.
# Password is never accepted as an argument — it's prompted on the local TTY
# (or read from DANXBOT_CREATE_USER_PASSWORD for non-interactive use).
#
# For non-interactive use, pass the env var as a PREFIX to `make`, not as a
# make variable assignment:
#
#   DANXBOT_CREATE_USER_PASSWORD=secret make create-user LOCALHOST=1 USERNAME=foo
#
# `make DANXBOT_CREATE_USER_PASSWORD=secret …` will NOT export the variable to
# the recipe's shell and will silently fall into the interactive TTY branch.

create-user: ## Create / rotate a dashboard user (usage: make create-user LOCALHOST=1 USERNAME=foo OR TARGET=gpt USERNAME=foo)
ifdef LOCALHOST
	@if [ -z "$(USERNAME)" ]; then echo "Error: USERNAME is required"; exit 1; fi
	@if [ -n "$$DANXBOT_CREATE_USER_PASSWORD" ]; then \
		docker exec -i -e DANXBOT_CREATE_USER_PASSWORD danxbot-dashboard-1 npx tsx src/cli/create-user.ts --username $(USERNAME); \
	else \
		docker exec -it danxbot-dashboard-1 npx tsx src/cli/create-user.ts --username $(USERNAME); \
	fi
else ifdef TARGET
	@if [ -z "$(USERNAME)" ]; then echo "Error: USERNAME is required"; exit 1; fi
	@npx tsx deploy/cli.ts create-user $(TARGET) $(USERNAME)
else
	@echo "Usage:"
	@echo "  make create-user LOCALHOST=1 USERNAME=<name>"
	@echo "  make create-user TARGET=<gpt|...> USERNAME=<name>"
	@exit 1
endif

# --- Operator: provision / refresh the dashboard root user ---
#
# Reads DANX_DASHBOARD_ROOT_USER from the dashboard container's env
# (sourced from .env via env_file in dev, from SSM-materialized .env
# in prod). Format: "username//password". Idempotent — no DB write
# and no token rotation when the password already matches.
#
# Wired into the deploy pipeline (after worker launch) so prod stays
# in sync without an extra step. For local dev, run manually after
# `make launch-infra`.

ensure-root-user: ## Ensure DANX_DASHBOARD_ROOT_USER exists / refreshed (usage: make ensure-root-user LOCALHOST=1 OR TARGET=gpt)
ifdef LOCALHOST
	@docker exec -i danxbot-dashboard-1 npx tsx src/cli/ensure-root-user.ts
else ifdef TARGET
	@npx tsx deploy/cli.ts ensure-root-user $(TARGET)
else
	@echo "Usage:"
	@echo "  make ensure-root-user LOCALHOST=1"
	@echo "  make ensure-root-user TARGET=<gpt|...>"
	@exit 1
endif

# Wipe operational data tables (dispatches, threads, events, health_check).
# Users + api_tokens are preserved so the dashboard login still works.
# LOCAL ONLY — there is no TARGET=<remote> branch. Production data is not
# something we want wiped by a one-liner. If prod ever needs a reset,
# add an explicit deploy/cli.ts subcommand with its own guardrails.
reset-data: ## Wipe local dispatches/threads/events (usage: make reset-data LOCALHOST=1)
ifdef LOCALHOST
	@docker exec -i danxbot-dashboard-1 npx tsx src/cli/reset-data.ts
else
	@echo "Usage:"
	@echo "  make reset-data LOCALHOST=1"
	@echo ""
	@echo "No TARGET=<remote> branch — production data is not resettable via this target."
	@exit 1
endif

# DX-241 emergency cleanup. Walks every YAML in
# `<repo>/.danxbot/issues/{open,closed}/`, finds tracker comments
# carrying the dispatch-lock marker, and edits them to the "released"
# form so the next poll tick reclaims without waiting the 2h TTL.
# Runs from the repo root (cwd-relative paths inside the script
# match the worker's view of `repos/<n>/`).
#
#   make clear-stale-locks REPO=<n>                   # apply
#   DRY_RUN=1 make clear-stale-locks REPO=<n>         # preview only
#   AGE_HOURS=4 make clear-stale-locks REPO=<n>       # only locks ≥ 4h old
#
# Idempotent — locks already in released form are reported but not
# re-edited. Failures on a single card are logged but never abort
# the run. See `scripts/clear-stale-locks.ts` for the full contract.
clear-stale-locks: ## Release every stale dispatch-lock comment for a repo (usage: make clear-stale-locks REPO=<n>)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required. Usage: make clear-stale-locks REPO=<n>"; exit 1; fi
	@DANXBOT_REPO_NAME="$(REPO)" DRY_RUN="$(DRY_RUN)" AGE_HOURS="$(AGE_HOURS)" npx tsx scripts/clear-stale-locks.ts

# Publish @thehammer/danx-issue-mcp to npm. Danxbot OWNS this package
# (source at ~/web/danx-issue-mcp/) — every dispatched agent and host
# session resolves the MCP via `npx -y @thehammer/danx-issue-mcp`, so
# npm is the single source of truth.
#
# Standing authorization: any agent that edits the danx-issue-mcp source
# MUST run this target. Publishing is not a destructive op for this
# package — it is the natural completion of any source change. Do NOT
# block on operator confirmation; do NOT defer to a "human will publish"
# step. The package is danxbot's; danxbot publishes it.
#
# Steps mirror gpt-manager's older copy of this target:
#   1. Build (esbuild bundle) + bump patch version
#   2. Publish (per-publish .npmrc from NPM_TOKEN; bypasses stale ~/.npmrc)
#   3. Wait for registry propagation
#   4. Clear ~/.npm/_npx caches so the next `npx -y` pulls the new bundle
publish-danx-issue-mcp: ## Publish @thehammer/danx-issue-mcp to npm (danxbot owns this package)
	@if [ -z "$(NPM_TOKEN)" ]; then echo "ERROR: NPM_TOKEN missing from danxbot/.env"; exit 1; fi
	@set -e; \
	cd ../danx-issue-mcp && npm run build && npm version patch --no-git-tag-version; \
	NEW_VERSION=$$(node -p "require('./package.json').version"); \
	echo ""; \
	echo ">>> Publishing @thehammer/danx-issue-mcp@$$NEW_VERSION"; \
	echo "//registry.npmjs.org/:_authToken=$(NPM_TOKEN)" > .npmrc; \
	trap 'rm -f .npmrc' EXIT; \
	unset npm_config_registry npm_config_user_agent; \
	npm publish --access public --userconfig=.npmrc; \
	echo ""; \
	echo ">>> Waiting for npm registry propagation..."; \
	LAST_ERR=""; \
	for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		if VIEW_OUT=$$(npm view @thehammer/danx-issue-mcp@$$NEW_VERSION version 2>&1); then \
			if [ "$$VIEW_OUT" = "$$NEW_VERSION" ]; then \
				echo "    Registry sees $$NEW_VERSION (attempt $$i)"; \
				break; \
			fi; \
		else \
			case "$$VIEW_OUT" in \
				*E404*|*"code E404"*|*"is not in this registry"*) LAST_ERR="$$VIEW_OUT" ;; \
				*) echo "    ERROR: npm view failed unexpectedly:"; echo "$$VIEW_OUT"; exit 1 ;; \
			esac; \
		fi; \
		if [ $$i -eq 15 ]; then \
			echo "    ERROR: npm registry never surfaced $$NEW_VERSION after 15 attempts (~30s)"; \
			[ -n "$$LAST_ERR" ] && echo "    Last response: $$LAST_ERR"; \
			exit 1; \
		fi; \
		sleep 2; \
	done; \
	echo ""; \
	echo ">>> Clearing local npm manifest cache (stale cache causes ETARGET)"; \
	npm cache clean --force; \
	echo ""; \
	echo ">>> Clearing stale ~/.npm/_npx/ caches so future invocations pull the new version"; \
	for dir in $$HOME/.npm/_npx/*/; do \
		if [ -d "$$dir/node_modules/@thehammer/danx-issue-mcp" ]; then \
			echo "    Clearing $$dir"; \
			find "$$dir" -mindepth 1 -delete; \
			rmdir "$$dir"; \
		fi; \
	done; \
	echo ""; \
	echo ">>> publish-danx-issue-mcp DONE. @thehammer/danx-issue-mcp@$$NEW_VERSION is live on npm."

# Publish the in-tree Playwright MCP server package to npm. The registry
# (src/agent/mcp-registry.ts PLAYWRIGHT_ENTRY) currently invokes the
# server via `npx tsx <abs-path>`, so a publish step is optional — the
# capability ships with the repo source. Once published, flip the
# registry args from `["tsx", PLAYWRIGHT_MCP_SERVER_PATH]` to
# `["-y", "@thehammer/danxbot-playwright-mcp-server"]` to match the
# schema / trello server pattern. Uses NPM_TOKEN from danxbot/.env via
# the same per-publish .npmrc pattern as publish-danx-issue-mcp; no
# `npm login` step needed.
publish-playwright-mcp: ## Publish @thehammer/danxbot-playwright-mcp-server to npm
	@cd mcp-servers/playwright && npm install --no-save && npm run build && npm publish --access public
