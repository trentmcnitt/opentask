/**
 * Next.js instrumentation hook
 *
 * Runs once when the server starts. Used to initialize cron jobs
 * for notifications, cleanup tasks, and the AI subsystem.
 *
 * Cron schedule:
 * - Every 1 min: notification check (overdue tasks, all priorities)
 * - Every 1 min: time-slot reminder check (§6 — the slot notifies, not the item)
 * - Every 1 min: enrichment safety net (AI, independent of notifications)
 * - 3:00 AM UTC daily: undo purge
 * - 3:30 AM UTC daily: trash purge
 * - 4:00 AM UTC daily: completions purge
 * - 4:30 AM UTC Sunday: stats purge
 * - 5:00 AM UTC daily: AI activity purge
 * - 5:30 AM UTC daily: webhook delivery purge
 * - 3:00 AM UTC daily: What's Next generation (§7.4)
 * - 3:30 AM UTC daily: Insights generation (§7.4)
 */

import { log } from '@/lib/logger'

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const cron = (await import('node-cron')).default
    const { notifyError } = await import('@/lib/error-notify')
    const { checkOverdueTasks } = await import('@/core/notifications/overdue-checker')
    const { checkSlotReminders } = await import('@/core/notifications/slot-reminders')
    const { purgeOldUndoLogs } = await import('@/core/undo/purge')
    const { purgeOldTrash } = await import('@/core/tasks/purge-trash')
    const { purgeOldCompletions } = await import('@/core/tasks/purge-completions')
    const { purgeOldStats } = await import('@/core/stats/purge')
    const { rolloverTrackedPeriods } = await import('@/core/tasks/period-rollover')
    const {
      initAI,
      isAIEnabled,
      processEnrichmentQueue,
      purgeOldAIActivity,
      initEnrichmentSlot,
      shutdownEnrichmentSlot,
      shutdownQuickTakeSlot,
      isSdkAvailableSync,
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
        // §6: the time slot notifies, not the reminder. Same tick as the
        // overdue check because both are minute-boundary derived.
        await checkSlotReminders()
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

    // §5: a quota's period ends on its own. Every 5 minutes, and once at
    // startup, so a boundary crossed while the server was down is caught up.
    cron.schedule('*/5 * * * *', () => safeCronRun('track period rollover', rolloverTrackedPeriods))
    setTimeout(() => safeCronRun('track period rollover', rolloverTrackedPeriods), 10_000)

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
      // §7.4: What's Next and Insights generate on a daily schedule plus
      // on-demand refresh — never eagerly on page load. The read routes serve
      // cache only, so without these jobs the features would simply show "no
      // data yet" until the user pressed refresh.
      //
      // Staggered and run sequentially per user inside each job: Insights
      // scores the whole corpus in chunks, and overlapping it with What's Next
      // would put two heavy AI runs on the box at once.
      const { runScheduledWhatsNext, runScheduledInsights } = await import('@/core/ai/scheduled')

      /** Run an async cron job with error logging and ntfy alerting. */
      async function safeAsyncCronRun(label: string, fn: () => Promise<void>): Promise<void> {
        log.info('cron', `Running ${label}`)
        try {
          await fn()
        } catch (err) {
          log.error('cron', `${label} error:`, err)
          notifyError(
            'cron-failure',
            `${label} failed`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      cron.schedule('0 3 * * *', () => {
        void safeAsyncCronRun("What's Next generation", runScheduledWhatsNext)
      })
      cron.schedule('30 3 * * *', () => {
        void safeAsyncCronRun('Insights generation', runScheduledInsights)
      })
      log.info(
        'cron',
        "Scheduled AI generation: What's Next (3:00 AM daily), Insights (3:30 AM daily)",
      )

      // Warm slots use Claude Agent SDK subprocesses. Init them whenever SDK is
      // available, regardless of server default provider — any user with mode='sdk'
      // for a feature needs the slot, even if most users are on API mode.
      if (isSdkAvailableSync()) {
        initEnrichmentSlot().catch((err) => {
          log.error('ai', 'Enrichment slot startup failed:', err)
        })

        // Quick Take slot: disabled by default for alpha — cold path handles requests.
        // Uncomment when Quick Take is promoted from experimental.
        // initQuickTakeSlot().catch((err) => {
        //   log.error('ai', 'Quick Take slot startup failed:', err)
        // })
      } else {
        log.info('ai', 'SDK not available — warm slots disabled')
      }

      // Graceful shutdown: close warm slots on SIGTERM
      if (isSdkAvailableSync()) {
        process.on('SIGTERM', () => {
          log.info('ai', 'SIGTERM received — shutting down warm slots')
          shutdownEnrichmentSlot()
          shutdownQuickTakeSlot()
        })
      }
    }
  }
}
