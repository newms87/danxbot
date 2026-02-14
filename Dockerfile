FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    mysql-client \
    software-properties-common \
    gnupg2 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# PHP 8.3 + extensions
RUN add-apt-repository ppa:ondrej/php -y \
    && apt-get update \
    && apt-get install -y \
    php8.3-cli \
    php8.3-mysql \
    php8.3-mbstring \
    php8.3-xml \
    php8.3-curl \
    php8.3-redis \
    php8.3-bcmath \
    php8.3-zip \
    && rm -rf /var/lib/apt/lists/*

# Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

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
RUN mkdir -p /flytebot/app /flytebot/platform /flytebot/threads /flytebot/data /flytebot/logs \
    && chown -R flytebot:flytebot /flytebot

WORKDIR /flytebot/app

# Install dependencies (layer cached unless package.json changes)
COPY --chown=flytebot:flytebot package.json package-lock.json* ./
RUN npm install

# Copy application code
COPY --chown=flytebot:flytebot . .

# Entrypoint (must run as root initially to copy auth, then drops to flytebot user)
COPY entrypoint.sh /flytebot/entrypoint.sh
RUN chmod +x /flytebot/entrypoint.sh

ENTRYPOINT ["/flytebot/entrypoint.sh"]
