/**
 * THE DEADLINES PAGE'S NAG (2026-10-22; plan-deadlines-page-1022.md §7 as
 * amended by the nag-map rulings of 10-22; docs/NOTIFICATIONS.md § The
 * deadlines nag).
 *
 * WHAT. A deadline task with no target sits on the task queue's deadlines
 * page from its lead day (`deadlinePlace`, src/lib/task-segments.ts). While
 * something there waits, ONE push per user reminds them to plan it — never
 * one per task — at the pace of the most demanding row waiting:
 *
 *  - the CONSIDERING rung of the nag ladder (nag-ladder.ts): the user's
 *    overdue tier ×2 at every priority — Urgent 10, High 30, Medium 120,
 *    Low 480, Unset 60 with the shipped tiers;
 *  - in the SAFETY NET (from the day before the deadline on, past it too) at
 *    least hourly (A2).
 *  Each counted row has its interval; the SHORTEST sets the pace, so adding a
 *  row can only make the nag come sooner. With the shipped tiers that is not
 *  always the highest priority's: an Unset row (60) outpaces a Medium (120).
 *
 * WHICH ROWS COUNT. The page's own rows (`getTaskSegments(…, { deadlineRows })`,
 * so membership, the switch, queue precedence and "seen" are the page's,
 * never re-derived here), then:
 *  - `waiting` only. Considering a row (the circle, "Considered all") marks it
 *    seen for the OpenTask day and it stops counting — EXCEPT in the safety
 *    net, where the page keeps it `waiting` (only a target or done clears it;
 *    ruling 3).
 *  - A DECKED row counts only in the safety net: a deck says "I'll look at it
 *    that day", which answers the nag until the deadline is a day away.
 *  - A row whose own Nag is OFF (`auto_snooze_minutes = 0`) never counts, in
 *    the safety net too: "off" means off (coordinator ruling, 2026-10-22). It
 *    stays on the page; only the push leaves it out. Any other per-task
 *    value is the overdue nag's and does not change this nag's pace.
 *
 * NO QUIET HOURS (ruling 2). There is no Wake–Sleep gate: like the overdue
 * nag, this one sends whenever it is due. A page row starts waiting at the
 * OpenTask day's start (the rollover time) or the moment a deadline is set
 * inside its lead time, and the first nag goes then.
 *
 * HOW. A silent banner on both channels (no sound; APNs `active`, never
 * critical — ruling 4, 5), counts only — never a title (ruling 5: titles on
 * single-task pushes, counts on multi-task ones): "2 deadlines to plan ·
 * nearest Fri", "Deadline tomorrow: 1 unplanned". Never in the badge. APNs
 * collapse id / Web Push tag `deadlines-page`, so each replaces the last;
 * `data.kind: "deadlines"` (APNs) and `/?tasks=deadlines` (Web Push) open the
 * task queue on the deadlines page.
 *
 * WHEN EXACTLY: `nag_sends` (user, 'deadlines-page', last_sent_at) — send
 * when the whole minutes since the last send reach the interval. Restart-safe
 * (a restart neither repeats nor skips a send), a double tick sends once
 * (the claim is a compare-and-swap), and after downtime the first tick sends.
 * A priority rising mid-interval sends as soon as the new, shorter interval
 * has passed since the last send.
 *
 * Off: the task-queue switch off (no page), notifications off, the demo user
 * (`notifiableUsers`). Split like slot-nags.ts: a read-only decision
 * (`pendingDeadlineNags`) and the sender (`checkDeadlineNags`).
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { APP_URL } from '@/core/notifications/format'
import { nagIntervalMinutes, userNagTiers, type NagTiers } from './nag-ladder'
import { claimNagSend, nagSendDue } from './nag-sends'
import { notifiableUsers } from './notifiable-users'
import { isWebPushConfigured, sendPushNotification } from './web-push'
import { DEADLINES_NAG_COLLAPSE_ID, isApnsConfigured, sendApnsDeadlinesNag } from './apns'
import { getTaskSegments, type SegmentTask } from '@/core/tasks/task-segments'
import { taskQueueEnabled } from '@/core/tasks/task-queue'
import { rolloverTimeForUser } from '@/core/tasks/rollover-time'
import { deadlineDay, openTaskToday, shiftDay } from '@/lib/task-segments'
import { tasksPanelPath } from '@/lib/tasks-panel-link'

/** The `nag_sends` key of this nag. */
export const DEADLINES_NAG_KEY = 'deadlines-page'

