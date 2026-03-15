#!/bin/bash
set -e

# Spin up flytebot + a fully functional platform environment.
# Usage: ./scripts/platform-up.sh [--build]
#   --build  Force rebuild of flytebot image (needed after dependency changes)

COMPOSE_CMD="docker compose -p flytebot-platform -f /flytebot/app/platform-compose.override.yml"
BUILD_FLAG=""
if [ "$1" = "--build" ]; then
    BUILD_FLAG="--build"
fi

echo "==> Starting flytebot..."
docker compose up -d $BUILD_FLAG

echo "==> Waiting for flytebot to be healthy..."
until curl -sf http://localhost:5555/health > /dev/null 2>&1; do
    sleep 2
done
echo "    Flytebot is healthy."

# Apply platform patches (DANX_USE_NPM support in danx-local.sh and vite.config.ts)
# These will be removed once merged via platform PR
echo "==> Applying platform patches..."
docker exec flytebot bash /flytebot/app/scripts/platform-patches.sh

echo "==> Starting platform data services (mysql, redis)..."
docker exec flytebot $COMPOSE_CMD up -d mysql redis

echo "==> Waiting for platform MySQL to be healthy..."
until docker exec flytebot $COMPOSE_CMD exec mysql mysqladmin ping -ppassword -s 2>/dev/null; do
    sleep 2
done
echo "    MySQL is healthy."

# Check if migrations have been run (tables exist)
TABLE_COUNT=$(docker exec flytebot $COMPOSE_CMD run --rm -T laravel.test php artisan tinker --execute="echo \Illuminate\Support\Facades\Schema::hasTable('users') ? '1' : '0'" 2>/dev/null | tr -d '[:space:]')

if [ "$TABLE_COUNT" = "0" ]; then
    echo "==> Running migrations..."
    docker exec flytebot $COMPOSE_CMD run --rm -T laravel.test php artisan migrate --force

    echo "==> Seeding database..."
    docker exec flytebot $COMPOSE_CMD run --rm -T laravel.test php artisan db:seed --force
else
    echo "==> Database already migrated, skipping."
fi

echo "==> Starting platform services (laravel, mva, web, v4)..."
docker exec flytebot $COMPOSE_CMD up -d

echo ""
echo "========================================"
echo "  Platform is ready!"
echo ""
echo "  Laravel API:  http://localhost:18081"
echo "  MVA (Vue 3):  http://localhost:9090"
echo "  Web (v3):     http://localhost:8000"
echo "  V4:           http://localhost:8004"
echo "  MySQL:        localhost:13306 (sail/password, db: testing)"
echo "  Redis:        localhost:16379"
echo "  Flytebot:     http://localhost:5555"
echo "========================================"
