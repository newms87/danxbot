#!/bin/bash
set -e

PLATFORM_DIR="/flytebot/platform"
APP_DIR="/flytebot/app"
FLYTEBOT_HOME="/home/flytebot"

if [ ! -d "$PLATFORM_DIR/.git" ]; then
    if [ "$PLATFORM_REPO_URL" != "skip" ]; then
        echo "Cloning platform repo..."
        git clone --depth 1 "$PLATFORM_REPO_URL" "$PLATFORM_DIR"

        # Install PHP dependencies for artisan commands
        echo "Installing composer dependencies..."
        cd "$PLATFORM_DIR/ssap" && composer install --no-dev --no-interaction --quiet
        chown -R flytebot:flytebot "$PLATFORM_DIR"

        # Set up platform .env for artisan/tinker commands
        echo "Setting up platform .env..."
        envsubst < "$APP_DIR/platform.env.template" > "$PLATFORM_DIR/ssap/.env"
    else
        echo "No platform repo found and PLATFORM_REPO_URL=skip, skipping clone."
    fi
else
    echo "Platform repo already present (volume-mounted or previously cloned)."
fi

# Set up Claude Code auth for the flytebot user (copy from read-only directory mounts)
if [ -f "/flytebot/claude-auth/home/.claude.json" ]; then
    cp /flytebot/claude-auth/home/.claude.json "$FLYTEBOT_HOME/.claude.json"
    mkdir -p "$FLYTEBOT_HOME/.claude"
    cp /flytebot/claude-auth/dot-claude/.credentials.json "$FLYTEBOT_HOME/.claude/.credentials.json"
    chown -R flytebot:flytebot "$FLYTEBOT_HOME/.claude.json" "$FLYTEBOT_HOME/.claude"
    echo "Claude Code auth configured."
fi

# Fix ownership of runtime directories (volumes may have been created as root)
chown -R flytebot:flytebot /flytebot/threads /flytebot/data /flytebot/logs

# Start the Flytebot service as the non-root flytebot user
echo "Starting Flytebot..."
cd "$APP_DIR" && exec su -s /bin/bash flytebot -c "npm start"