/** Where the nag opens: the dashboard's Tasks card on the deadlines page. */
export const DEADLINES_PAGE_PATH = tasksPanelPath('deadlines')

/** The page rows that keep the nag going (see the header). Pure. */
export function countedDeadlineRows(rows: SegmentTask[]): SegmentTask[] {
  return rows.filter(
    (r) =>
      r.state === 'waiting' &&
      !r.left &&
      r.task.auto_snooze_minutes !== 0 &&
      (!r.task.on_deck_day || r.safetyNet === true),
  )
}

/** Minutes between nags for these rows — the shortest row's — or null (no rows). Pure. */
export function deadlineNagInterval(rows: SegmentTask[], tiers: NagTiers): number | null {
  let best: number | null = null
  for (const row of rows) {
    const minutes = nagIntervalMinutes('deadlines', row.task.priority, tiers, {
      safetyNet: row.safetyNet === true,
    })
    if (minutes > 0 && (best === null || minutes < best)) best = minutes
  }
  return best
}

export interface DeadlineNagContent {
  title: string
  body: string
}

type NetWord = 'passed' | 'today' | 'tomorrow'

/** How close a safety-net deadline is, on the OpenTask day (L9). */
function netWord(day: string, today: string): NetWord {
  if (day < today) return 'passed'
  return day === today ? 'today' : 'tomorrow'
}

const NET_RANK: Record<NetWord, number> = { passed: 0, today: 1, tomorrow: 2 }

/** "Fri" within the week ahead, else "Oct 30" (the deadline's OpenTask day). */
function dayName(day: string, today: string, timezone: string): string {
  const d = DateTime.fromISO(day, { zone: timezone })
  return day <= shiftDay(today, 6, timezone) ? d.toFormat('ccc') : d.toFormat('LLL d')
}

/**
 * The banner, counts only (pure). In the safety net it names the closest
 * deadline's day: "Deadline tomorrow: 1 unplanned", "Deadlines today: 2
 * unplanned", "Deadline passed: 1 unplanned", with " · N more to plan" for the
 * other counted rows. Otherwise "2 deadlines to plan · nearest Fri".
 */
export function deadlineNagContent(
  rows: SegmentTask[],
  timezone: string,
  now: Date,
  rolloverTime: string | null,
): DeadlineNagContent {
  const today = openTaskToday(timezone, now, rolloverTime)
  const days = rows.map((r) => deadlineDay(r.task.deadline_at!, timezone, rolloverTime))
  const net = rows.flatMap((r, i) => (r.safetyNet ? [netWord(days[i], today)] : []))
  if (net.length > 0) {
    const word = net.reduce((a, b) => (NET_RANK[b] < NET_RANK[a] ? b : a))
    const n = net.filter((w) => w === word).length
    const more = rows.length - n
    const head = `${n === 1 ? 'Deadline' : 'Deadlines'} ${word}: ${n} unplanned`
    return { title: 'Deadlines', body: more > 0 ? `${head} · ${more} more to plan` : head }
  }
  const nearest = days.reduce((a, b) => (b < a ? b : a))
  const count = rows.length === 1 ? '1 deadline' : `${rows.length} deadlines`
  return {
    title: 'Deadlines',
    body: `${count} to plan · nearest ${dayName(nearest, today, timezone)}`,
  }
}

