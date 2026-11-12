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
 *  Each counted row has its interval; the one whose next clock mark comes
 *  FIRST sets the pace (`nagPace`; with the shipped rungs, the shortest), so
 *  adding a row can only make the nag come sooner. With the shipped tiers
 *  that is not always the highest priority's: an Unset row (60) outpaces a
 *  Medium (120).
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
 * WHEN EXACTLY: `nag_sends` (user, 'deadlines-page', last_sent_at). The first
 * nag goes the moment something waits (exact); each repeat on the CLOCK MARK
 * nearest the last send plus the interval (nag-marks.ts, Trent 2026-10-26: a
 * row waiting from 03:00 at Unset nags 03:00, 04:00, 05:00 …; one set at
 * 10:07 at High nags 10:07, 10:30, 11:00 …). Restart-safe (a restart neither
 * repeats nor skips a send), a double tick sends once (the claim is a
 * compare-and-swap), and after downtime the first tick sends. A priority
 * rising mid-interval sends as soon as the new rung's mark has come.
 *
 * ONE ALERT PER TICK (tick.ts): the nag is silent by its own rule, so it
 * never leads a minute in which an overdue push would sound (Trent,
 * 2026-10-26); it then goes out passive on APNs (Web Push is silent anyway).
 * Among silent sends only, a safety-net nag ranks above the period pushes, a
 * plain one last of all.
 *
 * Off: the task-queue switch off (no page), notifications off, the demo user
 * (`notifiableUsers`). Split like slot-nags.ts: a read-only decision
 * (`pendingDeadlineNags`) and the sender (`checkDeadlineNags`).
 */

import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { APP_URL, deadlinePushLabel } from '@/core/notifications/format'
import { nagIntervalMinutes, userNagTiers, type NagTiers } from './nag-ladder'
import { claimNagSend, nagPace, nagSendDue } from './nag-sends'
import {
  runTick,
  type Channels,
  type Delivery,
  type SourcePlan,
  type TickSend,
  type TickSource,
} from './tick'
import { notifiableUsers } from './notifiable-users'
import { mergeSettled, type DeliveryResult } from './delivery-result'
import { isWebPushConfigured, sendPushNotification } from './web-push'
import { DEADLINES_NAG_COLLAPSE_ID, isApnsConfigured, sendApnsDeadlinesNag } from './apns'
import { getCheckInDay, getTaskSegments, type SegmentTask } from '@/core/tasks/task-segments'
import { getAnchorTimes } from '@/core/users/anchor-times'
import { addDays, dayStartMoment, localMoment } from '@/lib/opentask-day'
import { taskQueueEnabled } from '@/core/tasks/task-queue'
import { rolloverTimeForUser } from '@/core/tasks/rollover-time'
import {
  comingDueDay,
  deadlineDay,
  latestRound,
  openTaskToday,
  shiftDay,
  type HorizonValue,
} from '@/lib/task-segments'
import { tasksPanelPath } from '@/lib/tasks-panel-link'

/** The `nag_sends` key of this nag. */
export const DEADLINES_NAG_KEY = 'deadlines-page'

/** Where the nag opens: the dashboard's Tasks card on the deadlines page. */
export const DEADLINES_PAGE_PATH = tasksPanelPath('deadlines')

/**
 * RULE DL-NAG: One silent push per user while a page row waits. It never goes per task, never
 *   counts in the badge and has no quiet hours. A row counts when it is waiting, has not left and
 *   its Nag is not off. A decked row counts only in the safety net: legacy only since 2026-11-07,
 *   when decks stopped at D−2 (a deck made before then, or one a later deadline move left in the
 *   net). An open-window row (START-3) never counts toward the pace or starts the nag; while it
 *   waits it is added to the count in the words (START-6). The pace is the overdue tier ×2, at
 *   least hourly in the safety net.
 * Why: One push per user reminds them to plan, never one per task (the module comment).
 * Ruling: Nag-map rulings 2-5 (2026-10-22); coordinator ruling 2026-10-22 ('off means off'); Trent
 *   2026-10-22 (one ladder ×2).
 */
