# Docker Runtime

## Flytebot Runs in Docker — Always

The bot runs inside a Docker container named `flytebot`. It does NOT run directly on the host.

- Container entrypoint: `npm start` → `tsx src/index.ts`
- `tsx` executes TypeScript directly from `src/` — there is no build step
- `tsc` / `npm run build` is only for type-checking, never for running the bot

## Volume Mounts

The `src/` directory is volume-mounted into the container:

```
./src → /flytebot/app/src
```

This means code changes on the host are immediately visible inside the container. However, `tsx` does NOT watch for changes — the container must be restarted to pick up code changes.

## Restarting After Code Changes

**Always recreate the container after modifying TypeScript files.** `tsx` loads modules once at startup — edits have no effect until the container is recreated. Do this automatically after finishing your code changes; don't wait for the user to ask.

**NEVER use `docker restart flytebot`.** Bind-mounted files (like `~/.claude.json`) may change inodes between restarts, causing stale mount errors. Always recreate the container:

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
docker exec flytebot cat /flytebot/app/src/<file> | grep "<unique string from your change>"
```

If the new code IS on disk but the bot isn't using it, then the running `tsx` process has stale modules in memory and a recreate is needed. If the new code is NOT on disk, the volume mount may be broken — that's a different problem.

### After restarting: confirm successful startup

```bash
docker logs flytebot --tail 20
```

Look for `Dashboard running at http://localhost:5555` and `Flytebot is running (Socket Mode)` to confirm successful startup.

## Container Paths

| Host Path | Container Path |
|-----------|---------------|
| `./src` | `/flytebot/app/src` |
| `./package.json` | `/flytebot/app/package.json` |
| `~/.claude.json` | → copied to `/root/.claude.json` at startup |
| (shared volume) | `/flytebot/repos/<name>` |

## External Repo Architecture

External repos (e.g., platform) are cloned into a shared Docker volume at `/flytebot/repos/`. Each repo uses its **own Docker compose stack** (the repo's own images) launched with an isolated project name and network.

- **File browsing** (Read, Glob, Grep) works directly from the main flytebot container — files are at `/flytebot/repos/<name>/`
- **Runtime commands** (tests, artisan, tinker) run via `docker compose -p flytebot-platform -f /flytebot/app/platform-compose.override.yml run --rm laravel.test <command>`
- **Git/gh commands** run in the main flytebot container (it has git + gh CLI)
- See `external-repo-workflow.md` for full details

## Tools Available Inside the Container

The Docker image includes dev tools beyond Node.js. Use `docker exec flytebot <command>` to access them:

- **gh** — GitHub CLI for creating PRs, managing issues
- **git** — Full git client (HTTPS token auth via gh)
- **docker** / **docker compose** — For managing sibling containers
- **mysql** — MySQL client for direct DB access

**NEVER try to install these tools on the host.** They are already in the Docker image. Run them inside the container.

## Never Run the Bot on the Host

Do not use `npm start` or `npm run dev` on the host. The bot requires:
- Claude Code CLI installed globally
- Claude auth at `/root/.claude.json`
- Network access to the platform database (via Docker `sail` network)
- Access to repo clones at `/flytebot/repos/`

All of these are configured inside the container.
