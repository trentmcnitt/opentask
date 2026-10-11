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
 * Whether to SHOW it (AI on, not the demo account) is the caller's call; see
 * `useAiContextStaleness`.
 */

export const AI_CONTEXT_STALE_DAYS = 21

const DAY_MS = 24 * 60 * 60 * 1000

export interface AiContextStaleness {
  /** Days since the last change, or null when it was never recorded. */
  ageDays: number | null
  /** Whether there is any context at all. */
  hasContext: boolean
}

/** The staleness of a context, or null when it is fresh. */
export function aiContextStaleness(
  context: string | null,
  updatedAt: string | null,
  now: Date = new Date(),
): AiContextStaleness | null {
  const hasContext = !!context && context.trim().length > 0
  if (!updatedAt) return { ageDays: null, hasContext }
  const changed = Date.parse(updatedAt)
  if (Number.isNaN(changed)) return { ageDays: null, hasContext }
  const ageDays = Math.floor((now.getTime() - changed) / DAY_MS)
  return ageDays >= AI_CONTEXT_STALE_DAYS ? { ageDays, hasContext } : null
}

/**
 * The warning's words: short enough for one sidebar line. "Add AI context"
 * when there is none, otherwise its age in weeks ("AI context: 4 weeks old"),
 * or "Review AI context" when the age is unknown.
 */
export function aiContextStalenessLabel(s: AiContextStaleness): string {
  if (!s.hasContext) return 'Add AI context'
  if (s.ageDays === null) return 'Review AI context'
  return `AI context: ${Math.floor(s.ageDays / 7)} weeks old`
}

/** "today", "yesterday", "12 days ago" — the age Settings shows under the field. */
export function formatAiContextAge(updatedAt: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(updatedAt)) / DAY_MS)
  if (!(days > 0)) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/** Where the warning links: the Settings field (`AiSection` focuses it). */
export const AI_CONTEXT_SETTINGS_HREF = '/settings#ai-context'