/** The page rows that keep the nag going (see the header). Pure. */
export function countedDeadlineRows(rows: SegmentTask[]): SegmentTask[] {
  return rows.filter(
    (r) =>
      r.state === 'waiting' &&
      !r.left &&
      // START-6: an open-window row never starts or paces the nag.
      r.window !== 'open' &&
      r.task.auto_snooze_minutes !== 0 &&
      (!r.task.on_deck_day || r.safetyNet === true),
  )
}

/**
 * The OPEN-WINDOW rows waiting on the page with their Nag on (START-6): they
 * add to the nag's count and keep its banner standing, and never set its
 * pace. Pure.
 */
export function openDeadlineRows(rows: SegmentTask[]): SegmentTask[] {
  return rows.filter(
    (r) =>
      r.state === 'waiting' &&
      !r.left &&
      r.window === 'open' &&
      r.task.auto_snooze_minutes !== 0 &&
      !r.task.on_deck_day,
  )
}

/**
 * Each counted row's rung (minutes), distinct — empty for no rows. Pure. The
 * pace is the rung whose next clock mark comes first (`nagPace`).
 */
export function deadlineNagRungs(rows: SegmentTask[], tiers: NagTiers): number[] {
  const rungs = new Set<number>()
  for (const row of rows) {
    const minutes = nagIntervalMinutes('deadlines', row.task.priority, tiers, {
      safetyNet: row.safetyNet === true,
    })
    if (minutes > 0) rungs.add(minutes)
  }
  return [...rungs]
}

export interface DeadlineNagContent {
  title: string
  body: string
  /**
   * The APNs label line (2026-11-07, `deadlinePushLabel`): "Deadline · due
   * Sun", or in the safety net "Deadline · due tomorrow" / "due today" /
   * "passed". Web Push has none.
   */
  subtitle: string
}

type NetWord = 'passed' | 'today' | 'tomorrow'

/**
 * How close a safety-net deadline is, on the OpenTask day (L9) — and, today,
 * by the clock: a deadline earlier today that has gone by is "passed", not
 * "today" (Trent, 2026-10-30: an 11:30 deadline read "Deadline today" at 11:50).
 */
function netWord(day: string, today: string, deadlineAt: string, now: Date): NetWord {
  if (day < today) return 'passed'
  if (day === today) return Date.parse(deadlineAt) <= now.getTime() ? 'passed' : 'today'
  return 'tomorrow'
}

const NET_RANK: Record<NetWord, number> = { passed: 0, today: 1, tomorrow: 2 }

/** "Fri" within the week ahead, else "Oct 30" (the deadline's OpenTask day). */
function dayName(day: string, today: string, timezone: string): string {
  const d = DateTime.fromISO(day, { zone: timezone })
  return day <= shiftDay(today, 6, timezone) ? d.toFormat('ccc') : d.toFormat('LLL d')
}

/**
 * RULE DEADLINE-NAG-WORDS: The body shows counts only, never a title. In the safety net it names
 *   the closest of passed, today or tomorrow, by OpenTask day and clock, so a deadline earlier
 *   today that has gone by reads 'passed'. Otherwise it reads 'N deadlines to plan · nearest
 *   <day>'.
 * Why: An 11:30 deadline read "Deadline today" at 11:50 (Trent, 2026-10-30).
 * Ruling: Ruling 5; Trent 2026-10-30 (src/core/notifications/deadline-nags.ts:126).
 */
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
  /** Open-window rows waiting too (START-6): counted, never named as "nearest". */
  open = 0,
): DeadlineNagContent {
  const today = openTaskToday(timezone, now, rolloverTime)
  const days = rows.map((r) => deadlineDay(r.task.deadline_at!, timezone, rolloverTime))
  const net = rows.flatMap((r, i) =>
    r.safetyNet ? [netWord(days[i], today, r.task.deadline_at!, now)] : [],
  )
  if (net.length > 0) {
    const word = net.reduce((a, b) => (NET_RANK[b] < NET_RANK[a] ? b : a))
    const n = net.filter((w) => w === word).length
    const more = rows.length - n + open
    const head = `${n === 1 ? 'Deadline' : 'Deadlines'} ${word}: ${n} unplanned`
    return {
      title: 'Deadlines',
      body: more > 0 ? `${head} · ${more} more to plan` : head,
      subtitle: word === 'passed' ? 'Deadline · passed' : deadlinePushLabel(word),
    }
  }
  const nearest = days.reduce((a, b) => (b < a ? b : a))
  const total = rows.length + open
  const count = total === 1 ? '1 deadline' : `${total} deadlines`
  const nearestName = dayName(nearest, today, timezone)
  return {
    title: 'Deadlines',
    body: `${count} to plan · nearest ${nearestName}`,
    subtitle: deadlinePushLabel(nearestName),
  }
}

