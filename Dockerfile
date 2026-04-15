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

WORKDIR /danxbot/app

# Install backend dependencies (layer cached unless package.json changes)
COPY --chown=danxbot:danxbot package.json package-lock.json* ./
RUN npm install

# Install dashboard dependencies and build (cached layer)
COPY --chown=danxbot:danxbot dashboard/package.json dashboard/package-lock.json* dashboard/
RUN cd dashboard && npm install

# Copy application code
COPY --chown=danxbot:danxbot . .

# Build dashboard for production
RUN cd dashboard && npm run build

# Entrypoint (must run as root initially to copy auth, then drops to danxbot user)
COPY entrypoint.sh /danxbot/entrypoint.sh
RUN chmod +x /danxbot/entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${DASHBOARD_PORT:-5555}/health || exit 1

ENTRYPOINT ["/danxbot/entrypoint.sh"]
