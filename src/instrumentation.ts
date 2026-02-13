/**
 * Next.js instrumentation hook
 *
 * Runs once when the server starts. Used to initialize cron jobs
 * for notifications, cleanup tasks, and the AI subsystem.
 *
 * Cron schedule:
 * - Every 1 min: heartbeat (overdue + critical + enrichment safety net)
 * - 3:00 AM daily: undo purge + Bubble generation (AI)
 * - 3:15 AM daily: Review generation (AI)
 * - 3:30 AM daily: trash purge
 * - 4:00 AM daily: completions purge
 * - 4:30 AM Sunday: stats purge
 * - 5:00 AM daily: AI activity purge
 */

import { log } from '@/lib/logger'

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const cron = (await import('node-cron')).default
    const { checkOverdueTasks } = await import('@/core/notifications/overdue-checker')
    const { checkCriticalTasks } = await import('@/core/notifications/critical-alerts')
    const { purgeOldUndoLogs } = await import('@/core/undo/purge')
    const { purgeOldTrash } = await import('@/core/tasks/purge-trash')
    const { purgeOldCompletions } = await import('@/core/tasks/purge-completions')
    const { purgeOldStats } = await import('@/core/stats/purge')
    const {
      initAI,
      isAIEnabled,
      processEnrichmentQueue,
      purgeOldAIActivity,
      initEnrichmentSlot,
      shutdownEnrichmentSlot,
    } = await import('@/core/ai')

    // Run initial notification checks after a short delay (existing pattern)
    setTimeout(async () => {
      log.info('notifications', 'Running initial overdue check')
      await checkOverdueTasks()
      await checkCriticalTasks()
    }, 5000)

    // Single 1-minute heartbeat cron replaces separate overdue (1m), critical (15m),
    // and enrichment (10s) crons. All three checks run sequentially each minute.
    cron.schedule('* * * * *', async () => {
      await checkOverdueTasks()
      await checkCriticalTasks()
      if (isAIEnabled()) {
        processEnrichmentQueue().catch((err) =>
          log.error('cron', 'Enrichment safety-net error:', err),
        )
      }
    })

    log.info('cron', 'Heartbeat cron started (every 1 min: overdue + critical + enrichment)')

    // --- Daily purge crons ---

    // Purge old undo logs daily at 3:00 AM
    cron.schedule('0 3 * * *', () => {
      log.info('cron', 'Running undo log purge')
      try {
        purgeOldUndoLogs()
      } catch (err) {
        log.error('cron', 'Undo log purge error:', err)
      }
    })

    // Purge old trash daily at 3:30 AM
    cron.schedule('30 3 * * *', () => {
      log.info('cron', 'Running trash purge')
      try {
        purgeOldTrash()
      } catch (err) {
        log.error('cron', 'Trash purge error:', err)
      }
    })

    // Purge old completions daily at 4:00 AM
    cron.schedule('0 4 * * *', () => {
      log.info('cron', 'Running completions purge')
      try {
        purgeOldCompletions()
      } catch (err) {
        log.error('cron', 'Completions purge error:', err)
      }
    })

    // Purge old daily stats weekly on Sunday at 4:30 AM
    cron.schedule('30 4 * * 0', () => {
      log.info('cron', 'Running daily stats purge')
      try {
        purgeOldStats()
      } catch (err) {
        log.error('cron', 'Daily stats purge error:', err)
      }
    })

    // Purge old AI activity logs daily at 5:00 AM
    cron.schedule('0 5 * * *', () => {
      log.info('cron', 'Running AI activity log purge')
      try {
        purgeOldAIActivity()
      } catch (err) {
        log.error('cron', 'AI activity log purge error:', err)
      }
    })

    log.info(
      'cron',
      'Scheduled cleanup jobs: undo (3:00 AM daily), trash (3:30 AM daily), completions (4:00 AM daily), stats (4:30 AM Sunday), AI activity (5:00 AM daily)',
    )

    // --- AI subsystem ---

    await initAI()
    if (isAIEnabled()) {
      // Warm up the enrichment slot (dedicated subprocess for enrichment queries)
      initEnrichmentSlot().catch((err) => {
        log.error('ai', 'Enrichment slot startup failed:', err)
      })

      // Bubble cron: generate recommendations for all active users at 3 AM
      // Uses Opus for the scheduled batch (no time pressure, maximum quality)
      cron.schedule('0 3 * * *', async () => {
        try {
          const { generateBubble, buildTaskSummaries, getUserAiContext } = await import('@/core/ai')
          const { getDb } = await import('@/core/db')
          const db = getDb()
          const users = db.prepare('SELECT id, timezone FROM users').all() as {
            id: number
            timezone: string
          }[]
          const cronModel = process.env.OPENTASK_AI_BUBBLE_MODEL || 'claude-opus-4-6'
          for (const user of users) {
            const tasks = buildTaskSummaries(user.id)
            if (tasks.length > 0) {
              const aiContext = getUserAiContext(user.id)
              await generateBubble(
                user.id,
                user.timezone,
                tasks,
                aiContext,
                cronModel,
                'scheduled',
              ).catch((err) => {
                log.error('cron', `Bubble generation failed for user ${user.id}:`, err)
              })
            }
          }
          log.info('cron', `Bubble cron: generated for ${users.length} users`)
        } catch (err) {
          log.error('cron', 'Bubble cron error:', err)
        }
      })

      // Review cron: score and annotate tasks for all active users at 3:15 AM
      // Runs after Bubble to avoid semaphore contention (both hold 1 slot sequentially)
      cron.schedule('15 3 * * *', async () => {
        try {
          const { generateReviewForUser, buildTaskSummaries, getUserAiContext } =
            await import('@/core/ai')
          const { getDb } = await import('@/core/db')
          const db = getDb()
          const users = db.prepare('SELECT id, timezone FROM users').all() as {
            id: number
            timezone: string
          }[]
          for (const user of users) {
            try {
              const tasks = buildTaskSummaries(user.id)
              if (tasks.length > 0) {
                const aiContext = getUserAiContext(user.id)
                await generateReviewForUser(user.id, user.timezone, tasks, aiContext, 'scheduled')
              }
            } catch (err) {
              log.error('cron', `Review generation failed for user ${user.id}:`, err)
            }
          }
          log.info('cron', `Review cron: generated for ${users.length} users`)
        } catch (err) {
          log.error('cron', 'Review cron error:', err)
        }
      })

      log.info(
        'ai',
        'AI enrichment slot initializing, Bubble cron (3 AM) + Review cron (3:15 AM) scheduled',
      )

      // Graceful shutdown: close enrichment slot on SIGTERM
      process.on('SIGTERM', () => {
        log.info('ai', 'SIGTERM received — shutting down enrichment slot')
        shutdownEnrichmentSlot()
      })
    }
  }
}