// (restates RULE DL-PAGE-MEMBERSHIP, home: src/lib/task-segments.ts)
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

/**
 * How many rows keep the deadlines nag going right now (`countedDeadlineRows`
 * of the page as the nag builds it) — 0 with the task queue off, or with no
 * target-less deadline task — plus the open-window rows waiting (the round
 * push's banner stands while its row waits). The banner reconcile (stale.ts)
 * asks it: with none, a delivered deadlines banner is stale.
 */
export function deadlineRowsWaiting(userId: number, timezone: string, now: Date): number {
  if (!taskQueueEnabled() || !hasDeadlineCandidate(userId)) return 0
  const page =
    getTaskSegments(userId, timezone, now, { queuePanels: true, deadlineRows: true }).find(
      (s) => s.horizon === 'deadlines',
    )?.tasks ?? []
  return countedDeadlineRows(page).length + openDeadlineRows(page).length
}

/** The shortest interval any page row could set for these tiers (the safety net's rungs). */
export function fastestDeadlineInterval(tiers: NagTiers): number {
  const rungs = [0, 1, 2, 3, 4].map((p) =>
    nagIntervalMinutes('deadlines', p, tiers, { safetyNet: true }),
  )
  return Math.max(1, Math.min(...rungs))
}

/**
 * Every rung any page row could set for these tiers, in the safety net or
 * not. The cheap gate asks whether ANY of their marks has come: with marks a
 * shorter interval does not always land sooner, so the fastest alone is no
 * lower bound.
 */
function everyDeadlineRung(tiers: NagTiers): number[] {
  const rungs = new Set<number>()
  for (const p of [0, 1, 2, 3, 4]) {
    for (const safetyNet of [false, true]) {
      const minutes = nagIntervalMinutes('deadlines', p, tiers, { safetyNet })
      if (minutes > 0) rungs.add(minutes)
    }
  }
  return [...rungs]
}

export interface PendingDeadlineNag {
  userId: number
  intervalMinutes: number
  /** The rows the nag speaks for. */
  count: number
  /** Any counted row is in the safety net: the tick ranks it high (tick.ts). */
  safetyNet: boolean
  /** The user's zone, whose clock marks the nag repeats on. */
  timezone: string
  content: DeadlineNagContent
}

/**
 * RULE DEADLINE-NAG-SWITCH: With the switch off there is no deadlines page and so no deadlines nag;
 *   a deadline task nags through its automatic target instead.
 * Why: With the switch off there is no deadlines page to nag about.
 * Ruling: Plan A1 (one release).
 */
