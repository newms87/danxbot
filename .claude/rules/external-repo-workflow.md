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

If the card targets the platform, all implementation work happens on the shared volume at `/flytebot/repos/platform`.

## File Editing

Edit files directly inside the flytebot container using the standard Edit/Write tools. The shared volume at `/flytebot/repos/platform` is mounted in both the main flytebot container and the sibling containers.

## Running Platform Commands

Platform commands (PHP, artisan, composer, tests) run in the sibling container:

```bash
docker compose -f /flytebot/app/docker-compose.yml run --rm platform <command>
```

### Run Tests

```bash
docker compose -f /flytebot/app/docker-compose.yml run --rm platform php artisan test
```

For targeted tests:
```bash
docker compose -f /flytebot/app/docker-compose.yml run --rm platform php artisan test --filter=TestClassName
```

## Git Workflow

Git and gh commands run inside the **main flytebot container** (it has git + gh CLI):

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
docker exec -u flytebot flytebot gh pr create \
  --repo Flytedesk/platform \
  --base main \
  --title "<PR title>" \
  --body "<PR description>"
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
- The repo remote uses HTTPS via `GITHUB_TOKEN` for auth (configured automatically by `gh`)
