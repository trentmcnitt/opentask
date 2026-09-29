/**
 * "AI finished" notification — one quiet push when a new task or reminder has
 * just been enriched (Trent, 2026-09-29: "Kind of does the same thing as the
 * Just added list, but you don't actually have to open the app at all").
 *
 * WHAT IT IS. The Just added card (`JustAddedCard`, `src/lib/just-added.ts`)
 * answers "did it land, where, and what did the AI make of it?" for tasks
 * added in the last 10 minutes — but only once you open the app. This push
 * answers the same question on the lock screen / Notification Center:
 *
 *   title: the task's cleaned title                    "Call the dentist"
 *   body:  "Added to <project>" + what the task now carries, in the card's
 *          formats: due (relative · absolute), priority, recurrence, labels.
 *          "Added to Work · Mon 9:00 AM · High · Weekly on Monday at 9:00 AM · errands"
 *          A reminder says its period instead of a project:
 *          "Added to Evening · Daily at 8:30 PM"
 *          Nothing filled in → just "Added to Inbox".
 *
 * It is PASSIVE on purpose: no sound, APNs `interruption-level: passive`,
 * priority 5, Web Push `urgency: low` + `silent`. It lands in Notification
 * Center without lighting the screen. No category, so it carries none of the
 * overdue notification's buttons; tapping opens the task (`/?task=<id>`, the
 * same deep link overdue notifications use). The collapse/thread id is
 * `enriched-<id>`, so one task never stacks two of these.
 *
 * WHEN (exactly once per task, and only for NEW tasks).
 * - Called from both enrichment entry points in `src/core/ai/enrichment.ts`
 *   (the fire-and-forget `enrichSingleTask` on create, and the per-minute
 *   `processEnrichmentQueue` safety net) after a SUCCESSFUL model run.
 *   Whichever path ran it, the task is claimed once (`claimTask`), so only one
 *   of them gets here.
 * - Only while the task is inside the Just added window
 *   (`JUST_ADDED_WINDOW_MS`, 10 minutes from `created_at`). The queue also
 *   picks up old tasks — a user re-enriching one by adding `ai-to-process`, a
 *   reprocessed `ai-failed` from last week — and those are not "just added".
 * - At most once per task id: `notified` below is checked and filled
 *   synchronously, before any await, so a retry or a second module instance
 *   (Next.js bundles instrumentation.ts and the routes separately — the same
 *   reason the enrichment pipeline's state is on globalThis) cannot double-send.
 *   The set is in memory; a restart empties it, which only matters if the same
 *   task is enriched again inside its 10 minutes after the restart.
 * - NOT on failure: the `ai-failed` path never calls this. Trent did not ask
 *   for failure alerts; the task still shows in the app with its raw title.
 * - NOT when the user's enrichment mode is off (no model ran — the caller
 *   passes nothing), for quotas (not "added" in the card's sense and the body
 *   would say nothing), or for done/deleted tasks.
 *
 * WHO. Users with `notifications_enabled` AND `enrichment_notifications_enabled`
 * (Settings → Notifications → "Notify when AI finishes a new task", default
 * on), never the demo user. Devices: every APNs device (iPhone, Mac, and the
 * watch app — the same set overdue alerts go to; `sendApnsEnrichedNotification`)
 * and every Web Push subscription. Never widget push tokens.
 */

import { getDb } from '@/core/db'
import { getTaskById } from '@/core/tasks'
import { listTimeSlots } from '@/core/time-slots'
import { log } from '@/lib/logger'
import { formatDueTimeParts } from '@/lib/format-date'
import { formatRRule } from '@/lib/format-rrule'
import { getPriorityOption } from '@/lib/priority'
import { JUST_ADDED_WINDOW_MS } from '@/lib/just-added'
import { assignSlot, type TimeSlot } from '@/lib/time-slot-assign'
import { isTracked } from '@/lib/track'
import { APP_URL } from '@/core/notifications/format'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import { sendApnsEnrichedNotification, isApnsConfigured } from '@/core/notifications/apns'
import type { Task } from '@/types'

const globalForEnrichmentNotify = globalThis as typeof globalThis & {
  /** taskId → epoch ms it was claimed for a notification. */
  __enrichmentNotified?: Map<number, number>
}
if (!globalForEnrichmentNotify.__enrichmentNotified) {
  globalForEnrichmentNotify.__enrichmentNotified = new Map<number, number>()
}
const notified = globalForEnrichmentNotify.__enrichmentNotified

/** Exported for testing. */
export function _resetEnrichmentNotifyState(): void {
  notified.clear()
}