/** Every deadlines nag due this minute, at most one per user. Read-only. */
export function pendingDeadlineNags(now: Date = new Date()): PendingDeadlineNag[] {
  if (!taskQueueEnabled()) return []
  const pending: PendingDeadlineNag[] = []
  for (const user of notifiableUsers()) {
    if (!hasDeadlineCandidate(user.id)) continue
    const tiers = userNagTiers(user.id)
    const due = (rungs: number[]) => {
      const pace = nagPace(user.id, DEADLINES_NAG_KEY, rungs, user.timezone)
      if (pace === null) return null
      return nagSendDue(user.id, DEADLINES_NAG_KEY, pace, now, user.timezone) ? pace : null
    }
    // Not due at any pace a row could set: skip building the page (every
    // open task, Upcoming's rrule walks) this minute.
    if (due(everyDeadlineRung(tiers)) === null) continue
    const page =
      getTaskSegments(user.id, user.timezone, now, {
        queuePanels: true,
        deadlineRows: true,
      }).find((s) => s.horizon === 'deadlines')?.tasks ?? []
    const rows = countedDeadlineRows(page)
    const interval = due(deadlineNagRungs(rows, tiers))
    if (interval === null) continue
    const content = deadlineNagContent(
      rows,
      user.timezone,
      now,
      rolloverTimeForUser(user.id),
      openDeadlineRows(page).length,
    )
    pending.push({
      userId: user.id,
      intervalMinutes: interval,
      count: rows.length,
      safetyNet: rows.some((r) => r.safetyNet === true),
      timezone: user.timezone,
      content,
    })
  }
  return pending
}

/**
 * RULE START-6: An open-window row is announced once on each day it comes round (its start day
 *   included): one silent push at the user's Default task time, or at the next tick if it comes
 *   round later that day. No repeats, none on a carry-over day, none for a row considered first or
 *   with its Nag off. It never starts or paces the deadlines nag; while Coming due rows wait the
 *   push is the nag's own words with the open rows added to the count, else "<title> · due <day> ·
 *   N weeks left" for one row and "N open deadlines this week · nearest <day>" for several. The
 *   banner stands while any page row it speaks for waits.
 * Why: He wants one reminder per round from the day he said, not a nag.
 * Ruling: Trent 2026-11-12: "I want to be reminded of it, maybe weekly… I don't want to start being
 *   nagged weekly about it until January 1" (the design session's change to the draft's START-6).
 */
export interface PendingRoundPush {
  userId: number
  timezone: string
  /** The OpenTask day the rounds came on: the stamp the claim writes. */
  day: string
  /** The rows announced. */
  taskIds: number[]
  /** Counted Coming-due rows wait too: the push is the nag's words. */
  safetyNet: boolean
  count: number
  content: DeadlineNagContent
}

/** "11 weeks left" from two weeks out, else "9 days left" / "1 day left". */
function timeLeft(days: number): string {
  if (days >= 14) return `${Math.floor(days / 7)} weeks left`
  return days === 1 ? '1 day left' : `${days} days left`
}

/** The round push's words with no Coming-due row waiting (pure). */
export function roundPushContent(
  rows: SegmentTask[],
  timezone: string,
  now: Date,
  rolloverTime: string | null,
): DeadlineNagContent {
  const today = openTaskToday(timezone, now, rolloverTime)
  const days = rows.map((r) => deadlineDay(r.task.deadline_at!, timezone, rolloverTime))
  const nearest = days.reduce((a, b) => (b < a ? b : a))
  const name = dayName(nearest, today, timezone)
  if (rows.length === 1) {
    const left = timeLeft(openTaskDaysBetweenDays(today, nearest, timezone))
    return {
      title: 'Deadline',
      body: `${rows[0].task.title} · due ${name} · ${left}`,
      subtitle: deadlinePushLabel(name),
    }
  }
  return {
    title: 'Deadlines',
    body: `${rows.length} open deadlines this week · nearest ${name}`,
    subtitle: deadlinePushLabel(name),
  }
}

/** Whole days from one OpenTask day to a later one. */
function openTaskDaysBetweenDays(from: string, to: string, timezone: string): number {
  const at = (day: string) => DateTime.fromISO(day, { zone: timezone })
  return Math.round(at(to).diff(at(from), 'days').days)
}

/** The moment the user's Default task time falls in this OpenTask day. */
function morningMoment(userId: number, day: string, timezone: string, dayStart: string): number {
  const time = getAnchorTimes(userId).morning.time
  const start = dayStartMoment(day, timezone, dayStart).getTime()
  // A Default task time earlier than the day start falls on the next date.
  const onDate = localMoment(day, time, timezone).getTime()
  return onDate >= start ? onDate : localMoment(addDays(day, 1), time, timezone).getTime()
}

