#!/bin/bash
set -e

PLATFORM_DIR="/flytebot/platform"
APP_DIR="/flytebot/app"

if [ ! -d "$PLATFORM_DIR/.git" ]; then
    if [ "$PLATFORM_REPO_URL" != "skip" ]; then
        echo "Cloning platform repo..."
        git clone --depth 1 "$PLATFORM_REPO_URL" "$PLATFORM_DIR"

        # Install PHP dependencies for artisan commands
        echo "Installing composer dependencies..."
        cd "$PLATFORM_DIR/ssap" && composer install --no-dev --no-interaction --quiet

        # Set up platform .env for artisan/tinker commands
        echo "Setting up platform .env..."
        envsubst < "$APP_DIR/platform.env.template" > "$PLATFORM_DIR/ssap/.env"
    else
        echo "No platform repo found and PLATFORM_REPO_URL=skip, skipping clone."
    fi
else
    echo "Platform repo already present (volume-mounted or previously cloned)."
fi

# Set up Claude Code auth (copy from read-only directory mounts to writable location)
if [ -f "/flytebot/claude-auth/home/.claude.json" ]; then
    cp /flytebot/claude-auth/home/.claude.json /root/.claude.json
    mkdir -p /root/.claude
    cp /flytebot/claude-auth/dot-claude/.credentials.json /root/.claude/.credentials.json
    echo "Claude Code auth configured."
fi

# Start the Flytebot service
echo "Starting Flytebot..."
cd "$APP_DIR" && exec npm start
