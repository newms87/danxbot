# Platform Repo Workflow

When a Trello card involves changes to the **platform repo** (Laravel backend, Vue frontend, database migrations, etc.), the orchestrator follows this workflow instead of the standard flytebot commit flow.

## Detecting Platform Cards

A card targets the platform repo when its description mentions:
- Platform models, controllers, services, jobs, or migrations
- Vue components/pages in `mva/`
- Laravel routes, middleware, or config
- Database schema changes
- The `ssap/` or `mva/` directories
- Media kit, ad shop, digital module, or other platform features

If the card targets the platform, all implementation work happens inside the Docker container at `/flytebot/platform`.

## Git Workflow

All git and gh commands run inside the Docker container via `docker exec -u flytebot flytebot <command>`.

### 1. Create a Feature Branch

```bash
docker exec -u flytebot flytebot git -C /flytebot/platform checkout -b flytebot/<short-branch-name>
```

Branch naming: `flytebot/<kebab-case-description>` (e.g., `flytebot/update-media-kit-script-tag`).

### 2. Implement Changes

Edit files on the host at `/home/newms/web/platform/` using the standard Edit/Write tools. Changes are immediately visible inside the container via the volume mount.

### 3. Run Platform Tests

```bash
docker exec -u flytebot flytebot bash -c "cd /flytebot/platform/ssap && php artisan test"
```

For targeted tests:
```bash
docker exec -u flytebot flytebot bash -c "cd /flytebot/platform/ssap && php artisan test --filter=TestClassName"
```

### 4. Commit and Push

```bash
docker exec -u flytebot flytebot bash -c "cd /flytebot/platform && git add <files> && git commit -m '<message>'"
docker exec -u flytebot flytebot git -C /flytebot/platform push -u origin flytebot/<branch-name>
```

### 5. Create a Pull Request

```bash
docker exec -u flytebot flytebot gh pr create \
  --repo Flytedesk/platform \
  --base main \
  --title "<PR title>" \
  --body "<PR description>"
```

### 6. Return to Main

After the PR is created (or if any step fails), always switch back to main:
```bash
docker exec -u flytebot flytebot git -C /flytebot/platform checkout main
```

Always return to main before completing or moving the card to Needs Help. This prevents the platform repo from being left on a stale feature branch for the next card.

## Commit Message Format

Platform commits follow the same format as flytebot commits:

```
[Card Name] Short description

Body explaining what changed and why.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Important Notes

- **NEVER force-push** to the platform repo
- **NEVER commit to main** — always use a feature branch
- **Always run tests** before pushing
- The platform repo remote uses HTTPS via `GITHUB_TOKEN` for auth (configured automatically by `gh`)