interface RoundCandidate {
  id: number
  start_date: string
  lead_from: string | null
  deadline_at: string
  horizon: HorizonValue | null
}

/**
 * The tasks whose round could be announced today: a start date, on the page's
 * terms, Nag on, not yet stamped today — and today one of their round days
 * (pure maths, so the page is built only on a day something comes round).
 */
function roundCandidates(
  userId: number,
  day: string,
  timezone: string,
  rolloverTime: string,
): number[] {
  const rows = getDb()
    .prepare(
      `SELECT id, start_date, lead_from, deadline_at, horizon FROM tasks
       WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
         AND start_date IS NOT NULL AND deadline_at IS NOT NULL AND due_at IS NULL
         AND rrule IS NULL AND auto_snooze_minutes IS NOT 0
         AND (round_announced_day IS NULL OR round_announced_day < ?)`,
    )
    .all(userId, day) as RoundCandidate[]
  if (rows.length === 0) return []
  const checkInDay = getCheckInDay(userId)
  return rows
    .filter((r) => {
      const start = r.lead_from ?? r.start_date
      // Still in its open window today (before the day it becomes daily)…
      if (day >= comingDueDay(r.deadline_at, r.start_date, timezone, rolloverTime)) return false
      // …and today is one of its rounds.
      return start <= day && latestRound(start, r.horizon, checkInDay, day, timezone) === day
    })
    .map((r) => r.id)
}

/**
 * Every round push due this minute, at most one per user. A candidate the
 * page shows nothing to announce for (considered before the Default task
 * time, decked for today) is stamped here as settled for the day, so the page
 * is built once per round day, not every minute after.
 */
export function pendingRoundPushes(now: Date = new Date()): PendingRoundPush[] {
  if (!taskQueueEnabled()) return []
  const pending: PendingRoundPush[] = []
  for (const user of notifiableUsers()) {
    const rolloverTime = rolloverTimeForUser(user.id)
    const day = openTaskToday(user.timezone, now, rolloverTime)
    const candidates = new Set(roundCandidates(user.id, day, user.timezone, rolloverTime))
    if (candidates.size === 0) continue
    if (now.getTime() < morningMoment(user.id, day, user.timezone, rolloverTime)) continue
    const page =
      getTaskSegments(user.id, user.timezone, now, {
        queuePanels: true,
        deadlineRows: true,
      }).find((s) => s.horizon === 'deadlines')?.tasks ?? []
    const open = openDeadlineRows(page)
    const rows = open.filter((r) => r.round === day && candidates.has(r.task.id))
    const announced = new Set(rows.map((r) => r.task.id))
    claimRoundPush(
      [...candidates].filter((id) => !announced.has(id)),
      day,
    )
    if (rows.length === 0) continue
    const due = countedDeadlineRows(page)
    pending.push({
      userId: user.id,
      timezone: user.timezone,
      day,
      taskIds: rows.map((r) => r.task.id),
      safetyNet: due.some((r) => r.safetyNet === true),
      count: due.length > 0 ? due.length + open.length : rows.length,
      content:
        due.length > 0
          ? deadlineNagContent(due, user.timezone, now, rolloverTime, open.length)
          : roundPushContent(rows, user.timezone, now, rolloverTime),
    })
  }
  return pending
}

/**
 * Stamp the rounds announced (compare-and-swap): true when this call stamped
 * any, so a double tick sends once.
 */
export function claimRoundPush(taskIds: number[], day: string): boolean {
  if (taskIds.length === 0) return false
  const marks = taskIds.map(() => '?').join(', ')
  const result = getDb()
    .prepare(
      `UPDATE tasks SET round_announced_day = ?
       WHERE id IN (${marks}) AND (round_announced_day IS NULL OR round_announced_day < ?)`,
    )
    .run(day, ...taskIds, day)
  return result.changes > 0
}

/**
 * Deliver one nag on the channels that are on. Failures are logged per
 * channel. Web Push is silent either way; `passive` (another push leads the
 * tick) makes the APNs banner passive too.
 */
