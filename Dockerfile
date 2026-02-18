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

# Docker CLI + Compose plugin (for managing sibling containers)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu jammy stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli docker-compose-plugin \
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
RUN useradd -m -s /bin/bash flytebot

# Working directories (owned by flytebot user)
RUN mkdir -p /flytebot/app /flytebot/repos /flytebot/threads /flytebot/data /flytebot/logs \
    && chown -R flytebot:flytebot /flytebot

WORKDIR /flytebot/app

# Install backend dependencies (layer cached unless package.json changes)
COPY --chown=flytebot:flytebot package.json package-lock.json* ./
RUN npm install

# Install dashboard dependencies and build (cached layer)
COPY --chown=flytebot:flytebot dashboard/package.json dashboard/package-lock.json* dashboard/
RUN cd dashboard && npm install

# Copy application code
COPY --chown=flytebot:flytebot . .

# Build dashboard for production
RUN cd dashboard && npm run build

# Entrypoint (must run as root initially to copy auth, then drops to flytebot user)
COPY entrypoint.sh /flytebot/entrypoint.sh
RUN chmod +x /flytebot/entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:5555/health || exit 1

ENTRYPOINT ["/flytebot/entrypoint.sh"]
