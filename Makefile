# Danxbot — shared infrastructure + per-repo workers
#
# Shared infra (MySQL + dashboard) runs from docker-compose.yml.
# Per-repo workers run from <repo>/.danxbot/config/compose.yml.

SHELL := /bin/bash

# Load .env for REPOS and shared vars
-include .env
export

REPOS_DIR := ./repos

.PHONY: help launch-infra stop-infra launch-worker stop-worker launch-all-workers stop-all-workers build logs validate-repos

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-25s\033[0m %s\n", $$1, $$2}'

build: ## Build the danxbot Docker image
	docker compose build
	docker tag danxbot-flytebot-dashboard:latest danxbot:latest

launch-infra: ## Start shared infrastructure (MySQL + dashboard)
	docker compose up -d

stop-infra: ## Stop shared infrastructure
	docker compose down

launch-worker: ## Start a worker for a repo (usage: make launch-worker REPO=platform)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required. Usage: make launch-worker REPO=platform"; exit 1; fi
	@COMPOSE_FILE="$(REPOS_DIR)/$(REPO)/.danxbot/config/compose.yml"; \
	if [ ! -f "$$COMPOSE_FILE" ]; then echo "Error: $$COMPOSE_FILE not found"; exit 1; fi; \
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
	@set -a && . ./.env && set +a && DANXBOT_REPO_NAME=$(REPO) npx tsx src/index.ts

launch-dashboard-host: ## Start the dashboard on the host
	@set -a && . ./.env && set +a && npx tsx src/index.ts
