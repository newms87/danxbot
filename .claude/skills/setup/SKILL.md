---
name: setup
description: Interactive installer — guides user through credentials, Trello, repo connection, and rules generation.
---

# Flytebot Setup

You are the interactive setup wizard for Flytebot. Guide the user through each step below, collecting credentials and configuring everything. The user should never need to manually edit `.env`.

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
3. Run: `echo "<TOKEN>" | gh auth login --with-token 2>&1` to authenticate the gh CLI
4. If auth fails, show the error and re-prompt
5. Run: `gh repo list --json nameWithOwner,description --limit 50`
6. Present a numbered list of repos. Ask: "Which repo should Flytebot connect to? Enter the number:"
7. Save `REPOS=<name>:<clone_url>` to `.env` where `<name>` is the repo's short name (after the `/`) and `<clone_url>` is `https://github.com/<nameWithOwner>.git`

## Step 3: Trello Credentials

1. Ask: "Enter your Trello API key. Get it from: https://trello.com/power-ups/admin — click on a Power-Up (or create one), then find the API key."
2. Construct the auth URL: `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<API_KEY>&name=Flytebot`
3. Ask: "Visit this URL to authorize Flytebot, then paste the token you receive:"
4. Validate both by running:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" "https://api.trello.com/1/members/me?key=<API_KEY>&token=<TOKEN>"
   ```
5. If 200, credentials are valid. Otherwise re-prompt.
6. Save `TRELLO_API_KEY` and `TRELLO_API_TOKEN` to `.env`

## Step 4: Trello Board Setup

1. Fetch boards: `curl -s "https://api.trello.com/1/members/me/boards?fields=name,url&key=<KEY>&token=<TOKEN>"`
2. Present numbered list. Ask: "Which Trello board should Flytebot use?"
3. Save `TRELLO_BOARD_ID=<id>` to `.env`
4. Fetch the board's lists: `curl -s "https://api.trello.com/1/boards/<BOARD_ID>/lists?fields=name&key=<KEY>&token=<TOKEN>"`
5. Fetch the board's labels: `curl -s "https://api.trello.com/1/boards/<BOARD_ID>/labels?fields=name,color&key=<KEY>&token=<TOKEN>"`

**Expected lists:** Review, ToDo, In Progress, Needs Help, Done, Cancelled, Action Items

**Expected labels:** Bug, Feature, Epic, Needs Help

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
    - Bug: red, Feature: green, Epic: purple, Needs Help: orange
11. Save all IDs to `.env`:
    - `TRELLO_REVIEW_LIST_ID`, `TRELLO_TODO_LIST_ID`, `TRELLO_IN_PROGRESS_LIST_ID`, `TRELLO_NEEDS_HELP_LIST_ID`, `TRELLO_DONE_LIST_ID`, `TRELLO_CANCELLED_LIST_ID`, `TRELLO_ACTION_ITEMS_LIST_ID`
    - `TRELLO_BUG_LABEL_ID`, `TRELLO_FEATURE_LABEL_ID`, `TRELLO_EPIC_LABEL_ID`, `TRELLO_NEEDS_HELP_LABEL_ID`

## Step 5: Slack Setup (Optional)

1. Ask: "Do you want to connect Slack? (yes/no)"
2. **If no:** Write empty values to `.env` (`SLACK_BOT_TOKEN=`, `SLACK_APP_TOKEN=`, `SLACK_CHANNEL_ID=`) and skip to Step 6.
3. **If yes:**
   - Ask for `SLACK_BOT_TOKEN` (starts with `xoxb-`)
   - Ask for `SLACK_APP_TOKEN` (starts with `xapp-`)
   - Ask for `SLACK_CHANNEL_ID` (starts with `C`)
   - Save all three to `.env`

## Step 6: Clone and Explore Repo

1. Create the `repos/` directory if it doesn't exist
2. Clone the repo: `gh repo clone <nameWithOwner> repos/<name>`
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

## Step 7: Generate `repo-config.yml` and Docker Overrides

### 7a: Write `repo-config.yml`

Write `repo-config.yml` at project root with the discovered config:

```yaml
name: <repo-name>
url: <clone-url>
runtime: docker  # or "local"
language: php    # or node, go, python, ruby, rust
framework: laravel  # or express, vue, django, rails, etc.

commands:
  test: "php artisan test"
  lint: "./vendor/bin/pint --test"
  type_check: ""  # empty if none
  dev: "php artisan serve"

docker:
  compose_file: "<repo-name>-compose.yml"
  service_name: "laravel.test"
  project_name: "flytebot-<repo-name>"

paths:
  source: "app/"
  tests: "tests/"
