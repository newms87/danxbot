# Connected Repo Workflow

When a Trello card involves changes to the **connected repo** (configured in `repo-config.yml`), the orchestrator follows this workflow instead of the standard flytebot commit flow.

## Repo Config

All repo details (name, commands, Docker config, paths) are in `.claude/rules/repo-config.md` (auto-generated from `repo-config.yml` by the poller). Read that file for exact commands — never hardcode repo-specific values.

## Detecting Connected Repo Cards

A card targets the connected repo when its description references that repo's domain, framework, models, components, or directories. Read `.claude/rules/repo-config.md` for the repo name and paths.

## File Editing

Edit files directly using the standard Read/Edit/Write tools. The repo is at `repos/<name>/` (relative to the flytebot project root).

This directory is bind-mounted into the flytebot container at `/flytebot/repos/<name>`, so edits on the host are immediately visible inside the container.

## Running Repo Commands

Read the exact commands from `.claude/rules/repo-config.md`. The config specifies how to run tests, lint, and type-check.

**If runtime is `docker`:** Commands run via docker exec through the flytebot container:

```bash
docker exec flytebot docker compose -p <project_name> \
  -f /flytebot/app/<compose_override> \
  run --rm <service_name> <command>
```

**If runtime is `local`:** Commands run directly from the repo directory:

```bash
cd repos/<name> && <command>
```

### Ensure services are running (Docker runtime only)

Before running any repo command with Docker runtime, ensure dependent services are up. Check the repo's docker-compose file for required services.

## Git Workflow

Git and gh commands run inside the **flytebot container** (which has git + gh CLI configured with auth):

### 1. Create a Feature Branch

```bash
docker exec -u flytebot flytebot git -C /flytebot/repos/<name> checkout -b flytebot/<short-branch-name>
```

Branch naming: `flytebot/<kebab-case-description>`.

### 2. Commit and Push

```bash
docker exec -u flytebot flytebot bash -c "cd /flytebot/repos/<name> && git add <files> && git commit -m '<message>'"
docker exec -u flytebot flytebot git -C /flytebot/repos/<name> push -u origin flytebot/<branch-name>
```

### 3. Create a Pull Request

```bash
docker exec -u flytebot flytebot bash -c "cd /flytebot/repos/<name> && gh pr create \
  --base main \
  --title '<PR title>' \
  --body '<PR description>'"
```

### 4. Return to Main

After the PR is created (or if any step fails), always switch back to main:
```bash
docker exec -u flytebot flytebot git -C /flytebot/repos/<name> checkout main
```

Always return to main before completing or moving the card to Needs Help. This prevents the repo from being left on a stale feature branch for the next card.

## Commit Message Format

Connected repo commits follow the same format as flytebot commits:

```
[Card Name] Short description

Body explaining what changed and why.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Important Notes

- **NEVER force-push** to external repos
- **NEVER commit to main** — always use a feature branch
- **Always run tests** before pushing (read test command from repo-config.md)
- The repo remote uses HTTPS via `GITHUB_TOKEN` for auth (configured automatically in the entrypoint)
