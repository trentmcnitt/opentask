/**
 * Next.js instrumentation hook
 *
 * Runs once when the server starts. Used to initialize cron jobs
 * for notifications, cleanup tasks, and the AI subsystem.
 *
 * Cron schedule:
 * - Every 1 min: notification check (overdue tasks, all priorities)
 * - Every 1 min: enrichment safety net (AI, independent of notifications)
 * - 3:00 AM daily: undo purge + What's Next generation (AI)
 * - 3:15 AM daily: Insights generation (AI)
 * - 3:30 AM daily: trash purge
 * - 4:00 AM daily: completions purge
 * - 4:30 AM Sunday: stats purge
 * - 5:00 AM daily: AI activity purge
 * - 5:30 AM daily: webhook delivery purge
 */

import { log } from '@/lib/logger'

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const cron = (await import('node-cron')).default
    const { notifyError } = await import('@/lib/error-notify')
    const { checkOverdueTasks } = await import('@/core/notifications/overdue-checker')
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
      initQuickTakeSlot,
      shutdownQuickTakeSlot,
    } = await import('@/core/ai')

    // Run initial notification check after a short delay
    setTimeout(async () => {
      log.info('notifications', 'Running initial overdue check')
      await checkOverdueTasks()
    }, 5000)

    // --- Notification cron (independent of enrichment) ---
    // Guard with 30s timeout prevents permanent lockout if a check hangs.
    // A stuck enrichment process can never block notification delivery.
    let isNotificationRunning = false
    let notificationStartedAt = 0
    const NOTIFICATION_TIMEOUT_MS = 30_000
    cron.schedule('* * * * *', async () => {
      // If a previous run is stuck past the timeout, force-reset the guard
      if (isNotificationRunning) {
        const elapsed = Date.now() - notificationStartedAt
        if (elapsed > NOTIFICATION_TIMEOUT_MS) {
          log.warn(
            'notifications',
            `Previous notification check stuck for ${Math.round(elapsed / 1000)}s — resetting guard`,
          )
          isNotificationRunning = false
        } else {
          return
        }
      }
      isNotificationRunning = true
      notificationStartedAt = Date.now()
      try {
        await checkOverdueTasks()
      } catch (err) {
        log.error('notifications', 'Notification check error:', err)
        notifyError(
          'cron-failure',
          'Notification check failed',
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        isNotificationRunning = false
      }
    })
    log.info('cron', 'Notification cron started (every 1 min)')

    // --- Enrichment cron (independent of notifications) ---
    let isEnrichmentRunning = false
    cron.schedule('* * * * *', async () => {
      if (!isAIEnabled() || isEnrichmentRunning) return
      isEnrichmentRunning = true
      try {
        await processEnrichmentQueue()
      } catch (err) {
        log.error('cron', 'Enrichment safety-net error:', err)
        notifyError(
          'cron-failure',
          'Enrichment safety-net failed',
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        isEnrichmentRunning = false
      }
    })
    log.info('cron', 'Enrichment cron started (every 1 min)')

    // --- Daily purge crons ---

    /** Run a synchronous cron job with error logging and ntfy alerting. */
    function safeCronRun(label: string, fn: () => void): void {
      log.info('cron', `Running ${label}`)
      try {
        fn()
      } catch (err) {
        log.error('cron', `${label} error:`, err)
        notifyError(
          'cron-failure',
          `${label} failed`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    cron.schedule('0 3 * * *', () => safeCronRun('undo log purge', purgeOldUndoLogs))
    cron.schedule('30 3 * * *', () => safeCronRun('trash purge', purgeOldTrash))
    cron.schedule('0 4 * * *', () => safeCronRun('completions purge', purgeOldCompletions))
    cron.schedule('30 4 * * 0', () => safeCronRun('daily stats purge', purgeOldStats))
    cron.schedule('0 5 * * *', () => safeCronRun('AI activity log purge', purgeOldAIActivity))

    const { purgeOldDeliveries } = await import('@/core/webhooks/purge')
    cron.schedule('30 5 * * *', () => safeCronRun('webhook delivery purge', purgeOldDeliveries))

    log.info(
      'cron',
      'Scheduled cleanup jobs: undo (3:00 AM daily), trash (3:30 AM daily), completions (4:00 AM daily), stats (4:30 AM Sunday), AI activity (5:00 AM daily), webhook deliveries (5:30 AM daily)',
    )

    // --- AI subsystem ---

    await initAI()
    if (isAIEnabled()) {
      // Warm up the enrichment slot (dedicated subprocess for enrichment queries)
      initEnrichmentSlot().catch((err) => {
        log.error('ai', 'Enrichment slot startup failed:', err)
      })

      // Quick Take slot: disabled by default for alpha — cold path handles requests.
      // Uncomment when Quick Take is promoted from experimental.
      // initQuickTakeSlot().catch((err) => {
      //   log.error('ai', 'Quick Take slot startup failed:', err)
      // })

      // What's Next cron: generate recommendations for all active users at 3 AM
      // Uses Opus for the scheduled batch (no time pressure, maximum quality)
      cron.schedule('0 3 * * *', async () => {
        try {
          const { generateWhatsNext, buildTaskSummaries, getUserAiContext } =
            await import('@/core/ai')
          const { getDb } = await import('@/core/db')
          const db = getDb()
          const users = db.prepare('SELECT id, timezone FROM users').all() as {
            id: number
            timezone: string
          }[]
          const cronModel = process.env.OPENTASK_AI_WHATS_NEXT_MODEL || 'claude-opus-4-6'
          for (const user of users) {
            const tasks = buildTaskSummaries(user.id)
            if (tasks.length > 0) {
              const aiContext = getUserAiContext(user.id)
              await generateWhatsNext(
                user.id,
                user.timezone,
                tasks,
                aiContext,
                cronModel,
                'scheduled',
              ).catch((err) => {
                log.error('cron', `What's Next generation failed for user ${user.id}:`, err)
              })
            }
          }
          log.info('cron', `What's Next cron: generated for ${users.length} users`)
        } catch (err) {
          log.error('cron', "What's Next cron error:", err)
          notifyError(
            'cron-failure',
            "What's Next cron failed",
            err instanceof Error ? err.message : String(err),
          )
        }
      })

      // Insights cron: score and annotate tasks for all active users at 3:15 AM
      // Runs after What's Next to avoid semaphore contention (both hold 1 slot sequentially)
      cron.schedule('15 3 * * *', async () => {
        try {
          const { generateInsightsForUser, buildTaskSummaries, getUserAiContext } =
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
                await generateInsightsForUser(user.id, user.timezone, tasks, aiContext, 'scheduled')
              }
            } catch (err) {
              log.error('cron', `Insights generation failed for user ${user.id}:`, err)
            }
          }
          log.info('cron', `Insights cron: generated for ${users.length} users`)
        } catch (err) {
          log.error('cron', 'Insights cron error:', err)
          notifyError(
            'cron-failure',
            'Insights cron failed',
            err instanceof Error ? err.message : String(err),
          )
        }
      })

      log.info(
        'ai',
        "AI warm slot initializing, What's Next cron (3 AM) + Insights cron (3:15 AM) scheduled",
      )

      // Graceful shutdown: close warm slots on SIGTERM
      process.on('SIGTERM', () => {
        log.info('ai', 'SIGTERM received — shutting down warm slots')
        shutdownEnrichmentSlot()
        shutdownQuickTakeSlot()
      })
    }
  }
}