```

Adjust the structure based on what was actually detected. If no Docker setup, omit the `docker` section and set `runtime: local`.

### 7b: Generate Docker Compose Override (if runtime is `docker`)

If the repo uses Docker (has a docker-compose.yml or Dockerfile), generate an isolated compose override at `repo-overrides/<name>-compose.yml`. This file runs the repo's own Docker stack with an isolated project name and network, so it doesn't conflict with the host's setup.

**Key principles:**
- Use the repo's own Docker images (build from its Dockerfile or reference its images)
- Mount `/flytebot/repos` so code is accessible
- Set `working_dir` to `/flytebot/repos/<name>/<subdir>` (where the main app lives)
- Use isolated ports (offset from standard: 13306 for MySQL, 16379 for Redis, etc.)
- Use an isolated bridge network named `sail` within the compose project
- Set environment to `testing` mode for running tests

**For Laravel/Sail projects**, the compose override should include:
- `laravel.test` service built from the repo's own `docker/<php-version>/Dockerfile`
- `mysql` and `redis` services for testing
- Environment variables for testing (DB_CONNECTION, CACHE_DRIVER=array, QUEUE_CONNECTION=sync)

**For Node.js projects**, the compose override is usually unnecessary — tests run directly via `docker exec flytebot`.

**For other frameworks**, adapt based on what the repo's own docker-compose.yml defines.

### 7c: Generate Post-Clone Hook (if needed)

If the repo needs setup after cloning (auth files, dependency install, config copy), create `repo-overrides/post-clone-<name>.sh`:

```bash
#!/bin/bash
REPOS_DIR="$1"
REPO="$REPOS_DIR/<name>"

# Example: copy auth credentials for private package registries
if [ -f "/flytebot/app/repo-overrides/<name>-auth.json" ] && [ -d "$REPO/<subdir>" ]; then
    cp "/flytebot/app/repo-overrides/<name>-auth.json" "$REPO/<subdir>/auth.json"
fi
```

Ask the user: "Does this repo require any auth files or credentials for package installation (e.g., Composer auth for private packages, npm tokens)?" If yes, collect the credentials and write them to `repo-overrides/`.

### 7d: Generate Env File (if Docker runtime)

If the repo's Docker stack needs environment variables, write them to `repo-overrides/<name>.env`. This keeps repo-specific env vars separate from flytebot's `.env`.

## Step 8: Generate Rules

### `.claude/rules/repo-workflow.md`

Generate a workflow rule tailored to the detected repo. Include:
- How to edit files (path prefix: `repos/<name>/`)
- How to run tests (via docker exec if Docker, direct if local)
- How to run lint/type-check
- Git workflow: feature branches (`flytebot/<kebab-case>`), commit format, PR creation via `gh`
- Always return to main after PR creation

Use `.claude/rules/repo-workflow.md` (already in the repo) as the template. It uses generic `<name>` placeholders — the generated version should fill in the actual repo name, commands, and Docker details.

### `.claude/rules/repo-config.md`

Generate the config rule (same format as `trello-config.md` — auto-generated, machine-readable) with:
- Repo name, URL, local path
- All detected commands
- Docker config (if applicable)
- Source and test paths

### Update `CLAUDE.md`

Add a section about the connected repo under "## Connected Repo" with:
- Repo name and what it is (based on README)
- Tech stack detected
- Key commands

## Step 9: Finalize `.env`

Ensure `.env` has all values. Add defaults for anything not yet set:

```
# Flytebot Database
FLYTEBOT_DB_HOST=flytebot-mysql
FLYTEBOT_DB_USER=flytebot
FLYTEBOT_DB_PASSWORD=flytebot
FLYTEBOT_DB_NAME=flytebot_chat

# Claude auth directories (for Docker volume mounts)
CLAUDE_AUTH_DIR=<user's ~/.claude directory>
CLAUDE_AUTH_HOME=<user's home directory>

# Poller
POLLER_INTERVAL_MS=60000
TRELLO_REVIEW_MIN_CARDS=10
```

Ask the user: "Where is your Claude config directory? (usually `~/.claude`)" and "What is your home directory? (usually `~`)" — resolve to absolute paths and write as `CLAUDE_AUTH_DIR` and `CLAUDE_AUTH_HOME`.

If the repo has a database that the agent should query (read-only), ask:
- "Does the connected repo have a database the agent should have read access to? (yes/no)"
- If yes, collect host, user, password, database name and write as `PLATFORM_DB_HOST`, `PLATFORM_DB_USER`, `PLATFORM_DB_PASSWORD`, `PLATFORM_DB_NAME`
- If no, leave these empty (the agent won't have SQL query capability)

Read back the final `.env` (masking secrets) and present to user for confirmation.

## Step 10: Smoke Test

1. Start flytebot: `docker compose up -d --build`
2. Wait 10 seconds for startup
3. Check health: `curl -s localhost:5555/health`
4. If healthy, report success
5. If unhealthy, check `docker logs flytebot --tail 30` and troubleshoot
6. Run the repo's test suite (if Docker is configured) to verify the repo setup works
7. Create a feature branch in the repo, add a "## Flytebot" section to the repo's README (describing what Flytebot does for this repo), commit, push, and open a PR as proof of life
8. Report the PR URL to the user

## Step 11: Finish

1. Ask if the user has any questions or corrections
2. Summarize what was set up:
   - Connected repo
   - Trello board with lists/labels
   - Slack (enabled/disabled)
   - Dashboard URL (localhost:5555)
3. Provide next steps:
   - `npm run poller` — start the autonomous card processor
   - Add cards to the Trello board's ToDo list
   - View the dashboard at localhost:5555
   - If Slack is enabled: mention @Flytebot in the configured channel

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
