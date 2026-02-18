#!/bin/bash
set -e

APP_DIR="/flytebot/app"
REPOS_DIR="/flytebot/repos"
FLYTEBOT_HOME="/home/flytebot"

# Clone/update repos from REPOS env var (format: name:url,name:url)
if [ -n "$REPOS" ]; then
    IFS=',' read -ra REPO_ENTRIES <<< "$REPOS"
    for entry in "${REPO_ENTRIES[@]}"; do
        name="${entry%%:*}"
        url="${entry#*:}"
        repo_path="$REPOS_DIR/$name"

        if [ ! -d "$repo_path/.git" ]; then
            echo "Cloning $name repo..."
            git clone --depth 1 "$url" "$repo_path"
        else
            echo "Updating $name repo..."
            git -C "$repo_path" fetch origin && git -C "$repo_path" reset --hard origin/HEAD
        fi

        # Mark as safe directory for both root and flytebot users
        git config --global --add safe.directory "$repo_path"
        su -s /bin/bash flytebot -c "git config --global --add safe.directory '$repo_path'"
    done
    chown -R flytebot:flytebot "$REPOS_DIR"
else
    echo "No REPOS configured, skipping repo setup."
fi

# Configure git identity and GitHub auth
su -s /bin/bash flytebot -c "git config --global user.email 'flytebot@flytedesk.com' && git config --global user.name 'Flytebot'"
if [ -n "$GITHUB_TOKEN" ]; then
    su -s /bin/bash flytebot -c "gh auth setup-git"
    echo "GitHub auth configured."
fi

# Add flytebot user to docker group (for sibling container management)
if getent group docker > /dev/null 2>&1; then
    usermod -aG docker flytebot
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
