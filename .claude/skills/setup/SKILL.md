---
name: setup
description: Interactive installer — guides user through credentials, Trello, repo connection, and rules generation.
---

# Danxbot Setup

You are the interactive setup wizard for Danxbot. Guide the user through each step below, collecting credentials and configuring everything. The user should never need to manually edit `.env`.

**Important:** Use `AskUserQuestion` for every prompt. Validate inputs before proceeding. If a step fails, explain what went wrong and retry — never skip.

## Step 1: Anthropic API Key

1. Ask: "Enter your Anthropic API key (starts with `sk-ant-`):"
2. Validate by running:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" https://api.anthropic.com/v1/messages \
     -H "x-api-key: <KEY>" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
   ```
3. If status is 200 or 201, the key is valid. If 401, tell user the key is invalid and re-prompt. Other errors: show the status and re-prompt.
4. Save `ANTHROPIC_API_KEY=<KEY>` — write to `.env` (create if missing, append/replace if exists).

## Step 2: GitHub Token

1. Ask: "Enter a GitHub personal access token with `repo` scope. Create one at: https://github.com/settings/tokens/new?scopes=repo"
2. Save the token to `.env` as `GITHUB_TOKEN=<TOKEN>`
3. Validate by listing repos via the GitHub API (gh CLI is not available on the host — it's inside Docker):
   ```bash
   curl -s -H "Authorization: token <TOKEN>" "https://api.github.com/user/repos?per_page=50&sort=updated&type=owner"
   ```
4. If the response is a 401 or error, show it and re-prompt
5. Present a numbered list of repos. Ask: "Which repo should Danxbot connect to? Enter the number:"
6. Save `REPOS=<name>:<clone_url>` to `.env` where `<name>` is the repo's short name (after the `/`) and `<clone_url>` is `https://github.com/<nameWithOwner>.git`

## Step 3: Trello Credentials

