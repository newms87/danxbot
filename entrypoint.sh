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
# sync with the compose mount — drift here silently skips the chown below and
# leaves /home/danxbot/.claude root-owned, which breaks `mkdir session-env`
# for every Bash/MCP call inside a dispatched agent session.
CLAUDE_AUTH_DIR="/danxbot/app/claude-auth"
if [ -f "$CLAUDE_AUTH_DIR/.claude.json" ]; then
    cp "$CLAUDE_AUTH_DIR/.claude.json" "$DANXBOT_HOME/.claude.json"
    mkdir -p "$DANXBOT_HOME/.claude"
    if [ -f "$CLAUDE_AUTH_DIR/.credentials.json" ]; then
        cp "$CLAUDE_AUTH_DIR/.credentials.json" "$DANXBOT_HOME/.claude/.credentials.json"
    fi
    chown -R danxbot:danxbot "$DANXBOT_HOME/.claude.json" "$DANXBOT_HOME/.claude"
    echo "Claude Code auth configured."
else
    echo "WARNING: No Claude auth found at $CLAUDE_AUTH_DIR/ — agent will not work."
fi

# Fix ownership of runtime directories (volumes may have been created as root)
for dir in /danxbot/threads /danxbot/data /danxbot/logs; do
    [ -d "$dir" ] && chown -R danxbot:danxbot "$dir"
done

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
