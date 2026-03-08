/**
 * Build ID and formatting utilities for cache invalidation and UI display.
 *
 * Machine format: YYYYMMDD-HHMM (e.g., 20260204-1430) — safe for cache names
 * Display format: "Feb 4, 2:30 PM" — human-readable for settings UI
 * Dev fallback: "dev" → displays as "Development"
 */

export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || 'dev'
export const VERSION = '0.2.1'

/**
 * Format a build ID for human-readable display.
 * @param buildId - Machine format build ID (e.g., "20260204-1430") or "dev"
 * @returns Human-readable string (e.g., "Feb 4, 2:30 PM" or "Development")
 */
export function formatBuildDate(buildId: string): string {
  if (buildId === 'dev') return 'Development'

  // Parse YYYYMMDD-HHMM format
  const match = buildId.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/)
  if (!match) return buildId // Fallback to raw value if format doesn't match

  const [, year, month, day, hours, minutes] = match
  const date = new Date(
    parseInt(year),
    parseInt(month) - 1, // JS months are 0-indexed
    parseInt(day),
    parseInt(hours),
    parseInt(minutes),
  )

  // Format as "Feb 4, 2:30 PM"
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}
