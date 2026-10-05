/**
 * "AI couldn't process" notification — one quiet push when AI enrichment of a
 * task or reminder fails for good (Trent, 2026-10-05). Before this, a failure
 * was silent: the task kept its raw text as its title and a red `ai-failed`
 * label, and the user only found out by opening the app.
 *
 * WHAT IT SAYS.
 *
 *   title: "AI couldn't process a task"   ("… a reminder", "… a quota")
 *   body:  the text the user typed, as the AI was given it
 *          (`original_title`, falling back to `title` — the same text
 *          `enrichTask` enriches), cut at FAILED_BODY_MAX_CHARS with "…".
 *
 * The cut is a hard-limit guard, not a style choice: a title may be up to
 * 10,000 characters (`validation/task.ts`) and a long dictation is exactly
 * the kind of input that fails, but APNs refuses a payload over 4 KB. 200
 * characters is about what a banner shows anyway, and even at 4 bytes a
 * character (emoji) it leaves the payload far under the limit. No other
 * notification truncates, because none carries free text this long.
 *
 * DELIVERY is the "AI finished" push's (`enrichment-notify.ts`): a BANNER
 * WITHOUT SOUND (APNs `interruption-level: active`, priority 10, no `sound`,
 * no `badge`; Web Push `urgency: normal` + `silent`), APNs category
 * `TASK_ADDED` (Done and Delete; the apps route any task category by `taskId`,
 * so they needed no change), tap → `/?task=<id>` (the dashboard sends a
 * reminder on to `/reminders`, a quota to `/quotas`). Its collapse / thread /
 * tag id is `ai-failed-<id>` — never `enriched-<id>`, so it neither replaces
 * nor is replaced by an "AI finished" push for the same task.
 *
 * WHEN (one per failure transition).
 * - Called from both enrichment entry points in `src/core/ai/enrichment.ts`
 *   (the fire-and-forget `enrichSingleTask` on create or retry, and the
 *   per-minute `processEnrichmentQueue` safety net) right after the attempt
 *   that swapped `ai-to-process` → `ai-failed` (`handleFailure`, the second
 *   failed attempt — the only code that writes `ai-failed`). A first failure,
 *   which is retried, sends nothing.
 * - Not limited to the Just added window, unlike the success push: a failure
 *   is worth knowing about whenever it happens, e.g. a user retrying an old
 *   task. Tasks that were already `ai-failed` before this shipped are never
 *   alerted: nothing calls this except the transition.
 * - At most once per transition: `failureNotified` below is checked and filled
 *   synchronously, before any await, so a second call or a second module
 *   instance (Next.js bundles instrumentation.ts and the routes separately —
 *   hence globalThis) cannot double-send. The claim is released when the task
 *   is claimed for enrichment again (`releaseEnrichmentFailedNotice`, called
 *   from `claimTask`), so a retried task that fails again alerts again. No
 *   time window: the claim's lifetime is the failed state itself. A restart
 *   empties the map, which cannot matter: a task only fails again after being
 *   claimed again.
 * - The task must still be there and still `ai-failed` when this runs, not
 *   done and not deleted (the swap is skipped for a vanished task, and the
 *   user may have acted on it in the meantime).
 *
 * WHO. Users with `notifications_enabled`, never the demo user. NOT governed
 * by `enrichment_notifications_enabled` ("Notify when AI finishes a new
 * task"): Trent's decision — that switch is about the success push, and a
 * failure the user is never told about is the problem this solves. No switch
 * of its own. Devices: every APNs device (iPhone, Mac, watch) and every Web
 * Push subscription, as for the success push. Never widget push tokens.
 */

import { getDb } from '@/core/db'
import { getTaskById } from '@/core/tasks'
import { log } from '@/lib/logger'
import { isTracked } from '@/lib/track'
import { enrichedTaskUrl } from '@/core/notifications/enrichment-notify'
import { sendPushNotification, isWebPushConfigured } from '@/core/notifications/web-push'
import { sendApnsEnrichmentFailedNotification, isApnsConfigured } from '@/core/notifications/apns'
import type { Task } from '@/types'

