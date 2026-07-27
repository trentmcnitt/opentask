/**
 * Scheduled (daily) AI generation — REDESIGN-V03 §7.4
 *
 * What's Next and Insights run **once daily on a schedule, plus on-demand
 * refresh**. They must never regenerate as a side effect of a page load: this
 * is a single-user install, so eager regeneration on mount just burns tokens
 * for a result nobody asked for. The read routes therefore serve cache only,
 * and this module is what fills the cache.
 *
 * Users are processed **sequentially, not in parallel.** These calls are
 * expensive (Insights scores the whole corpus in chunks) and the point of
 * moving them off the request path was to stop them competing with interactive
 * work. Fanning out would reintroduce that.
 *
 * Failures are per-user and non-fatal: one user's failed run must not stop the
 * others, and a missing result degrades to "no data, offer refresh" in the UI
 * rather than to an error.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { isAIEnabled } from './sdk'
import { generateWhatsNext } from './whats-next'
import { generateInsightsForUser } from './insights'
import { buildTaskSummaries } from './task-summaries'
import { getUserAiContext, getUserFeatureModes } from './user-context'
import { resolveFeatureAIConfig } from './models'

interface ScheduledUser {
  id: number
  timezone: string
}

/** Users eligible for scheduled AI runs. Demo accounts are excluded — their data is reset every 4 hours, so a nightly run would be generating insights about tasks that no longer exist. */
function getScheduledUsers(): ScheduledUser[] {
  const db = getDb()
  return db.prepare('SELECT id, timezone FROM users WHERE is_demo = 0').all() as ScheduledUser[]
}

/**
 * Generate What's Next for every eligible user.
 *
 * Skips users who have the feature switched off. Safe to call when AI is
 * disabled entirely — it becomes a no-op.
 */
export async function runScheduledWhatsNext(): Promise<void> {
  if (!isAIEnabled()) return

  for (const user of getScheduledUsers()) {
    const modes = getUserFeatureModes(user.id)
    if (modes.whats_next === 'off') continue

    try {
      const taskSummaries = buildTaskSummaries(user.id)
      if (taskSummaries.length === 0) continue

      await generateWhatsNext(
        user.id,
        user.timezone,
        taskSummaries,
        getUserAiContext(user.id),
        resolveFeatureAIConfig('whats_next', modes.whats_next),
        'scheduled',
      )
    } catch (err) {
      log.error('ai', `Scheduled What's Next failed for user ${user.id}:`, err)
    }
  }
}

/**
 * Generate Insights for every eligible user.
 *
 * Uses `generateInsightsForUser` (which awaits completion) rather than the
 * fire-and-forget session starter, so users are genuinely processed one at a
 * time instead of all being kicked off at once.
 */
export async function runScheduledInsights(): Promise<void> {
  if (!isAIEnabled()) return

  for (const user of getScheduledUsers()) {
    const modes = getUserFeatureModes(user.id)
    if (modes.insights === 'off') continue

    try {
      const taskSummaries = buildTaskSummaries(user.id)
      if (taskSummaries.length === 0) continue

      await generateInsightsForUser(
        user.id,
        user.timezone,
        taskSummaries,
        getUserAiContext(user.id),
        'scheduled',
        resolveFeatureAIConfig('insights', modes.insights),
      )
    } catch (err) {
      log.error('ai', `Scheduled Insights failed for user ${user.id}:`, err)
    }
  }
}
