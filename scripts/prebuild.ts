/**
 * Generate build timestamp for cache invalidation and UI display.
 * Output format: YYYYMMDD-HHMM (e.g., 20260204-1430)
 *
 * Usage: tsx scripts/prebuild.ts
 * The build script captures stdout and sets NEXT_PUBLIC_BUILD_ID.
 */

const now = new Date()
const buildId = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
console.log(buildId)
