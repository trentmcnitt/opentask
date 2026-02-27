#!/bin/sh
set -e

# Auto-create initial user if env vars are set and database is fresh.
# This runs once — if the user already exists, it's a no-op.
if [ -n "$OPENTASK_INIT_USERNAME" ] && [ -n "$OPENTASK_INIT_PASSWORD" ]; then
  echo "Checking for initial user setup..."
  tsx scripts/create-user.ts \
    "$OPENTASK_INIT_USERNAME" \
    "$OPENTASK_INIT_PASSWORD" \
    "${OPENTASK_INIT_EMAIL:-${OPENTASK_INIT_USERNAME}@localhost}" \
    "${OPENTASK_INIT_TIMEZONE:-America/Chicago}"
fi

exec "$@"
