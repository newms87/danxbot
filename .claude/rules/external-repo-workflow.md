# External Repo Workflow

When a Trello card involves changes to an **external repo** (e.g., the platform — Laravel backend, Vue frontend, database migrations, etc.), the orchestrator follows this workflow instead of the standard flytebot commit flow.

## Detecting External Repo Cards

A card targets the platform repo when its description mentions:
- Platform models, controllers, services, jobs, or migrations
- Vue components/pages in `mva/`
- Laravel routes, middleware, or config
- Database schema changes
- The `ssap/` or `mva/` directories
- Media kit, ad shop, digital module, or other platform features

## File Editing

Edit files directly on the host using the standard Read/Edit/Write tools. The platform repo is at `repos/platform/` (relative to the flytebot project root). For example:
- Laravel code: `repos/platform/ssap/app/...`
- Vue frontend: `repos/platform/mva/src/...`
- Migrations: `repos/platform/ssap/database/migrations/...`

This directory is bind-mounted into both the flytebot container and all platform containers at `/flytebot/repos/platform`, so edits on the host are immediately visible everywhere.

## Running Platform Commands

Platform commands (PHP, artisan, tests) run via docker exec through the flytebot container:

```bash
docker exec flytebot docker compose -p flytebot-platform \
  -f /flytebot/app/platform-compose.override.yml \
  run --rm laravel.test <command>
```

### Ensure services are running

Before running any platform command, make sure mysql and redis are up:

```bash
docker exec flytebot docker compose -p flytebot-platform \
  -f /flytebot/app/platform-compose.override.yml \
  up -d mysql redis
```

### Run Tests

```bash
docker exec flytebot docker compose -p flytebot-platform \
  -f /flytebot/app/platform-compose.override.yml \
  run --rm laravel.test php artisan test
```

For targeted tests:
```bash
docker exec flytebot docker compose -p flytebot-platform \
  -f /flytebot/app/platform-compose.override.yml \
  run --rm laravel.test php artisan test --filter=TestClassName
```

## Git Workflow

Git and gh commands run inside the **flytebot container** (which has git + gh CLI configured with auth):

### 1. Create a Feature Branch

```bash
docker exec -u flytebot flytebot git -C /flytebot/repos/platform checkout -b flytebot/<short-branch-name>
```

Branch naming: `flytebot/<kebab-case-description>` (e.g., `flytebot/update-media-kit-script-tag`).

### 2. Commit and Push

```bash
docker exec -u flytebot flytebot bash -c "cd /flytebot/repos/platform && git add <files> && git commit -m '<message>'"
docker exec -u flytebot flytebot git -C /flytebot/repos/platform push -u origin flytebot/<branch-name>
```

### 3. Create a Pull Request

```bash
docker exec -u flytebot flytebot bash -c "cd /flytebot/repos/platform && gh pr create \
  --base main \
  --title '<PR title>' \
  --body '<PR description>'"
```

### 4. Return to Main

After the PR is created (or if any step fails), always switch back to main:
```bash
docker exec -u flytebot flytebot git -C /flytebot/repos/platform checkout main
```

Always return to main before completing or moving the card to Needs Help. This prevents the repo from being left on a stale feature branch for the next card.

## Commit Message Format

Platform commits follow the same format as flytebot commits:

```
[Card Name] Short description

Body explaining what changed and why.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Important Notes

- **NEVER force-push** to external repos
- **NEVER commit to main** — always use a feature branch
- **Always run tests** before pushing
- The repo remote uses HTTPS via `GITHUB_TOKEN` for auth (configured automatically in the entrypoint)
- The platform containers are fully isolated: own network (`flytebot-platform_sail`), own MySQL (port 13306), own Redis (port 16379)
