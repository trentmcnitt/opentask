/**
 * Next.js instrumentation hook
 *
 * Runs once when the server starts. Used to initialize cron jobs
 * for notifications, cleanup tasks, and the AI subsystem.
 *
 * Cron schedule:
 * - Every 1 min: the notification tick (src/core/notifications/minute-tick.ts),
 *   one coordinated pass with ONE alerting push per user (tick.ts):
 *   - overdue tasks, all priorities (repeats on clock marks, nag-marks.ts)
 *   - time-slot reminder check (§6 — the slot notifies, not the item)
 *   - unfinished-slot nag (the nag ladder's pace, on clock marks; slot-nags.ts)
 *   - named reminder pushes, Medium+ reminders by name (reminder-nags.ts)
 *   - deadlines-page nag (paced by the nag ladder, sent when `nag_sends` says
 *     it is due; see deadline-nags.ts)
 * - Every 1 min: enrichment safety net (AI, independent of notifications)
 * - Every 1 min: persist attempts (§7 — reads are already exact; this keeps
 *   the stored columns current, see src/core/tasks/attempts.ts)
 * - Every 1 min, FIRST in both minute jobs above: the task queue's rollover
 *   (src/core/tasks/task-rollover.ts; once per user per OpenTask day)
 * - 3:00 AM UTC daily: undo purge
 * - 3:30 AM UTC daily: trash purge
 * - 4:00 AM UTC daily: completions purge
 * - 4:30 AM UTC Sunday: stats purge
 * - 4:45 AM UTC Sunday: slot nag purge
 * - 4:50 AM UTC Sunday: named reminder push records of reminders that are gone
 * - 5:00 AM UTC daily: AI activity purge
 * - 5:30 AM UTC daily: webhook delivery purge
 * - 3:00 AM UTC daily: What's Next generation (§7.4) — SHELVED (2026-10-22)
 * - 3:30 AM UTC daily: Insights generation (§7.4) — SHELVED (2026-10-22)
 *   Both are scheduled only with OPENTASK_AI_UNSHELVE=1 (src/core/ai/shelved.ts).
 *
 * Also registers the WidgetKit push sync listener (not a cron — reacts to
 * emitSyncEvent, coalesced per widget push token: 2s settle, then at most one
 * push per 5 min window on iOS/watchOS, held through quiet hours). See
 * src/core/notifications/widget-push.ts.
 */

import { log } from '@/lib/logger'
import { markServerProcess } from '@/core/db/process-role'

type NotifyError = (kind: 'cron-failure', title: string, detail: string) => unknown

