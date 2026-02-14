#!/bin/bash
set -euo pipefail

# Re-run failed scenarios from the last quality test run.

SUMMARY="test-results/latest-quality/summary.json"

if [ ! -f "$SUMMARY" ]; then
  echo "Error: No previous quality run found at $SUMMARY"
  exit 1
fi

FAILED=$(node -e "
  try {
    const s = JSON.parse(require('fs').readFileSync('$SUMMARY', 'utf8'));
    const failed = s.scenarios.filter(r => !r.structuralPass).map(r => r.id);
    if (failed.length === 0) process.exit(0);
    console.log(failed.join('|'));
  } catch (e) {
    console.error('Error: Failed to parse $SUMMARY:', e.message);
    process.exit(1);
  }
")

if [ -z "$FAILED" ]; then
  echo "All scenarios passed in the last run. Nothing to retry."
  exit 0
fi

COUNT=$(echo "$FAILED" | tr '|' '\n' | wc -l | tr -d ' ')
echo "Re-running $COUNT failed scenario(s): $(echo "$FAILED" | tr '|' ', ')"
echo ""

exec npx vitest run --config vitest.quality.config.ts -t "$FAILED"
