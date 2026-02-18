#!/bin/bash
set -e

SSAP_DIR="/flytebot/repos/platform/ssap"
LOCKFILE="$SSAP_DIR/vendor/.composer-lock-hash"

# Install composer dependencies if missing or stale
if [ ! -f "$SSAP_DIR/vendor/autoload.php" ] || \
   [ ! -f "$LOCKFILE" ] || \
   [ "$(cat "$LOCKFILE" 2>/dev/null)" != "$(md5sum "$SSAP_DIR/composer.lock" 2>/dev/null | cut -d' ' -f1)" ]; then
    echo "Installing composer dependencies..."
    cd "$SSAP_DIR" && composer install --no-interaction --quiet
    md5sum "$SSAP_DIR/composer.lock" | cut -d' ' -f1 > "$LOCKFILE"
    echo "Composer dependencies installed."
else
    echo "Composer dependencies up to date."
fi

# Generate .env from template if template exists
if [ -f "/flytebot/platform.env.template" ]; then
    envsubst < /flytebot/platform.env.template > "$SSAP_DIR/.env"
fi

# Execute the passed command
exec "$@"
