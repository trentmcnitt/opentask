/**
 * Whether the user's global AI context (`users.ai_context`, Settings → AI
 * Context) is due a look (task-model redesign, 2026-10-10).
 *
 * The context is the one place the AI learns about the user's life ("my wife
 * handles groceries"), and a stale one quietly mis-steers every enrichment.
 * Trent asked for a staleness indicator "when it hasn't been updated in a
 * while (~2–4 weeks)": 21 days, the middle of that range.
 *
 * Stale when:
 * - it changed more than `AI_CONTEXT_STALE_DAYS` ago;
 * - it has never been stamped (`updatedAt` null). That covers a context set
 *   before 2026-10-10, when the stamp began — its age is unknown, and an
 *   unknown age is the case worth one look, not a reason to stay silent — and
 *   a user who never wrote one at all, whose AI is running blind.
 *
 * Where it shows (2026-10-14): only in Settings › AI, under the field — its
 * age, a quiet emphasis once stale, and "Still accurate". The left-bar and ☰
 * menu link that used to point there is gone (Trent: "not only does it not
 * look good but it's weird").
 */

export const AI_CONTEXT_STALE_DAYS = 21

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days since `updatedAt`, or null when it is missing or unreadable. */
function ageInDays(updatedAt: string | null, now: Date): number | null {
  if (!updatedAt) return null
  const changed = Date.parse(updatedAt)
  if (Number.isNaN(changed)) return null
  return Math.floor((now.getTime() - changed) / DAY_MS)
}

/** Stale: no (readable) update date, or one `AI_CONTEXT_STALE_DAYS`+ days old. */
export function isAiContextStale(updatedAt: string | null, now: Date = new Date()): boolean {
  const days = ageInDays(updatedAt, now)
  return days === null || days >= AI_CONTEXT_STALE_DAYS
}

/**
 * The age Settings shows under the field: "Updated today", "Updated
 * yesterday", "Updated 12 days ago" (under two weeks), "Updated 3 weeks ago"
 * (under two months, so the 21-day threshold reads as weeks), "Updated 2
 * months ago", "Updated over a year ago" — or "No update date" when the
 * context was never stamped.
 */
export function aiContextAgeLabel(updatedAt: string | null, now: Date = new Date()): string {
  const days = ageInDays(updatedAt, now)
  if (days === null) return 'No update date'
  if (days <= 0) return 'Updated today'
  if (days === 1) return 'Updated yesterday'
  if (days < 14) return `Updated ${days} days ago`
  if (days < 60) return `Updated ${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `Updated ${Math.floor(days / 30)} months ago`
  return 'Updated over a year ago'
}
