# Docker Runtime

## Danxbot Runs in Docker — Always

The bot runs inside a Docker container managed by docker compose. It does NOT run directly on the host.

- Container entrypoint: `npm start` → `tsx src/index.ts`
- `tsx` executes TypeScript directly from `src/` — there is no build step
- `tsc` / `npm run build` is only for type-checking, never for running the bot

## Volume Mounts

The `src/` directory is volume-mounted into the container:

```
./src → /danxbot/app/src
```

This means code changes on the host are immediately visible inside the container. However, `tsx` does NOT watch for changes — the container must be restarted to pick up code changes.

## Restarting After Code Changes

**Always recreate the container after modifying TypeScript files.** `tsx` loads modules once at startup — edits have no effect until the container is recreated. Do this automatically after finishing your code changes; don't wait for the user to ask.

**NEVER use `docker compose restart danxbot`.** Bind-mounted files (like `~/.claude.json`) may change inodes between restarts, causing stale mount errors. Always recreate the container:

After modifying any TypeScript files:

```bash
docker compose up -d --force-recreate
```

After modifying `package.json` or adding dependencies:

```bash
docker compose up -d --build
```

## Verifying Changes

### Before restarting: confirm the code is stale

When behavior doesn't match code changes, don't assume the container needs a restart. Verify first:

```bash
docker compose exec danxbot cat /danxbot/app/src/<file> | grep "<unique string from your change>"
```

If the new code IS on disk but the bot isn't using it, then the running `tsx` process has stale modules in memory and a recreate is needed. If the new code is NOT on disk, the volume mount may be broken — that's a different problem.

### After restarting: confirm successful startup

```bash
docker compose logs danxbot --tail 20
```

Look for `Dashboard running at http://localhost:5555` to confirm successful startup. If Slack is configured, also look for `Danxbot is running (Socket Mode)`.

## Container Paths

| Host Path | Container Path |
|-----------|---------------|
| `./src` | `/danxbot/app/src` |
| `./package.json` | `/danxbot/app/package.json` |
| `./repos/` | `/danxbot/repos/` |
| `./repo-overrides/` | `/danxbot/app/repo-overrides/` |

## Connected Repo Architecture

Connected repos are cloned into `repos/<name>/` at container startup (from the `REPOS` env var). The danxbot container has git, gh, docker, and docker compose available for managing repos and their Docker stacks.

- **File browsing** (Read, Glob, Grep) works directly — files are at `repos/<name>/` on the host and `/danxbot/repos/<name>/` in the container
- **Runtime commands** depend on the repo's runtime setting in `repo-config/config.yml`:
  - **Docker runtime:** Commands run via `docker compose exec danxbot docker compose -p <project_name> -f /danxbot/app/repo-overrides/<compose_file> run --rm <service> <command>`
  - **Local runtime:** Commands run directly in the repo directory
- **Git/gh commands** run in the danxbot container: `docker compose exec -u danxbot danxbot git -C /danxbot/repos/<name> <command>`
- Read `.claude/rules/repo-config.md` for the exact commands, service names, and paths

## Repo Directory

All repo-specific config lives in `.danxbot/config/` inside the connected repo (version controlled):

```
repos/<name>/.danxbot/
  config/
    config.yml       # name, url, commands, docker, paths
    trello.yml       # board ID, list IDs, label IDs
    overview.md      # tech stack, architecture, patterns
    workflow.md      # how to edit, test, commit, PR
    compose.yml      # Docker override (optional)
    post-clone.sh    # runs after cloning (optional)
    docs/
      domains/*.md   # domain knowledge
      schema/*.md    # DB relationships
  features.md        # ideator's persistent memory (gitignored)
```

Secrets (API keys, tokens, passwords) stay in danxbot's `.env` and `repo-overrides/<name>.env`. The poller syncs `.danxbot/config/` to target locations (`.claude/rules/`, `docs/`, `repo-overrides/`) before each Claude spawn.

## Tools Available Inside the Container

The Docker image includes dev tools beyond Node.js. Use `docker compose exec danxbot <command>` to access them:

- **gh** — GitHub CLI for creating PRs, managing issues
- **git** — Full git client (HTTPS token auth via gh)
- **docker** / **docker compose** — For managing sibling containers
- **mysql** — MySQL client for direct DB access

**NEVER try to install these tools on the host.** They are already in the Docker image. Run them inside the container.

## Never Run the Bot on the Host

Do not use `npm start` or `npm run dev` on the host. The bot requires:
- Claude Code CLI installed globally
- Claude auth at `/root/.claude.json`
- Access to repo clones at `/danxbot/repos/`

All of these are configured inside the container.
