# Danxbot — shared infrastructure + per-repo workers
#
# Shared infra (MySQL + dashboard) runs from docker-compose.yml.
# Per-repo workers run from <repo>/.danxbot/config/compose.yml.

SHELL := /bin/bash

# Load .env for REPOS and shared vars
-include .env
export

REPOS_DIR := ./repos

.PHONY: help launch-infra stop-infra launch-worker stop-worker launch-all-workers stop-all-workers build logs validate-repos \
       generate-dev-override \
       test test-unit test-integration test-validate test-system \
       test-system-health test-system-dispatch test-system-heartbeat test-system-cancel \
       test-system-error test-system-stall test-system-poller test-system-allow-tools test-system-cleanup \
       deploy deploy-status deploy-destroy deploy-ssh deploy-logs deploy-secrets-push deploy-smoke \
       create-user reset-data

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-25s\033[0m %s\n", $$1, $$2}'

build: ## Build the danxbot Docker image
	docker compose build
	docker tag danxbot-flytebot-dashboard:latest danxbot:latest

generate-dev-override: ## Regenerate docker-compose.override.yml from REPOS (local dev only)
	@npx tsx src/cli/dev-compose-override.ts

launch-infra: generate-dev-override ## Start shared infrastructure (MySQL + dashboard)
	docker compose up -d

stop-infra: ## Stop shared infrastructure
	docker compose down

launch-worker: ## Start a worker for a repo (usage: make launch-worker REPO=platform)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required. Usage: make launch-worker REPO=platform"; exit 1; fi
	@COMPOSE_FILE="$(REPOS_DIR)/$(REPO)/.danxbot/config/compose.yml"; \
	REPO_ENV="$(REPOS_DIR)/$(REPO)/.danxbot/.env"; \
	if [ ! -f "$$COMPOSE_FILE" ]; then echo "Error: $$COMPOSE_FILE not found"; exit 1; fi; \
	if [ ! -f "$$REPO_ENV" ]; then echo "Error: $$REPO_ENV not found — needs DANXBOT_WORKER_PORT"; exit 1; fi; \
	PORT=$$(grep -E '^DANXBOT_WORKER_PORT=' "$$REPO_ENV" | tail -n1 | cut -d= -f2-); \
	if [ -z "$$PORT" ]; then echo "Error: DANXBOT_WORKER_PORT missing in $$REPO_ENV"; exit 1; fi; \
	export DANXBOT_WORKER_PORT="$$PORT"; \
	docker compose -f "$$COMPOSE_FILE" -p "danxbot-worker-$(REPO)" up -d

stop-worker: ## Stop a worker (usage: make stop-worker REPO=platform)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required. Usage: make stop-worker REPO=platform"; exit 1; fi
	docker compose -p "danxbot-worker-$(REPO)" down

launch-all-workers: ## Start workers for all configured repos
	@if [ -z "$(REPOS)" ]; then echo "Error: REPOS not set in .env"; exit 1; fi; \
	IFS=',' read -ra ENTRIES <<< "$(REPOS)"; \
	for entry in "$${ENTRIES[@]}"; do \
		name="$${entry%%:*}"; \
		COMPOSE_FILE="$(REPOS_DIR)/$$name/.danxbot/config/compose.yml"; \
		if [ -f "$$COMPOSE_FILE" ]; then \
			echo "Starting worker for $$name..."; \
			docker compose -f "$$COMPOSE_FILE" -p "danxbot-worker-$$name" up -d; \
		else \
			echo "Warning: $$COMPOSE_FILE not found, skipping $$name"; \
		fi; \
	done

stop-all-workers: ## Stop all repo workers
	@if [ -z "$(REPOS)" ]; then echo "Error: REPOS not set in .env"; exit 1; fi; \
	IFS=',' read -ra ENTRIES <<< "$(REPOS)"; \
	for entry in "$${ENTRIES[@]}"; do \
		name="$${entry%%:*}"; \
		echo "Stopping worker for $$name..."; \
		docker compose -p "danxbot-worker-$$name" down; \
	done

logs: ## Tail logs for infra or a worker (usage: make logs or make logs REPO=platform)
	@if [ -z "$(REPO)" ]; then \
		docker compose logs -f; \
	else \
		docker compose -p "danxbot-worker-$(REPO)" logs -f; \
	fi

validate-repos: ## Check host prerequisites for all connected repos before launching workers
	@if [ -z "$(REPOS)" ]; then echo "Error: REPOS not set in .env"; exit 1; fi; \
	ERRORS=0; \
	IFS=',' read -ra ENTRIES <<< "$(REPOS)"; \
	for entry in "$${ENTRIES[@]}"; do \
		name="$${entry%%:*}"; \
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

test-system-allow-tools: ## Test per-dispatch allow_tools gate via Trello MCP (requires TRELLO_API_KEY/TOKEN)
	@$(SYSTEM_TEST_SCRIPT) --test allow-tools

test-system-cleanup: ## Verify no orphaned temp dirs or zombie jobs
	@$(SYSTEM_TEST_SCRIPT) --test cleanup

# --- Deploy ---
#
# Production AWS deploy — per-deployment config at .danxbot/deployments/<TARGET>.yml.
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
		docker exec -i -e DANXBOT_CREATE_USER_PASSWORD danxbot-flytebot-dashboard-1 npx tsx src/cli/create-user.ts --username $(USERNAME); \
	else \
		docker exec -it danxbot-flytebot-dashboard-1 npx tsx src/cli/create-user.ts --username $(USERNAME); \
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

# Wipe operational data tables (dispatches, threads, events, health_check).
# Users + api_tokens are preserved so the dashboard login still works.
# LOCAL ONLY — there is no TARGET=<remote> branch. Production data is not
# something we want wiped by a one-liner. If prod ever needs a reset,
# add an explicit deploy/cli.ts subcommand with its own guardrails.
reset-data: ## Wipe local dispatches/threads/events (usage: make reset-data LOCALHOST=1)
ifdef LOCALHOST
	@docker exec -i danxbot-flytebot-dashboard-1 npx tsx src/cli/reset-data.ts
else
	@echo "Usage:"
	@echo "  make reset-data LOCALHOST=1"
	@echo ""
	@echo "No TARGET=<remote> branch — production data is not resettable via this target."
	@exit 1
endif