/** A runner for synchronous cron jobs, with error logging and ntfy alerting. */
function makeSafeCronRun(notifyError: NotifyError) {
  return function safeCronRun(label: string, fn: () => void): void {
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
}

/**
 * THE TASK ROLLOVER (task queue PR 2; src/core/tasks/task-rollover.ts), run
 * at the HEAD of both minute jobs — the notification check and the attempts
 * persist — rather than as a third job of its own. node-cron gives no order
 * between jobs due the same minute, and at 6:30 the order matters: a task a
 * sweep marked for the queue has its target AT the rollover, so a
 * notification check (or an attempts persist) that ran first would nag it
 * (or count the new day as an attempt) a moment before the strip. The job is
 * synchronous and runs once per user per OpenTask day (a conditional stamp),
 * so whichever minute job fires first does the work and the other finds
 * nothing. Its own try/catch: a failure never blocks either job. Runs with
 * the switch off too (it then only advances `last_rollover_date`).
 */
function makeTaskRollover(runTaskRollover: () => unknown, notifyError: NotifyError): () => void {
  return () => {
    try {
      runTaskRollover()
    } catch (err) {
      log.error('cron', 'Task rollover error:', err)
      notifyError(
        'cron-failure',
        'Task rollover failed',
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

/**
 * THE NOTIFICATION TICK — what the minute cron and the startup check both run
 * (minute-tick.ts, tick.ts): the task rollover first (`makeTaskRollover`; a
 * restart at 06:40 after downtime across 06:30 strips what a sweep marked
 * for 06:30 before anything nags it), then every sender in one coordinated
 * pass — the overdue checker, the slot-open push (§6: the time slot
 * notifies, not the reminder), the slot nag (the §6 exception, after the
 * slot-open push so it stands down when a slot opens this minute) and the
 * deadlines-page nag; one alerting push per user per minute.
 *
 * One run at a time: a run still going when the next is due is skipped, and
 * a guard stuck past 30 s is reset so a hung check can never lock delivery
 * out. A stuck enrichment process can never block notification delivery.
 */
function makeNotificationTick(
  runMinuteTick: () => Promise<void>,
  taskRollover: () => void,
  notifyError: NotifyError,
): () => Promise<void> {
  let running = false
  let startedAt = 0
  const TIMEOUT_MS = 30_000
  return async () => {
    if (running) {
      const elapsed = Date.now() - startedAt
      if (elapsed <= TIMEOUT_MS) return
      log.warn(
        'notifications',
        `Previous notification check stuck for ${Math.round(elapsed / 1000)}s — resetting guard`,
      )
    }
    running = true
    startedAt = Date.now()
    taskRollover()
    try {
      await runMinuteTick()
    } catch (err) {
      log.error('notifications', 'Notification check error:', err)
      notifyError(
        'cron-failure',
        'Notification check failed',
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      running = false
    }
  }
}

/**
 * Attempts (spec §7): keep the stored count current every minute — reads are
 * already exact (src/core/tasks/attempts.ts). Its own job, so a failure here
 * never blocks a notification. Quiet: no per-run info log.
 */
async function startAttemptsCron(
  schedule: (expr: string, fn: () => void) => unknown,
  notifyError: NotifyError,
  taskRollover: () => void,
) {
  const { persistAttempts } = await import('@/core/tasks/attempts')
  schedule('* * * * *', () => {
    taskRollover()
    try {
      persistAttempts()
    } catch (err) {
      log.error('cron', 'Attempts persist error:', err)
      notifyError(
        'cron-failure',
        'Attempts persist failed',
        err instanceof Error ? err.message : String(err),
      )
    }
  })
}

/**
 * §7.4: What's Next and Insights generate on a daily schedule plus on-demand
 * refresh — never eagerly on page load. The read routes serve cache only, so
 * without these jobs the features would simply show "no data yet" until the
 * user pressed refresh.
 *
 * Staggered and run sequentially per user inside each job: Insights scores the
 * whole corpus in chunks, and overlapping it with What's Next would put two
 * heavy AI runs on the box at once.
 *
 * SHELVED (2026-10-22): called only with OPENTASK_AI_UNSHELVE=1.
 */
async function scheduleWhatsNextAndInsights(
  schedule: (expr: string, fn: () => void) => unknown,
  notifyError: NotifyError,
) {
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

  schedule('0 3 * * *', () => {
    void safeAsyncCronRun("What's Next generation", runScheduledWhatsNext)
  })
  schedule('30 3 * * *', () => {
    void safeAsyncCronRun('Insights generation', runScheduledInsights)
  })
  log.info('cron', "Scheduled AI generation: What's Next (3:00 AM daily), Insights (3:30 AM daily)")
}

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // FIRST, before any await: this process is the server, so its database
    // runs the task-queue switch's data steps (src/core/db/process-role.ts).
    // Next awaits register() before serving any request, and nothing above
    // this line opens the database.
    markServerProcess()
    const cron = (await import('node-cron')).default
    const { notifyError } = await import('@/lib/error-notify')
    const { runMinuteTick } = await import('@/core/notifications/minute-tick')
    const { purgeOldSlotNags } = await import('@/core/notifications/slot-nags')
    const { purgeGoneReminderNags } = await import('@/core/notifications/reminder-nags')
    const { purgeOldPromptNags } = await import('@/core/notifications/prompt-nags')
    const { initWidgetPushSync } = await import('@/core/notifications/widget-push')
    const { purgeOldUndoLogs } = await import('@/core/undo/purge')
    const { purgeOldTrash } = await import('@/core/tasks/purge-trash')
    const { purgeOldCompletions } = await import('@/core/tasks/purge-completions')
    const { purgeOldStats } = await import('@/core/stats/purge')
    const { rolloverTrackedPeriods } = await import('@/core/tasks/period-rollover')
    const { runTaskRollover } = await import('@/core/tasks/task-rollover')
    const taskRollover = makeTaskRollover(() => runTaskRollover(), notifyError)
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

    const notificationTick = makeNotificationTick(runMinuteTick, taskRollover, notifyError)

    // The startup check, a short delay after boot: the same guarded minute
    // tick as the cron (review of #362). It used to run the overdue checker
    // alone, outside the guard, so a boot at hh:mm:55 sent that minute's
    // overdue pushes twice; now the guard keeps the two runs apart in this
    // process and the tick's minute claim (`claimTickMinute`) keeps any run
    // from sending what a run of the same minute already sent — this process
    // or the one a deploy just replaced.
    setTimeout(() => {
      log.info('notifications', 'Running initial notification check')
      void notificationTick()
    }, 5000)

    // --- Notification cron (independent of enrichment) ---
    cron.schedule('* * * * *', () => notificationTick())
    log.info('cron', 'Notification cron started (every 1 min)')
    await startAttemptsCron((expr, fn) => cron.schedule(expr, fn), notifyError, taskRollover)

    // --- WidgetKit push sync (event-driven, not a cron) ---
    initWidgetPushSync()

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
    const safeCronRun = makeSafeCronRun(notifyError)

    // §5: a quota's period ends on its own. Every 5 minutes, and once at
    // startup, so a boundary crossed while the server was down is caught up.
    cron.schedule('*/5 * * * *', () => safeCronRun('track period rollover', rolloverTrackedPeriods))
    setTimeout(() => safeCronRun('track period rollover', rolloverTrackedPeriods), 10_000)

    cron.schedule('0 3 * * *', () => safeCronRun('undo log purge', purgeOldUndoLogs))
    cron.schedule('30 3 * * *', () => safeCronRun('trash purge', purgeOldTrash))
    cron.schedule('0 4 * * *', () => safeCronRun('completions purge', purgeOldCompletions))
    cron.schedule('30 4 * * 0', () => safeCronRun('daily stats purge', purgeOldStats))
    cron.schedule('45 4 * * 0', () => safeCronRun('slot nag purge', purgeOldSlotNags))
    cron.schedule('50 4 * * 0', () => {
      safeCronRun('reminder push record purge', purgeGoneReminderNags)
      // The named quota-prompt pushes' rows (prompt-nags.ts): each names one
      // OpenTask day, so a row two days old is done with.
      safeCronRun('prompt push record purge', () => purgeOldPromptNags())
    })
    cron.schedule('0 5 * * *', () => safeCronRun('AI activity log purge', purgeOldAIActivity))

    const { purgeOldDeliveries } = await import('@/core/webhooks/purge')
    cron.schedule('30 5 * * *', () => safeCronRun('webhook delivery purge', purgeOldDeliveries))

    log.info(
      'cron',
      'Scheduled cleanup jobs: undo (3:00 AM daily), trash (3:30 AM daily), completions (4:00 AM daily), stats (4:30 AM Sunday), slot nags (4:45 AM Sunday), reminder push records (4:50 AM Sunday), AI activity (5:00 AM daily), webhook deliveries (5:30 AM daily)',
    )

    // --- AI subsystem ---

    await initAI()
    if (isAIEnabled()) {
      // SHELVED (2026-10-22): What's Next and Insights are shelved until they
      // are redesigned (src/core/ai/shelved.ts). Off, nothing is scheduled —
      // one line at startup, nothing nightly.
      const { shelvedAiFeaturesOn } = await import('@/core/ai/shelved')
      if (shelvedAiFeaturesOn()) {
        await scheduleWhatsNextAndInsights((expr, fn) => cron.schedule(expr, fn), notifyError)
      } else {
        log.info('cron', "What's Next and Insights are shelved (OPENTASK_AI_UNSHELVE unset)")
      }

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

      // Graceful shutdown: close warm slots on SIGTERM (the open sync streams
      // are ended by their own handler, below, AI or not)
      if (isSdkAvailableSync()) {
        process.on('SIGTERM', () => {
          log.info('ai', 'SIGTERM received — shutting down warm slots')
          shutdownEnrichmentSlot()
          shutdownQuickTakeSlot()
        })
      }
    }

    // Graceful shutdown: end every open sync stream on SIGTERM, so Next's
    // server.close() can finish and the process exits at once. Without it an
    // open tab held the old process until systemd's 90 s stop timeout killed
    // it (src/lib/sync-events.ts § OPEN STREAMS AND SHUTDOWN). Registered
    // whatever the AI settings are.
    const { closeAllSyncStreams } = await import('@/lib/sync-events')
    process.on('SIGTERM', () => {
      const n = closeAllSyncStreams()
      log.info('sync', `SIGTERM received: ended ${n} open sync stream${n === 1 ? '' : 's'}`)
    })
  }
}
