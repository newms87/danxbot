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
| `/home/newms/web/platform` | `/flytebot/platform` |
| `~/.claude.json` | → copied to `/root/.claude.json` at startup |

## Never Run the Bot on the Host

Do not use `npm start` or `npm run dev` on the host. The bot requires:
- Claude Code CLI installed globally
- Claude auth at `/root/.claude.json`
- Network access to the platform database (via Docker `sail` network)
- Access to the platform repo at `/flytebot/platform`

All of these are configured inside the container.