/**
 * Whether the user has any task the page could hold — one statement, so the
 * page itself is only built for a user with a target-less deadline task.
 */
function hasDeadlineCandidate(userId: number): boolean {
  return !!getDb()
    .prepare(
      `SELECT 1 FROM tasks
       WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
         AND deadline_at IS NOT NULL AND due_at IS NULL
         AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1
       LIMIT 1`,
    )
    .get(userId)
}

/** The shortest interval any page row could set for these tiers (the safety net's rungs). */
export function fastestDeadlineInterval(tiers: NagTiers): number {
  const rungs = [0, 1, 2, 3, 4].map((p) =>
    nagIntervalMinutes('deadlines', p, tiers, { safetyNet: true }),
  )
  return Math.max(1, Math.min(...rungs))
}

export interface PendingDeadlineNag {
  userId: number
  intervalMinutes: number
  /** The rows the nag speaks for. */
  count: number
  content: DeadlineNagContent
}

/** Every deadlines nag due this minute, at most one per user. Read-only. */
export function pendingDeadlineNags(now: Date = new Date()): PendingDeadlineNag[] {
  if (!taskQueueEnabled()) return []
  const pending: PendingDeadlineNag[] = []
  for (const user of notifiableUsers()) {
    if (!hasDeadlineCandidate(user.id)) continue
    const tiers = userNagTiers(user.id)
    // Not due even at the fastest pace any row could set: skip building the
    // page (every open task, Upcoming's rrule walks) this minute.
    if (!nagSendDue(user.id, DEADLINES_NAG_KEY, fastestDeadlineInterval(tiers), now)) continue
    const page =
      getTaskSegments(user.id, user.timezone, now, {
        queuePanels: true,
        deadlineRows: true,
      }).find((s) => s.horizon === 'deadlines')?.tasks ?? []
    const rows = countedDeadlineRows(page)
    const interval = deadlineNagInterval(rows, tiers)
    if (interval === null) continue
    if (!nagSendDue(user.id, DEADLINES_NAG_KEY, interval, now)) continue
    const content = deadlineNagContent(rows, user.timezone, now, rolloverTimeForUser(user.id))
    pending.push({ userId: user.id, intervalMinutes: interval, count: rows.length, content })
  }
  return pending
}

/** Deliver one nag on both channels. Failures are logged per channel. */
async function sendDeadlinesNag(userId: number, content: DeadlineNagContent): Promise<void> {
  const sends: Promise<void>[] = []
  if (isWebPushConfigured()) {
    sends.push(
      sendPushNotification(
        userId,
        {
          ...content,
          data: { url: `${APP_URL}${DEADLINES_PAGE_PATH}` },
          tag: DEADLINES_NAG_COLLAPSE_ID,
          silent: true,
        },
        { urgency: 'normal' },
      ),
    )
  }
  if (isApnsConfigured()) sends.push(sendApnsDeadlinesNag(userId, content))
  for (const r of await Promise.allSettled(sends)) {
    if (r.status === 'rejected') log.error('notifications', 'Deadlines nag error:', r.reason)
  }
}

/** Cron entry point — the minute tick, after the slot nag. */
export async function checkDeadlineNags(nowOverride?: Date): Promise<void> {
  if (!isWebPushConfigured() && !isApnsConfigured()) return
  try {
    const now = nowOverride ?? new Date()
    for (const nag of pendingDeadlineNags(now)) {
      // Claim before sending: a lost claim means this minute already sent.
      if (!claimNagSend(nag.userId, DEADLINES_NAG_KEY, nag.intervalMinutes, now)) continue
      log.info(
        'notifications',
        `Deadlines nag for user ${nag.userId}: ${nag.count} row(s), every ${nag.intervalMinutes} min`,
      )
      await sendDeadlinesNag(nag.userId, nag.content)
    }
  } catch (err) {
    log.error('notifications', 'Deadlines nag checker error:', err)
  }
}
