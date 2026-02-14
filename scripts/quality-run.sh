#!/bin/bash
set -euo pipefail

# Run specific quality test scenarios by ID.
# Usage: ./scripts/quality-run.sh <scenario-id> [scenario-id ...]

if [ $# -eq 0 ]; then
  echo "Usage: npm run test:quality:run -- <scenario-id> [scenario-id ...]"
  echo ""
  echo "Examples:"
  echo "  npm run test:quality:run -- enrich-label-explicit-tag"
  echo "  npm run test:quality:run -- insights-boundary-stale insights-mixed-priorities"
  echo ""
  echo "Use 'npm run dump-prompts -- --list' to see available scenario IDs."
  exit 1
fi

PATTERN=$(IFS='|'; echo "$*")

echo "Running scenario(s): $(echo "$PATTERN" | tr '|' ', ')"
echo ""

exec npx vitest run --config vitest.quality.config.ts -t "$PATTERN"
