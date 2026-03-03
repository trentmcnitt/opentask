#!/bin/sh
set -e

# Ensure data directory is writable by the app user.
# Docker creates host-mounted volumes as root, but the app runs as nextjs (uid 1001).
chown -R nextjs:nodejs /app/data

# --- VAPID key auto-generation for Web Push ---
# User-provided keys take precedence. If not set, auto-generate on first start
# and persist to the data volume so keys survive container recreation.
VAPID_KEYS_FILE="/app/data/.vapid-keys"

if [ -n "$VAPID_PUBLIC_KEY" ] && [ -n "$VAPID_PRIVATE_KEY" ]; then
  echo "VAPID keys provided via environment, skipping auto-generation."
elif [ -f "$VAPID_KEYS_FILE" ]; then
  echo "Loading previously generated VAPID keys."
  . "$VAPID_KEYS_FILE"
  export VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
else
  echo "No VAPID keys found. Generating for Web Push..."
  su-exec nextjs node scripts/generate-vapid-keys.mjs "$VAPID_KEYS_FILE"
  . "$VAPID_KEYS_FILE"
  export VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
  echo "VAPID keys generated. Web Push notifications are now enabled."
fi

# Default VAPID_EMAIL if not provided (required by web-push library)
if [ -z "$VAPID_EMAIL" ]; then
  if [ -n "$OPENTASK_INIT_EMAIL" ]; then
    # Strip mailto: prefix if already present to avoid mailto:mailto:...
    INIT_EMAIL_CLEAN=$(echo "$OPENTASK_INIT_EMAIL" | sed 's/^mailto://')
    export VAPID_EMAIL="mailto:${INIT_EMAIL_CLEAN}"
  else
    export VAPID_EMAIL="mailto:opentask@localhost"
  fi
fi

# Auto-create initial user if env vars are set and database is fresh.
# This runs once — if the user already exists, it's a no-op.
if [ -n "$OPENTASK_INIT_USERNAME" ] && [ -n "$OPENTASK_INIT_PASSWORD" ]; then
  if [ -z "$OPENTASK_INIT_TIMEZONE" ]; then
    echo "Error: OPENTASK_INIT_TIMEZONE is required when creating the initial user."
    echo "Example: OPENTASK_INIT_TIMEZONE=America/New_York"
    echo "Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
    exit 1
  fi
  echo "Checking for initial user setup..."
  su-exec nextjs tsx scripts/create-user.ts \
    "$OPENTASK_INIT_USERNAME" \
    "$OPENTASK_INIT_PASSWORD" \
    "${OPENTASK_INIT_EMAIL:-${OPENTASK_INIT_USERNAME}@localhost}" \
    "$OPENTASK_INIT_TIMEZONE"
fi

exec su-exec nextjs "$@"
