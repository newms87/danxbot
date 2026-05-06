FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    mysql-client \
    gnupg2 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (needed by the SDK)
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (Claude Code SDK blocks --dangerously-skip-permissions for root)
RUN useradd -m -s /bin/bash danxbot

# Working directories (owned by danxbot user)
RUN mkdir -p /danxbot/app /danxbot/repos /danxbot/threads /danxbot/data /danxbot/logs \
    && chown -R danxbot:danxbot /danxbot

# Pre-create Claude Code runtime directories with correct ownership.
# The compose.yml bind-mounts /home/danxbot/.claude/projects at startup; Docker
# creates the .claude/ parent as root before the entrypoint runs, making it
# unwritable by the danxbot user. Pre-creating these here ensures Claude Code
# can create session-env/, settings.json, and other runtime state without
# permission errors. The entrypoint re-chowns these if needed, but this
# ensures the directories exist and are owned correctly from image build time.
RUN mkdir -p /home/danxbot/.claude/session-env \
    && chown -R danxbot:danxbot /home/danxbot/.claude

WORKDIR /danxbot/app

# Install backend dependencies (layer cached unless package.json changes)
COPY --chown=danxbot:danxbot package.json package-lock.json* ./
RUN npm install

# Install dashboard dependencies and build (cached layer)
COPY --chown=danxbot:danxbot dashboard/package.json dashboard/package-lock.json* dashboard/
RUN cd dashboard && npm install

# Copy application code. .dockerignore excludes `repos/` so the host-only
# symlinks that point at dev-machine paths (e.g. /home/newms/web/...) do
# not end up in the image. Create the repos dir explicitly so runtime
# bind mounts have a clean, non-symlink target — otherwise Claude Code
# would resolve cwd through the baked-in symlink and write JSONL session
# logs to the host path instead of the container repo path.
COPY --chown=danxbot:danxbot . .
RUN mkdir -p /danxbot/app/repos && chown danxbot:danxbot /danxbot/app/repos

# Build dashboard for production
RUN cd dashboard && npm run build

# Entrypoint (must run as root initially to copy auth, then drops to danxbot user)
COPY entrypoint.sh /danxbot/entrypoint.sh
RUN chmod +x /danxbot/entrypoint.sh

# Short commit SHA of the danxbot repo at image-build time. Populated by
# `make build` and `deploy/build.ts` from `git rev-parse --short HEAD`.
# Read at runtime by `getDanxbotCommit()` so dispatched-agent rows record
# the danxbot version that ran them — even when the container has no
# `.git` dir. Empty in unparameterized builds; the runtime falls back to
# `git rev-parse` against the source root in that case (dev shells).
#
# CRITICAL: keep this at the BOTTOM of the Dockerfile. ARG before any
# RUN/COPY sets the ENV in every subsequent layer's BuildKit cache key;
# every deploy passes a different SHA, which would invalidate apt-get,
# npm install, and every other heavy layer above. Empirically observed:
# bumping ARG placement to the bottom turns ~48-min cold deploys into
# ~3-min warm deploys.
ARG DANXBOT_COMMIT=
ENV DANXBOT_COMMIT=${DANXBOT_COMMIT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${DASHBOARD_PORT:-5555}/health || exit 1

ENTRYPOINT ["/danxbot/entrypoint.sh"]