/** The tap target — the same deep link overdue notifications open. */
export function enrichedTaskUrl(taskId: number): string {
  return `${APP_URL}/?task=${taskId}`
}

/** Collapse / thread / tag id: one per task, so a task never stacks two. */
export function enrichedCollapseId(taskId: number): string {
  return `enriched-${taskId}`
}

/**
 * Title and body for a freshly enriched task, from its CURRENT state (like the
 * Just added card, not from the list of fields the AI changed — for a new
 * title-only task those coincide, and the project line is then always there).
 *
 * Formats are the card's and the enrichment toast's: `formatDueTimeParts`
 * (relative · absolute), the priority option's label, `formatRRule`, labels
 * without the `ai-` processing ones.
 */
export function buildEnrichedNotificationContent(params: {
  task: Task
  projectName: string
  timezone: string
  slots: TimeSlot[]
}): { title: string; body: string } {
  const { task, projectName, timezone, slots } = params
  const parts: string[] = []

  if (task.is_reminder) {
    // A reminder lives in a period, not a project (REDESIGN-V03 §6), and its
    // due_at is bookkeeping for the next occurrence, never a deadline.
    const slot = assignSlot(task, slots, timezone)
    parts.push(`Added to ${slot?.label ?? 'Anytime'}`)
  } else {
    parts.push(`Added to ${projectName}`)
    if (task.due_at) {
      const due = formatDueTimeParts(task.due_at, timezone)
      parts.push(due.absolute ? `${due.relative} · ${due.absolute}` : due.relative)
    }
  }

  if (task.priority > 0) parts.push(getPriorityOption(task.priority).label)
  if (task.rrule) parts.push(formatRRule(task.rrule, task.anchor_time))

  const labels = task.labels.filter((l) => !l.startsWith('ai-'))
  if (labels.length > 0) parts.push(labels.join(', '))

  return { title: task.title, body: parts.join(' · ') }
}

interface NotifyUserRow {
  timezone: string
  is_demo: number
  notifications_enabled: number
  enrichment_notifications_enabled: number
}

/** Drop entries older than the window; a task past it can never qualify again. */
function pruneNotified(now: number): void {
  for (const [id, at] of notified) {
    if (at <= now - JUST_ADDED_WINDOW_MS) notified.delete(id)
  }
}

/**
 * Should this task get the notification, and if so, claim it. Synchronous from
 * the check to the `notified.set`, so two callers cannot both pass.
 */
function claimNotification(task: Task | null, userId: number, now: number): task is Task {
  if (!task || task.user_id !== userId) return false
  if (task.deleted_at || task.done) return false
  if (isTracked(task)) return false

  const created = Date.parse(task.created_at)
  if (Number.isNaN(created) || created <= now - JUST_ADDED_WINDOW_MS) return false

  pruneNotified(now)
  if (notified.has(task.id)) return false
  notified.set(task.id, now)
  return true
}

/**
 * Send the "AI finished" push for a task whose enrichment just succeeded.
 * Safe to call more than once for the same task; only the first call inside
 * the Just added window sends. See the header for the full rules.
 */
export async function notifyEnrichmentFinished(taskId: number, userId: number): Promise<void> {
  const webPush = isWebPushConfigured()
  const apns = isApnsConfigured()
  if (!webPush && !apns) return

  const db = getDb()
  const user = db
    .prepare(
      `SELECT timezone, is_demo, notifications_enabled, enrichment_notifications_enabled
       FROM users WHERE id = ?`,
    )
    .get(userId) as NotifyUserRow | undefined
  if (!user || user.is_demo || !user.notifications_enabled) return
  if (!user.enrichment_notifications_enabled) return

  const task = getTaskById(taskId)
  if (!claimNotification(task, userId, Date.now())) return

  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(task.project_id) as
    | { name: string }
    | undefined
  const { title, body } = buildEnrichedNotificationContent({
    task,
    projectName: project?.name ?? 'Inbox',
    timezone: user.timezone,
    slots: task.is_reminder ? listTimeSlots(userId) : [],
  })

  log.info('notifications', `Enrichment finished: notifying user ${userId} about task ${taskId}`)

  const sends: Promise<void>[] = []
  if (webPush) {
    sends.push(
      sendPushNotification(
        userId,
        {
          title,
          body,
          data: { url: enrichedTaskUrl(taskId), taskId },
          tag: enrichedCollapseId(taskId),
          silent: true,
        },
        { urgency: 'low' },
      ),
    )
  }
  if (apns) sends.push(sendApnsEnrichedNotification(userId, { title, body, taskId }))
  await Promise.allSettled(sends)
}
