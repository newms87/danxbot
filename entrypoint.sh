#!/bin/bash
set -e

APP_DIR="/danxbot/app"
REPOS_DIR="/danxbot/app/repos"
DANXBOT_HOME="/home/danxbot"

# Configure git identity and GitHub auth
git config --global user.email "${DANXBOT_GIT_EMAIL:-danxbot@example.com}"
git config --global user.name "Danxbot"
if [ -n "$GITHUB_TOKEN" ]; then
    echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
    git config --global credential.helper store
fi

# Mark all repo directories as safe (bind-mounted from host)
if [ -n "$DANXBOT_REPO_NAME" ]; then
    echo "Worker mode: repo '$DANXBOT_REPO_NAME'"
    repo_path="$REPOS_DIR/$DANXBOT_REPO_NAME"
    git config --global --add safe.directory "$repo_path"
    su -s /bin/bash danxbot -c "git config --global --add safe.directory '$repo_path'"
else
    echo "Dashboard mode: shared infrastructure only"
fi

# Configure git auth for the danxbot user (for runtime git operations)
su -s /bin/bash danxbot -c "git config --global user.email \"${DANXBOT_GIT_EMAIL:-danxbot@example.com}\" && git config --global user.name \"Danxbot\""
if [ -n "$GITHUB_TOKEN" ]; then
    su -s /bin/bash danxbot -c "
        echo 'https://x-access-token:${GITHUB_TOKEN}@github.com' > ~/.git-credentials
        git config --global credential.helper store
    "
fi

# Set up Claude Code auth for the danxbot user.
# The compose mount is at /danxbot/app/claude-auth (matches
# resolve(projectRoot, "claude-auth") in src/config.ts). Keep these paths in
# sync with the compose mount — drift here silently breaks
# `mkdir session-env` for every Bash/MCP call inside a dispatched agent
# session.
#
# Auth wiring is in scripts/claude-auth-setup.sh so its behavior can be
# unit-tested without spinning up a container. DO NOT inline-revert to
# `cp` — the script uses symlinks deliberately so host token refreshes
# are visible inside the container with no restart. Stale snapshots
# caused every dispatch to fail with a 401 (Trello 9ZurZCK2).
CLAUDE_AUTH_DIR="/danxbot/app/claude-auth" \
DANXBOT_HOME="$DANXBOT_HOME" \
    bash "$APP_DIR/scripts/claude-auth-setup.sh"

# Fix ownership of runtime directories (volumes may have been created as root)
for dir in /danxbot/threads /danxbot/data /danxbot/logs; do
    [ -d "$dir" ] && chown -R danxbot:danxbot "$dir"
done

# Wire docker.sock access for the danxbot user when the host socket is
# mounted (worker mode). The socket's GID on the host is not known at
# image build time and varies across hosts (dev vs prod), so we resolve
# it at startup and either reuse an existing group with that GID or
# create one and add danxbot to it. Without this step, `docker` CLI
# calls from the danxbot user fail with permission denied even though
# the binary is installed and the socket is mounted.
if [ -S /var/run/docker.sock ]; then
    SOCK_GID="$(stat -c '%g' /var/run/docker.sock)"
    if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
        existing_group="$(getent group "$SOCK_GID" | cut -d: -f1 || true)"
        if [ -z "$existing_group" ]; then
            groupadd -g "$SOCK_GID" docker_host
            existing_group="docker_host"
        fi
        usermod -aG "$existing_group" danxbot
        echo "Granted docker.sock access to danxbot via group '$existing_group' (GID $SOCK_GID)."
    fi
fi

# Start the Danxbot service as the non-root danxbot user.
# Docker compose's `command:` override comes in as positional args — honor them
# so services like `dashboard-dev` can run `npm run dashboard:dev` instead of
# the default API process. No args → default to the API (`npm start`).
cd "$APP_DIR"
if [ $# -gt 0 ]; then
    # Quote each arg so values with spaces survive the bash -c round-trip.
    quoted=""
    for arg in "$@"; do
        quoted+=" $(printf '%q' "$arg")"
    done
    echo "Starting container command:$quoted"
    exec su -s /bin/bash danxbot -c "exec$quoted"
else
    echo "Starting Danxbot..."
    exec su -s /bin/bash danxbot -c "npm start"
fi
