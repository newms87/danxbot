# Danxbot — shared infrastructure + per-repo workers
#
# Shared infra (MySQL + dashboard) runs from docker-compose.yml.
# Per-repo workers run from <repo>/.danxbot/config/compose.yml.

SHELL := /bin/bash

# Load .env for REPOS and shared vars
-include .env
export

REPOS_DIR := ./repos

.PHONY: help launch-infra stop-infra launch-worker stop-worker launch-all-workers stop-all-workers build logs

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-25s\033[0m %s\n", $$1, $$2}'

build: ## Build the danxbot Docker image
	docker compose build

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

# Host-mode targets (for local development without Docker workers)

launch-worker-host: ## Start a worker on the host (usage: make launch-worker-host REPO=platform)
	@if [ -z "$(REPO)" ]; then echo "Error: REPO is required"; exit 1; fi
	DANXBOT_REPO_NAME=$(REPO) npx tsx src/index.ts

launch-dashboard-host: ## Start the dashboard on the host
	npx tsx src/index.ts