1. Ask: "Enter your Trello API key. Get it from: https://trello.com/power-ups/admin — click on a Power-Up (or create one), then find the API key."
2. Construct the auth URL: `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<API_KEY>&name=Danxbot`
3. Ask: "Visit this URL to authorize Danxbot, then paste the token you receive:"
4. Validate both by running:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" "https://api.trello.com/1/members/me?key=<API_KEY>&token=<TOKEN>"
   ```
5. If 200, credentials are valid. Otherwise re-prompt.
6. Save `TRELLO_API_KEY` and `TRELLO_API_TOKEN` to `.env` (secrets — stay in danxbot)
7. **Hold the API key and token in memory** — they're needed for Step 4 and Step 4b.

## Step 4: Trello Board Setup

1. Fetch boards: `curl -s "https://api.trello.com/1/members/me/boards?fields=name,url&key=<KEY>&token=<TOKEN>"`
2. Present numbered list. Ask: "Which Trello board should Danxbot use?"
3. Save the board ID in memory (it goes to `trello.yml` in Step 8, NOT to `.env`)
4. Fetch the board's lists: `curl -s "https://api.trello.com/1/boards/<BOARD_ID>/lists?fields=name&key=<KEY>&token=<TOKEN>"`
5. Fetch the board's labels: `curl -s "https://api.trello.com/1/boards/<BOARD_ID>/labels?fields=name,color&key=<KEY>&token=<TOKEN>"`

**Expected lists:** Review, ToDo, In Progress, Needs Help, Done, Cancelled, Action Items

**Expected labels:** Bug, Feature, Epic, Needs Help, Triaged

6. Fuzzy-match existing lists to expected names (case-insensitive, ignore spaces/hyphens — "To Do" matches "ToDo", "to-do" matches "ToDo", etc.)
7. Present the mapping to the user:
   ```
   List mapping:
     Review      → "Review" (existing)
     ToDo        → "To Do" (existing)
     In Progress → (will create)
     ...
   ```
8. Ask: "Does this look right? (yes/no)" — if no, let user manually map each list
9. Create any missing lists via: `curl -s -X POST "https://api.trello.com/1/boards/<BOARD_ID>/lists?name=<NAME>&key=<KEY>&token=<TOKEN>"`
10. Create any missing labels via: `curl -s -X POST "https://api.trello.com/1/boards/<BOARD_ID>/labels?name=<NAME>&color=<COLOR>&key=<KEY>&token=<TOKEN>"`
    - Bug: red, Feature: green, Epic: purple, Needs Help: orange, Triaged: sky
11. **Hold all IDs in memory** — they go to `.danxbot/config/trello.yml` in Step 8, NOT to `.env`

## Step 4b: Configure Trello MCP Server

The Claude Code CLI uses an MCP (Model Context Protocol) server to interact with Trello. This must be configured in the project's settings so that `/danx-next`, `/danx-start`, and other skills can read/write Trello cards.

1. Read the existing `.mcp.json` in the project root (create if missing)
2. Add or update the `mcpServers.trello` section with the credentials from Step 3:
   ```json
   {
     "mcpServers": {
       "trello": {
         "command": "npx",
         "args": ["-y", "@anthropic-ai/trello-mcp-server@latest"],
         "env": {
           "TRELLO_API_KEY": "<API_KEY from Step 3>",
           "TRELLO_TOKEN": "<TOKEN from Step 3>"
         }
       }
     }
   }
   ```
3. **IMPORTANT:** The MCP server uses `TRELLO_TOKEN` (not `TRELLO_API_TOKEN`). Use the same token value from Step 3.
4. Merge with existing servers — preserve any other MCP server entries.
5. Write the merged result back to `.mcp.json`.
6. Ensure `.mcp.json` is in `.gitignore` (it contains credentials).

## Step 5: Slack Setup (Optional)

1. Ask: "Do you want to connect Slack? (yes/no)"
2. **If no:** Write empty values to `.env` (`SLACK_BOT_TOKEN=`, `SLACK_APP_TOKEN=`, `SLACK_CHANNEL_ID=`) and skip to Step 7.
3. **If yes:**
   - Ask for `SLACK_BOT_TOKEN` (starts with `xoxb-`)
   - Ask for `SLACK_APP_TOKEN` (starts with `xapp-`)
   - Ask for `SLACK_CHANNEL_ID` (starts with `C`)
   - Save all three to `.env`

## Step 6: Claude Code Auth

The bot runs inside Docker and needs Claude Code CLI credentials to make agent calls (subscription-based, separate from the API key). The worker bind-mounts the host's `~/.claude.json` and `~/.claude/` directly so token rotation on the host is live inside the container — no snapshot, no copy. Full rationale lives next to the mounts in `.danxbot/config/compose.yml`.

1. Ask: "Where is your Claude Code config? Typically `~/.claude.json` — enter the full path (or press enter for default):"
2. Resolve the path. If default, use `~/.claude.json`. Capture as `CLAUDE_CONFIG_FILE_PATH`.
3. Resolve the credentials directory: the directory CONTAINING `.credentials.json`, typically `~/.claude`. Capture as `CLAUDE_CREDS_DIR_PATH`. Verify `<dir>/.credentials.json` exists. If not, tell the user to run `claude` on the host first to authenticate, then retry.
4. Write to `.env`:
   ```
   CLAUDE_CONFIG_FILE=<absolute path from step 2>
   CLAUDE_CREDS_DIR=<absolute path from step 3>
   ```
5. Confirm: "Worker container will bind-mount your live `~/.claude.json` and `~/.claude/` directly — no snapshot, no copy, host rotation visible immediately."

**Note:** These are OAuth tokens, not API keys. The container needs read-write access to both bind sources so claude can rotate the token and update session state — leaving them read-only causes `claude -p` to silently exit (Trello 0bjFD0a2, PHevzRil). UIDs are pre-aligned in the Dockerfile (`danxbot` = UID 1000) so writes propagate to the host file with the host user's ownership intact. Do NOT regress to a `cp` snapshot pattern; the snapshot goes stale within ~24 hours and every dispatch starts hanging or silently exiting.

**Fallback (rare — ASK the user before using):** If `~/.claude/` cannot be bound directly (locked-down environments where the host home dir isn't accessible to Docker), ask: "Live host bind isn't possible here. Use a snapshot under `claude-auth/.claude/` instead? You'll need to re-run setup after every Claude token rotation." Only proceed with the snapshot pattern on explicit "yes" — this is the production-deploy shape; `deploy/workers.ts` injects absolute provisioned paths automatically.

## Step 7: Link and Explore Repo

1. Create the `repos/` directory if it doesn't exist
2. **Check if the repo already exists locally** (e.g., at `../<name>/` or another common location). Ask the user: "Do you have a local checkout of this repo? If so, what's the path?"
   - **If local checkout exists:** Create a symlink: `ln -s /absolute/path/to/repo repos/<name>`
   - **If no local checkout:** Clone using the GitHub token: `git clone https://<GITHUB_TOKEN>@github.com/<nameWithOwner>.git repos/<name>`
   - **NEVER delete `repos/<name>/` if it already exists.** If it's a stale clone or wrong symlink, ask the user how to handle it.
