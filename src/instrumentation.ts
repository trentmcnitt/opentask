/**
 * Next.js instrumentation hook
 *
 * Runs once when the server starts. Used to initialize cron jobs
 * for the notification service and cleanup tasks.
 */

import { log } from '@/lib/logger'

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const cron = (await import('node-cron')).default
    const { initNotifications } = await import('@/core/notifications')
    const { purgeOldUndoLogs } = await import('@/core/undo/purge')
    const { purgeOldTrash } = await import('@/core/tasks/purge-trash')
    const { purgeOldCompletions } = await import('@/core/tasks/purge-completions')
    const { purgeOldStats } = await import('@/core/stats/purge')
    const { initAI, isAIEnabled, processEnrichmentQueue, resetStuckTasks, purgeOldAIActivity } =
      await import('@/core/ai')

    // Start notification service
    initNotifications()

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

    // AI enrichment
    await initAI()
    if (isAIEnabled()) {
      // Reset tasks stuck in 'processing' from a previous server restart
      resetStuckTasks()

      const intervalSeconds = parseInt(process.env.OPENTASK_AI_ENRICHMENT_INTERVAL || '10', 10)
      cron.schedule(`*/${intervalSeconds} * * * * *`, () => {
        processEnrichmentQueue().catch((err) => {
          log.error('cron', 'AI enrichment queue error:', err)
        })
      })
      log.info('ai', `AI enrichment cron started (every ${intervalSeconds}s)`)
    }
  }
}
