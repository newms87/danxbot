#!/bin/bash
set -e

APP_DIR="/danxbot/app"
REPOS_DIR="/danxbot/app/repos"
DANXBOT_HOME="/home/danxbot"

# Configure git identity and GitHub auth (must happen before repo cloning)
git config --global user.email "${DANXBOT_GIT_EMAIL:-danxbot@example.com}"
git config --global user.name "Danxbot"
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

        # Mark as safe directory before any git operations
        git config --global --add safe.directory "$repo_path"
        su -s /bin/bash danxbot -c "git config --global --add safe.directory '$repo_path'"

        if [ -L "$repo_path" ]; then
            echo "Symlink detected for $name, skipping clone/pull."
        elif [ ! -d "$repo_path/.git" ]; then
            echo "Cloning $name repo..."
            git clone --depth 1 "$url" "$repo_path"
        else
            echo "Updating $name repo..."
            git -C "$repo_path" fetch origin && git -C "$repo_path" pull --ff-only origin HEAD || echo "  (skipped — local changes exist)"
        fi
    done
    # Make repos accessible to all users (frontend containers run as node/1000)
    # Skip symlinked repos — they point to the user's actual working copy
    for entry in "${REPO_ENTRIES[@]}"; do
        name="${entry%%:*}"
        repo_path="$REPOS_DIR/$name"
        if [ ! -L "$repo_path" ]; then
            chmod -R a+rwX "$repo_path"
            chown -R danxbot:danxbot "$repo_path"
        fi
    done
else
    echo "No REPOS configured, skipping repo setup."
fi

# Run repo-specific post-clone hooks (e.g., auth files, dependency setup)
# Check two locations: repo-overrides/ (synced by poller) and each repo's .danxbot/config/
HOOKS_DIR="/danxbot/app/repo-overrides"
if [ -d "$HOOKS_DIR" ]; then
    for hook in "$HOOKS_DIR"/post-clone-*.sh; do
        [ -f "$hook" ] && bash "$hook" "$REPOS_DIR"
    done
fi
# Also run hooks directly from each repo's .danxbot/config/ (works on first boot
# before the poller has synced to repo-overrides/). Skip if already run via
# repo-overrides/ to avoid duplicate execution on subsequent boots.
if [ -d "$REPOS_DIR" ]; then
    for repo_hook in "$REPOS_DIR"/*/.danxbot/config/post-clone.sh; do
        [ -f "$repo_hook" ] || continue
        repo_name="$(basename "$(dirname "$(dirname "$(dirname "$repo_hook")")")")"
        [ -f "$HOOKS_DIR/post-clone-${repo_name}.sh" ] && continue
        bash "$repo_hook" "$REPOS_DIR"
    done
fi

# Configure git auth for the danxbot user too (for runtime git operations)
su -s /bin/bash danxbot -c "git config --global user.email \"${DANXBOT_GIT_EMAIL:-danxbot@example.com}\" && git config --global user.name \"Danxbot\""
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
