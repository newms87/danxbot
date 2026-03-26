#!/bin/bash
set -e

APP_DIR="/danxbot/app"
REPOS_DIR="/danxbot/repos"
DANXBOT_HOME="/home/danxbot"

# Configure git identity and GitHub auth (must happen before repo cloning)
git config --global user.email 'danxbot@flytedesk.com'
git config --global user.name 'Danxbot'
if [ -n "$GITHUB_TOKEN" ]; then
    echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
    git config --global credential.helper store
    echo "GitHub auth configured."
fi

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
            git -C "$repo_path" fetch origin && git -C "$repo_path" pull --ff-only origin HEAD || echo "  (skipped — local changes exist)"
        fi

        # Mark as safe directory for both root and danxbot users
        git config --global --add safe.directory "$repo_path"
        su -s /bin/bash danxbot -c "git config --global --add safe.directory '$repo_path'"
    done
    # Make repos accessible to all users (frontend containers run as node/1000)
    chmod -R a+rwX "$REPOS_DIR"
    chown -R danxbot:danxbot "$REPOS_DIR"
else
    echo "No REPOS configured, skipping repo setup."
fi

# Run repo-specific post-clone hooks (e.g., auth files, dependency setup)
HOOKS_DIR="/danxbot/app/repo-overrides"
if [ -d "$HOOKS_DIR" ]; then
    for hook in "$HOOKS_DIR"/post-clone-*.sh; do
        [ -f "$hook" ] && bash "$hook" "$REPOS_DIR"
    done
fi

# Configure git auth for the danxbot user too (for runtime git operations)
su -s /bin/bash danxbot -c "git config --global user.email 'danxbot@flytedesk.com' && git config --global user.name 'Danxbot'"
if [ -n "$GITHUB_TOKEN" ]; then
    su -s /bin/bash danxbot -c "
        echo 'https://x-access-token:${GITHUB_TOKEN}@github.com' > ~/.git-credentials
        git config --global credential.helper store
    "
fi

# Add danxbot user to docker group (for sibling container management)
if getent group docker > /dev/null 2>&1; then
    usermod -aG docker danxbot
fi

# Set up Claude Code auth for the danxbot user (copied into project by /setup)
if [ -f "/danxbot/claude-auth/.claude.json" ]; then
    cp /danxbot/claude-auth/.claude.json "$DANXBOT_HOME/.claude.json"
    mkdir -p "$DANXBOT_HOME/.claude"
    if [ -f "/danxbot/claude-auth/.credentials.json" ]; then
        cp /danxbot/claude-auth/.credentials.json "$DANXBOT_HOME/.claude/.credentials.json"
    fi
    chown -R danxbot:danxbot "$DANXBOT_HOME/.claude.json" "$DANXBOT_HOME/.claude"
    echo "Claude Code auth configured."
else
    echo "WARNING: No Claude auth found at /danxbot/claude-auth/ — agent will not work."
    echo "Run ./install.sh or manually copy .claude.json and .credentials.json to claude-auth/"
fi

# Fix ownership of runtime directories (volumes may have been created as root)
chown -R danxbot:danxbot /danxbot/threads /danxbot/data /danxbot/logs

# Start the Danxbot service as the non-root danxbot user
echo "Starting Danxbot..."
cd "$APP_DIR" && exec su -s /bin/bash danxbot -c "npm start"