async function sendDeadlinesNag(
  userId: number,
  nagContent: DeadlineNagContent,
  channels: Channels,
  delivery: Delivery,
): Promise<DeliveryResult> {
  const content = { ...nagContent, body: nagContent.body + (delivery.suffix ?? '') }
  const sends: Promise<DeliveryResult>[] = []
  if (channels.webPush) {
    sends.push(
      sendPushNotification(
        userId,
        {
          // No label line on the web (APNs only).
          title: content.title,
          body: content.body,
          data: { url: `${APP_URL}${DEADLINES_PAGE_PATH}` },
          tag: DEADLINES_NAG_COLLAPSE_ID,
          silent: true,
        },
        { urgency: 'normal' },
      ),
    )
  }
  if (channels.apns) {
    sends.push(sendApnsDeadlinesNag(userId, { ...content, passive: delivery.passive }))
  }
  const settled = await Promise.allSettled(sends)
  for (const r of settled) {
    if (r.status === 'rejected') log.error('notifications', 'Deadlines nag error:', r.reason)
  }
  return mergeSettled(settled)
}

/**
 * This minute's deadlines nags as tick sends (tick.ts): kind
 * `deadlines_safety_net` when any counted row is in the safety net, else
 * `deadlines`. The claim is the `nag_sends` compare-and-swap — claimed before
 * sending, so a lost claim means this minute already sent.
 */
export function planDeadlineNagSends(now: Date, channels: Channels): SourcePlan {
  if (!channels.webPush && !channels.apns) return { sends: [] }
  const nags = pendingDeadlineNags(now)
  const rounds = pendingRoundPushes(now)
  const roundOf = new Map(rounds.map((r) => [r.userId, r]))
  const nagging = new Set(nags.map((n) => n.userId))
  // The round push (START-6): on its own only when the nag is not going out
  // for this user this minute — then the nag carries it (its count already
  // includes the open rows) and its claim stamps the rounds.
  const roundSends: TickSend[] = rounds
    .filter((r) => !nagging.has(r.userId))
    .map((round) => ({
      userId: round.userId,
      kind: round.safetyNet ? 'deadlines_safety_net' : 'deadlines',
      items: round.count,
      silent: true,
      claim: () => {
        const won = claimRoundPush(round.taskIds, round.day)
        if (won) {
          log.info(
            'notifications',
            `Deadline round push for user ${round.userId}: ${round.taskIds.length} row(s)`,
          )
        }
        return won
      },
      deliver: (delivery) => sendDeadlinesNag(round.userId, round.content, channels, delivery),
    }))
  const nagSends: SourcePlan = {
    sends: nags.map((nag) => ({
      userId: nag.userId,
      kind: nag.safetyNet ? 'deadlines_safety_net' : 'deadlines',
      items: nag.count,
      // Silent on both channels (rulings 4 and 5), the safety net too: never
      // leads a minute in which something sounds (tick.ts).
      silent: true,
      claim: () => {
        const won = claimNagSend(
          nag.userId,
          DEADLINES_NAG_KEY,
          nag.intervalMinutes,
          now,
          nag.timezone,
        )
        if (won) {
          log.info(
            'notifications',
            `Deadlines nag for user ${nag.userId}: ${nag.count} row(s), every ${nag.intervalMinutes} min`,
          )
          const round = roundOf.get(nag.userId)
          if (round) claimRoundPush(round.taskIds, round.day)
        }
        return won
      },
      deliver: (delivery) => sendDeadlinesNag(nag.userId, nag.content, channels, delivery),
    })),
  }
  return { sends: [...nagSends.sends, ...roundSends] }
}

/** The deadlines nag as one of the minute tick's sources. */
export const DEADLINE_NAG_SOURCE: TickSource = {
  name: 'Deadlines nag checker',
  minuteKey: 'tick-deadlines',
  plan: planDeadlineNagSends,
}

/** The deadlines nag on its own (tests): one tick with this source alone. */
export async function checkDeadlineNags(nowOverride?: Date): Promise<void> {
  if (!isWebPushConfigured() && !isApnsConfigured()) return
  await runTick([DEADLINE_NAG_SOURCE], nowOverride ?? new Date())
}