/** Longest body, in characters (code points); see the header for why. */
export const FAILED_BODY_MAX_CHARS = 200

const globalForFailedNotify = globalThis as typeof globalThis & {
  /** Task ids whose current `ai-failed` state has already been announced. */
  __enrichmentFailedNotified?: Set<number>
}
if (!globalForFailedNotify.__enrichmentFailedNotified) {
  globalForFailedNotify.__enrichmentFailedNotified = new Set<number>()
}
const failureNotified = globalForFailedNotify.__enrichmentFailedNotified

/** Exported for testing. */
export function _resetEnrichmentFailedNotifyState(): void {
  failureNotified.clear()
}

/**
 * The task is being enriched again, so any earlier failure alert is spent: if
 * this attempt fails for good too, that is a new failure and gets its own.
 * Called from `claimTask` in `src/core/ai/enrichment.ts`.
 */
export function releaseEnrichmentFailedNotice(taskId: number): void {
  failureNotified.delete(taskId)
}

/** Collapse / thread / tag id: one per task, distinct from `enriched-<id>`. */
export function enrichmentFailedCollapseId(taskId: number): string {
  return `ai-failed-${taskId}`
}

/** Cut `text` to `max` code points, ending in "…" when anything was cut. */
function truncateText(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`
}

/** Title and body for a task whose enrichment failed for good. */
export function buildEnrichmentFailedNotificationContent(task: Task): {
  title: string
  body: string
} {
  const noun = task.is_reminder ? 'reminder' : isTracked(task) ? 'quota' : 'task'
  const text = (task.original_title || task.title).trim()
  return {
    title: `AI couldn't process a ${noun}`,
    body: truncateText(text, FAILED_BODY_MAX_CHARS),
  }
}

interface NotifyUserRow {
  is_demo: number
  notifications_enabled: number
}

/**
 * Should this failure be announced, and if so, claim it. Synchronous from the
 * check to the `add`, so two callers cannot both pass.
 */
export function claimFailureNotification(params: {
  task: Task | null
  userId: number
  user: NotifyUserRow | undefined
}): boolean {
  const { task, userId, user } = params
  if (!user || user.is_demo || !user.notifications_enabled) return false
  if (!task || task.user_id !== userId) return false
  if (task.deleted_at || task.done) return false
  if (!task.labels.includes('ai-failed')) return false

  if (failureNotified.has(task.id)) return false
  failureNotified.add(task.id)
  return true
}

/**
 * Send the "AI couldn't process" push for a task that was just marked
 * `ai-failed`. Safe to call more than once; only the first call per failure
 * sends. See the header for the full rules.
 */
export async function notifyEnrichmentFailed(taskId: number, userId: number): Promise<void> {
  const webPush = isWebPushConfigured()
  const apns = isApnsConfigured()
  if (!webPush && !apns) return

  const user = getDb()
    .prepare('SELECT is_demo, notifications_enabled FROM users WHERE id = ?')
    .get(userId) as NotifyUserRow | undefined
  const task = getTaskById(taskId)
  if (!claimFailureNotification({ task, userId, user }) || !task) return

  const { title, body } = buildEnrichmentFailedNotificationContent(task)

  log.info('notifications', `Enrichment failed: notifying user ${userId} about task ${taskId}`)

  const sends: Promise<void>[] = []
  if (webPush) {
    sends.push(
      sendPushNotification(
        userId,
        {
          title,
          body,
          data: { url: enrichedTaskUrl(taskId), taskId },
          tag: enrichmentFailedCollapseId(taskId),
          silent: true,
        },
        { urgency: 'normal' },
      ),
    )
  }
  if (apns) sends.push(sendApnsEnrichmentFailedNotification(userId, { title, body, taskId }))
  await Promise.allSettled(sends)
}