3. Explore the repo deeply — read these files if they exist:
   - `README.md` or `README`
   - `package.json`, `composer.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `Gemfile`
   - `docker-compose.yml`, `docker-compose.yaml`, `Dockerfile`
   - `.github/workflows/*.yml` (CI config)
   - `Makefile`, `justfile`
   - Test config files: `vitest.config.*`, `jest.config.*`, `phpunit.xml`, `pytest.ini`
   - Lint config: `.eslintrc*`, `phpstan.neon`, `.prettierrc*`, `pint.json`
4. Detect:
   - **Language/framework**: PHP+Laravel (composer.json with laravel), Node+Express/Vite, Go, Rust, Python+Django/Flask, Ruby+Rails
   - **Test command**: `php artisan test`, `npm test`, `go test ./...`, `cargo test`, `pytest`
   - **Lint command**: based on config files found
   - **Type check**: `npx tsc --noEmit`, `phpstan`, `mypy`
   - **Dev server**: from package.json scripts or docker-compose
   - **Docker setup**: compose file path, main service name
5. Present findings to the user:
   ```
   Detected: PHP/Laravel project
   - Test command: php artisan test
   - Lint: ./vendor/bin/pint --test
   - Docker: docker-compose.yml (service: laravel.test)
   - Source: app/, resources/
   - Tests: tests/
   ```
6. Ask: "Is this correct? Anything to change?"
7. Apply any corrections the user provides.
8. Ask: "How should Danxbot handle completed work in this repo?"
   - **Auto-merge** (recommended for personal/small team repos): Work is done on a feature branch, automatically merged into main, and the branch is cleaned up. No PR review step.
   - **Pull Request**: Work is done on a feature branch and a PR is created for human review before merging.
9. Save the choice as `git_mode: auto-merge` or `git_mode: pr` in the config.

## Step 8: Generate Config in Connected Repo

**All repo-specific config lives in `.danxbot/config/` inside the connected repo.** This directory is version controlled (committed to the connected repo). The poller syncs files from `.danxbot/config/` to their target locations (`.claude/rules/`, `docs/`, `repo-overrides/`) before each Claude spawn.

Create the directory: `mkdir -p repos/<name>/.danxbot/config/docs/domains repos/<name>/.danxbot/config/docs/schema`

### 8a: Write `.danxbot/config/config.yml`

Write `repos/<name>/.danxbot/config/config.yml` with the discovered config:

```yaml
name: <repo-name>
url: <clone-url>
runtime: docker  # or "local"
language: php    # or node, go, python, ruby, rust
framework: laravel  # or express, vue, django, rails, etc.
git_mode: auto-merge  # or "pr"

commands:
  test: "php artisan test"
  lint: "./vendor/bin/pint --test"
  type_check: ""  # empty if none
  dev: "php artisan serve"

docker:
  compose_file: "<repo-name>-compose.yml"
  service_name: "laravel.test"
  project_name: "danxbot-<repo-name>"

paths:
  source: "app/"
  tests: "tests/"
```

Adjust the structure based on what was actually detected. If no Docker setup, omit the `docker` section and set `runtime: local`.

### 8b: Write `.danxbot/config/trello.yml`

Write all Trello IDs collected in Step 4 to `repos/<name>/.danxbot/config/trello.yml`:

```yaml
board_id: <BOARD_ID>

lists:
  review: <REVIEW_LIST_ID>
  todo: <TODO_LIST_ID>
  in_progress: <IN_PROGRESS_LIST_ID>
  needs_help: <NEEDS_HELP_LIST_ID>
  done: <DONE_LIST_ID>
  cancelled: <CANCELLED_LIST_ID>
  action_items: <ACTION_ITEMS_LIST_ID>

labels:
  bug: <BUG_LABEL_ID>
  feature: <FEATURE_LABEL_ID>
  epic: <EPIC_LABEL_ID>
  needs_help: <NEEDS_HELP_LABEL_ID>
  triaged: <TRIAGED_LABEL_ID>
```

**These IDs are NOT secrets** — they're safe to commit to version control.

### 8c: Generate Docker Compose Override (if runtime is `docker`)

If the repo uses Docker (has a docker-compose.yml or Dockerfile), generate an isolated compose override at `repos/<name>/.danxbot/config/compose.yml`. This file runs the repo's own Docker stack with an isolated project name and network, so it doesn't conflict with the host's setup.

**Key principles:**
- Use the repo's own Docker images (build from its Dockerfile or reference its images)
- Mount `/danxbot/repos` so code is accessible
- Set `working_dir` to `/danxbot/repos/<name>/<subdir>` (where the main app lives)
- Use isolated ports (offset from standard: 13306 for MySQL, 16379 for Redis, etc.)
- Use an isolated bridge network named `sail` within the compose project
- Set environment to `testing` mode for running tests

**For Laravel/Sail projects**, the compose override should include:
- `laravel.test` service built from the repo's own `docker/<php-version>/Dockerfile`
- `mysql` and `redis` services for testing
- Environment variables for testing (DB_CONNECTION, CACHE_DRIVER=array, QUEUE_CONNECTION=sync)

**For Node.js projects**, the compose override is usually unnecessary — tests run directly via `docker exec danxbot`.

**For other frameworks**, adapt based on what the repo's own docker-compose.yml defines.

### 8d: Generate Env File (if Docker runtime, secrets only)

If the repo's Docker stack needs environment variables with secrets (DB passwords, API keys), write them to `repo-overrides/<name>.env` in danxbot (NOT in `.danxbot/config/` — secrets stay local):

```bash
mkdir -p repo-overrides
```

This keeps repo-specific secrets separate from both danxbot's `.env` and the version-controlled `.danxbot/config/`.

### 8f: Create `.danxbot/.gitignore`

Write `repos/<name>/.danxbot/.gitignore` to exclude generated and
runtime files — `features.md` (ideator memory), `.env` (secrets),
`settings.json` (operational state — feature toggles + masked config),
`.settings.lock` (per-file lock), and `issues/` (per-issue YAML
lifecycle dir, Phase 2 of tracker-agnostic-agents):

```
features.md
.env
settings.json
.settings.lock
issues/
```

The poller idempotently re-adds the `issues/` line on every tick
(`ensureGitignoreEntry`) so connected repos that pre-date this line pick
it up without a re-install.

## Step 9: Generate Rules (in `.danxbot/config/`)

All generated rules go into `repos/<name>/.danxbot/config/`. The poller's sync function distributes them to their target locations before each Claude spawn.

### `.danxbot/config/overview.md`

Generate an overview of the connected repo based on what was discovered in Step 7. This file gives the orchestrator agent context about the repo's architecture so it can work on cards effectively. Include:

- **Tech stack** — languages, frameworks, database, cache, infrastructure
- **Repository structure** — key directories and what they contain
- **Key model/entity relationships** — if a database-backed app, list the primary entities and their relationships
- **Database conventions** — naming patterns, primary keys, timestamps, soft deletes (if applicable)
- **Common patterns** — architectural patterns the codebase uses (e.g., Inertia.js, FilterBuilder, ActiveRecord, middleware patterns)

Base this entirely on what you read from the repo's source code, README, and config files. Do NOT guess — only include what you can verify from the codebase.

Synced by poller to: `.claude/rules/repo-overview.md`

### `.danxbot/config/workflow.md`

Generate a workflow rule tailored to the detected repo. Include:
- How to edit files (path prefix: `repos/<name>/`)
- How to run tests (via docker exec if Docker, direct if local)
- How to run lint/type-check
- Git workflow based on `git_mode` from Step 7:
  - **`auto-merge`**: feature branches, commit, push, merge into main, delete branch
  - **`pr`**: feature branches, commit, push, create PR via `gh pr create`, return to main
- Commit format

Use the existing `.claude/rules/repo-workflow.md` as a template for the structure — it has generic `<name>` placeholders. Fill in the actual repo name, commands, Docker details, and git mode.

Synced by poller to: `.claude/rules/repo-workflow.md`

### `.danxbot/config/docs/schema/` and `.danxbot/config/docs/domains/` (if database is configured)

If the connected repo has a database, generate domain documentation:

**`.danxbot/config/docs/schema/model-relationships.md`** — A relationship map showing how the key database tables connect via foreign keys. Base this on:
- Reading model files (Eloquent relationships, ActiveRecord associations, etc.)
- Running DESCRIBE on key tables
- Tracing foreign key relationships

**`.danxbot/config/docs/domains/*.md`** — One file per major domain area (e.g., `users.md`, `billing.md`). Each should contain:
- What the domain covers
- Key models/tables involved
- Important relationships and workflows
- Common query patterns

Base these entirely on what you discover from the codebase and database. The ideator agent will expand these over time.

If no database is configured, create placeholder files noting that database docs will be populated when a DB connection is added.

Synced by poller to: `docs/domains/` and `docs/schema/`

### CRITICAL: Do NOT manually sync to danxbot's `.claude/` directory

**Never create, copy, or write files in danxbot's `.claude/rules/`, `docs/`, or `repo-overrides/` directories during setup.** The poller (`src/poller/index.ts:syncRepoFiles()`) handles all syncing automatically:

- `.danxbot/config/config.yml` → generates `.claude/rules/repo-config.md`
- `.danxbot/config/trello.yml` → generates `.claude/rules/trello-config.md`
- `.danxbot/config/overview.md` → copies to `.claude/rules/repo-overview.md`
- `.danxbot/config/workflow.md` → copies to `.claude/rules/repo-workflow.md`
- `.danxbot/config/compose.yml` → copies to `repo-overrides/<name>-compose.yml`
- `.danxbot/config/docs/` → copies to `docs/domains/` and `docs/schema/`

All of these target paths are gitignored in danxbot. They are generated artifacts, not source files. The poller syncs them before each Claude spawn.

**Also do NOT edit danxbot's `CLAUDE.md`.** It describes danxbot itself and is committed to git. Connected repo information reaches the agent via the synced rule files above.

The setup's only job is to write source-of-truth files into `.danxbot/config/` inside the connected repo. The poller takes care of the rest when it starts.

## Step 10: Finalize `.env`

Ensure `.env` has all values. Add defaults for anything not yet set:

```
# Danxbot Database (host/port derived from runtime — auto-detected via /.dockerenv)
DANXBOT_DB_USER=danxbot
DANXBOT_DB_PASSWORD=danxbot
DANXBOT_DB_NAME=danxbot_chat

# Git identity for commits
DANXBOT_GIT_EMAIL=danxbot@example.com

# Poller
POLLER_INTERVAL_MS=60000
TRELLO_REVIEW_MIN_CARDS=10
```

**Note:** Trello IDs are NOT in `.env` — they live in `.danxbot/config/trello.yml` in the connected repo.

### Docker Network

The danxbot worker container must join the connected repo's Docker network so it can communicate with the repo's services (database, web server, etc.). This is configured in the per-repo `compose.yml`, not in `.env`.

1. Detect the connected repo's Docker network by running: `docker network ls --format '{{.Name}}' | grep -i <repo-name>`
2. If not found (repo's Docker stack isn't running), ask: "What is the Docker network name for the connected repo? (e.g., `<repo-name>_sail`)"
3. Add the network to the repo's `.danxbot/config/compose.yml` under `networks:` as an external network

### Platform Database

If the repo has a database that the agent should query (read-only), ask:
- "Does the connected repo have a database the agent should have read access to? (yes/no)"
- If yes, collect host, user, password, database name and write as `DANX_DB_HOST`, `DANX_DB_USER`, `DANX_DB_PASSWORD`, `DANX_DB_NAME` in `<repo>/.danxbot/.env` (optionally `DANX_DB_PORT`, default 3306)
- **Important:** Write the docker service name (e.g., `<repo-name>-mysql-1`). On host, the worker translates that to `127.0.0.1` automatically — in Docker it resolves via the shared network. One value works in both runtimes.
- If no, leave these empty (the agent won't have SQL query capability)

### Remote Agent Dispatch (MCP Server)

Check if the connected repo has an MCP server by looking for `mcp-server/` directory in the repo root.

**If an MCP server exists:**

1. Tell the user: "This repo has an MCP server published as an npm package. This enables remote agent dispatch — the repo can launch Claude agents via danxbot's HTTP API."
2. The MCP server is resolved at dispatch time by the workspace `.mcp.json` via `npx -y <package-name>` from the workspace cwd. No `npm install` step is required in danxbot — the npm registry is the single source of truth.
3. Set these in `.env`:
   ```
   # Dispatch — remote agent launch via HTTP
   DEFAULT_API_URL=http://<repo-web-container>:<port>
   DISPATCH_AGENT_TIMEOUT=600
   ```
4. `DEFAULT_API_URL` is the URL the MCP server uses to reach the connected repo's web server from inside Docker. Ask: "What is the connected repo's web server URL on the Docker network?" (e.g., `http://laravel.test:80` for Sail projects)
5. Ask: "What timeout (in seconds) for agent dispatch runs? Default is 600 (10 minutes):"

**If no MCP server exists:** Skip this section.

### Update Connected Repo's `.env`

The connected repo needs to know how to reach danxbot for dispatching agents:

1. Ask: "Should I update the connected repo's `.env` with the danxbot URL? (yes/no)"
2. If yes, add to the connected repo's `.env`:
   ```
   DANXBOT_GPT_MANAGER_URL=http://danxbot:<DASHBOARD_PORT>
   ```
   Where `danxbot` is the container hostname on the shared Docker network and `<DASHBOARD_PORT>` is the port from this danxbot instance's `.env`

### Final Confirmation

Read back the final `.env` (masking secrets) and present to user for confirmation.

## Step 11: Smoke Test

1. Start danxbot: `docker compose up -d --build`
2. Wait 10 seconds for startup
3. Check health: `curl -s localhost:$DASHBOARD_PORT/health` (read `DASHBOARD_PORT` from `.env`)
4. If healthy, report success
5. If unhealthy, check `docker compose logs danxbot --tail 30` and troubleshoot
6. Verify the poller can validate config: `docker compose exec danxbot npx tsx src/poller/validate.ts` (or check logs for "Repo config validated successfully")
7. **Proof of life:** Inside the danxbot container (which has `git` and `gh`), create a feature branch in the connected repo, add a "## Danxbot" section to the repo's README (describing what Danxbot does for this repo), commit, push, and open a PR:
   ```bash
   docker compose exec -u danxbot danxbot bash -c 'cd /danxbot/repos/<name> && git checkout -b danxbot/proof-of-life && ...'
   docker compose exec -u danxbot danxbot gh pr create --repo <owner>/<name> --title "..." --body "..."
   ```
   **Note:** `gh` and `git` are available inside the container, NOT on the host.
8. Report the PR URL to the user

## Step 12: Finish

Present the results clearly:

1. Summarize what was set up:
   - Connected repo name and tech stack
   - Trello board with lists/labels
   - Slack (enabled/disabled)
   - Dashboard URL: **http://localhost:$DASHBOARD_PORT**

2. **How to start the autonomous agent:**
   ```
   docker compose up -d    # Start the bot (if not already running)
   npm run poller           # Start the card processor (polls Trello, spawns Claude)
   ```

3. **Interactive commands** (run from the target repo directory with `claude`):
   - `/danx-next` — Process the top ToDo card
   - `/danx-start` — Process all ToDo cards
   - `/danx-ideate` — Explore the repo and generate feature cards
   - `/danx-triage` — Audit + classify + reorder Trello cards by priority

   These are wired by `install.sh` as gitignored symlinks at `<repo>/.claude/skills/danx-*` pointing into the danxbot inject pipeline. Connected-repo symlinks resolve once the poller has ticked at least once for that repo.

4. **Adding work:**
   - Add cards to the Trello board's **ToDo** list with descriptions
   - The poller picks them up automatically, or use `/danx-next` manually
   - If Slack is enabled: mention @Danxbot in the configured channel for questions

5. Ask: "Any questions before we dive in?"

## Helper: `.env` Management

When writing to `.env`:
1. Read the existing file (or start empty)
2. For each key=value: if the key already exists, replace the line. If not, append.
3. Write the full file back.
4. Never duplicate keys.

Use this bash pattern for safe `.env` updates:
```bash
# Set a single key in .env
set_env() {
  local key="$1" value="$2" file=".env"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}
```
