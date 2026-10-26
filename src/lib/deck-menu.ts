/**
 * THE ON DECK HOLD MENU's days (On deck D2, 2026-10-20; spec rule 7,
 * docs/TASK-MODEL.md § On deck). Pure, so the menu and the behavioural tests
 * share one copy.
 *
 * A tap on the On deck button decks the task for today — the OpenTask day
 * ("Day starts at" PR 2, 2026-10-24; it was the calendar day under red-team
 * A2): between midnight and a 3:00 AM day start, "today" is the day that is
 * ending, and the late night's pick is Tomorrow. A HOLD picks the day instead:
 *
 *   Tomorrow
 *   Thursday, Friday, … — the next few days by name (2 to 6 days out)
 *   Saturday · check-in — the user's check-in day is marked where it falls in
 *     that list ("Tomorrow · check-in" when it is tomorrow); when it is TODAY,
 *     the next one, a week out, is its own item ("Sat Oct 31 · check-in")
 *   Pick a date…        — the caller's date-only picker
 *   Remove              — only when the task is on deck (A10)
 *
 * Re-deck = hold → Tomorrow (spec rule 7).
 *
 * A DEADLINE TASK (red-team A1): a deck may land only BEFORE the day its
 * automatic target starts reminding (`deckLimit`). That day and the later ones
 * are greyed out, with a caption saying why ("deadline reminds from Tue"); the
 * server refuses them anyway and the toast says why.
 */
import { DateTime } from 'luxon'
import {
  CHECK_IN_DAY_DEFAULT,
  DECK_DAY_FORMAT,
  lastDeferDay,
  openTaskToday,
  repeatingDeadlineDay,
  type CheckInDay,
  type TargetContext,
} from './task-segments'

export interface DeckMenuDay {
  /** "Tomorrow", "Thursday", "Saturday · check-in", "Sat Oct 31 · check-in". */
  label: string
  /** The OpenTask date it decks for (yyyy-MM-dd). */
  day: string
  /** On or after the deadline's automatic target day (A1): shown, not choosable. */
  disabled: boolean
  /** Why it is disabled: "deadline reminds from Tue". */
  caption?: string
}

/** A deadline task's limit (A1, `deckLimit`). */
export interface DeckLimit {
  /** The last day a deck may land on (yyyy-MM-dd). */
  latestDay: string
  /** The disabled days' caption: "deadline reminds from Tue". */
  caption: string
}

/** How many days out the named days run (Tomorrow is day 1). */
export const DECK_MENU_NAMED_DAYS = 6

const CHECK_IN_MARK = 'check-in'

/**
 * "Tomorrow" as a deck day (yyyy-MM-dd) for the task-segment row's one-tap
 * "On deck tomorrow" button (2026-10-20): the hold menu's own Tomorrow item
 * (`deckMenuDays`' first day), read from it so the two can never disagree —
 * the OpenTask day after today. No limit here: a deadline task the server
 * refuses (A1) comes back with its reason, as from the menu.
 */
export function deckTomorrowDay(timezone: string, now: Date, dayStart: string): string {
  return deckMenuDays(timezone, now, dayStart)[0].day
}

/**
 * THE DAY START NOT KNOWN YET ("Day starts at" PR 2 review): before the
 * preferences load, with nothing remembered (`useDayStartKnown`), the
 * browser reads midnight — and between midnight and a 3:00 AM day start,
 * midnight's "tomorrow" is a day late. A deck commits a DAY, so it waits:
 * the one-tap "On deck tomorrow" does nothing (null) and the hold menu's
 * days are shown but not choosable, as Snooze's Tomorrow.
 */
export const DAY_UNKNOWN_CAPTION = 'loading your day'

/** The one-tap "On deck tomorrow" day, or null while the day start is unknown. */
export function deckTomorrowIfKnown(
  timezone: string,
  now: Date,
  dayStart: string,
  dayKnown: boolean,
): string | null {
  return dayKnown ? deckTomorrowDay(timezone, now, dayStart) : null
}

/** The hold menu's days, disabled while the day start is unknown. */
export function gateDeckDays(days: DeckMenuDay[], dayKnown: boolean): DeckMenuDay[] {
  return dayKnown ? days : days.map((d) => ({ ...d, disabled: true, caption: DAY_UNKNOWN_CAPTION }))
}

/**
 * The hold menu's day items, nearest first. `limit` (A1) greys every day
 * after its `latestDay`, with its caption; null = no limit.
 */
export function deckMenuDays(
  timezone: string,
  now: Date,
  /** The user's day boundary (`useDayStart`): the days are OpenTask days. */
  dayStart: string,
  checkInDay: CheckInDay = CHECK_IN_DAY_DEFAULT,
  limit: DeckLimit | null = null,
): DeckMenuDay[] {
  const today = DateTime.fromISO(openTaskToday(timezone, now, dayStart), { zone: timezone })
  const item = (d: DateTime, label: string): DeckMenuDay => {
    const day = d.toFormat(DECK_DAY_FORMAT)
    return limit && day > limit.latestDay
      ? { label, day, disabled: true, caption: limit.caption }
      : { label, day, disabled: false }
  }
  const items: DeckMenuDay[] = []
  let checkInListed = false
  for (let n = 1; n <= DECK_MENU_NAMED_DAYS; n++) {
    const d = today.plus({ days: n })
    const name = n === 1 ? 'Tomorrow' : d.toFormat('cccc')
    const isCheckIn = d.weekday === checkInDay
    if (isCheckIn) checkInListed = true
    items.push(item(d, isCheckIn ? `${name} · ${CHECK_IN_MARK}` : name))
  }
  if (!checkInListed) {
    // The check-in day is today: its next one is a week away, past the list.
    const next = today.plus({ days: 7 })
    items.push(item(next, `${next.toFormat('ccc LLL d')} · ${CHECK_IN_MARK}`))
  }
  return items
}

/**
 * A deadline task's deck limit (A1, as the server's `deckRefusal` judges it —
 * the deadlines page, 2026-10-22): any day up to and including the deadline's
 * own OpenTask day ("deadline Fri"; a deadline before the rollover counts as
 * the evening before, `repeatingDeadlineDay`), one-off or repeating, while
 * the deadline is ahead. A passed deadline leaves no day at all (the latest
 * day is yesterday). No deadline: null. The Quick panel passes a STAGED
 * deadline here. (`ctx` is kept for the callers; the deadline alone decides.)
 */
export function deckLimit(
  task: {
    deadline_at: string | null
    due_at: string | null
    target_auto?: boolean
    rrule?: string | null
  },
  timezone: string,
  now: Date,
  ctx: TargetContext | null,
  /** The user's rollover time: the deadline's day is its OpenTask day (`repeatingDeadlineDay`). */
  rolloverTime: string | null,
): DeckLimit | null {
  if (!task.deadline_at) return null
  const today = DateTime.fromISO(openTaskToday(timezone, now, rolloverTime), { zone: timezone })
  if (Date.parse(task.deadline_at) <= now.getTime()) {
    return {
      latestDay: today.minus({ days: 1 }).toFormat(DECK_DAY_FORMAT),
      caption: 'deadline passed',
    }
  }
  const deadlineDay = DateTime.fromISO(
    repeatingDeadlineDay(task.deadline_at, timezone, rolloverTime),
    { zone: timezone },
  )
  return {
    latestDay: deadlineDay.toFormat(DECK_DAY_FORMAT),
    caption: `deadline ${deadlineDay.toFormat('ccc')}`,
  }
}

/**
 * What a TAP on the On deck button does (A10): a task on deck for today (or
 * an earlier day not yet stripped) comes OFF deck — the filled button is a
 * toggle; anything else (not on deck, or on deck for a later day) goes on
 * deck for today. Returns the day to send: undefined = today (the server's
 * default), null = take off deck.
 */
export function deckTapDay(
  task: { on_deck_day?: string | null },
  timezone: string,
  now: Date,
  dayStart: string,
): null | undefined {
  return task.on_deck_day && task.on_deck_day <= openTaskToday(timezone, now, dayStart)
    ? null
    : undefined
}

/**
 * Whether a row offers the On deck button: an open task that is not a
 * reminder or quota (rule 6) — every one since 2026-10-22 (the deadlines
 * page, plan §5: "Deck may replace a target everywhere"). On a one-off with a
 * target the user picked the button is FADED and asks first
 * (`deckReplaces`): a deck drops that target (rule 1, the server's
 * `prepareDeck`). A REPEATING task decks its current occurrence (2026-10-20;
 * its target is its occurrence, back when it comes off deck) — no warning.
 * The queue switch is the caller's.
 */
export function offersDeck(task: {
  due_at: string | null
  target_auto?: boolean
  on_deck_day?: string | null
  rrule?: string | null
  is_reminder?: boolean
  is_tracked?: boolean
  progress_target?: number
  done?: boolean
}): boolean {
  if (task.done || task.is_reminder) return false
  return !(task.is_tracked || (task.progress_target ?? 1) > 1)
}

/**
 * What a deck would REPLACE (plan §5): the picked target of a one-off —
 * "target Fri 6 PM" — or null (no target, an automatic one with the task
 * queue off, a repeating task's occurrence, already on deck). The faded On
 * deck button's warning reads "Replaces target Fri 6 PM".
 */
export function deckReplaces(
  task: {
    due_at: string | null
    target_auto?: boolean
    on_deck_day?: string | null
    rrule?: string | null
  },
  timezone: string,
): string | null {
  if (task.rrule || task.on_deck_day || task.due_at === null || task.target_auto) return null
  const at = DateTime.fromISO(task.due_at, { zone: 'utc' }).setZone(timezone)
  return `target ${at.toFormat(at.minute === 0 ? 'ccc h a' : 'ccc h:mm a')}`
}

/**
 * What Today would REPLACE (plan §5): the deck of a decked task — "On deck
 * Sat" ("On deck today") — or null. Today is a picked target, so it takes
 * the task off deck (`deck-clear.ts`); the faded Today button's warning reads
 * "Replaces On deck Sat".
 */
export function todayReplaces(
  task: { on_deck_day?: string | null },
  timezone: string,
  /** The user's day boundary (`useDayStart`): "today" is the OpenTask day. */
  dayStart: string,
  now: Date = new Date(),
): string | null {
  if (!task.on_deck_day) return null
  const day = DateTime.fromISO(task.on_deck_day, { zone: timezone })
  if (!day.isValid) return 'On deck'
  return task.on_deck_day === openTaskToday(timezone, now, dayStart)
    ? 'On deck today'
    : `On deck ${day.toFormat('ccc')}`
}

/** One day of the deadlines page's Defer menu (`deferLeadDays`). */
export interface DeferLeadDay {
  /** "Tomorrow", "Thursday", "Sat Nov 7". */
  label: string
  /** The OpenTask day the lead moves to (yyyy-MM-dd). */
  day: string
  /** "2 days before the deadline" on the last day it allows. */
  caption?: string
}

/**
 * THE DEADLINES PAGE'S DEFER MENU (2026-10-22, plan §3; A3: tap + pick): the
 * days a row's lead day may move to — tomorrow (the OpenTask day after
 * today) up to two days before the deadline's OpenTask day (D−2, the safety
 * net's start minus one, `lastDeferDay`) — the next six by name, and the last
 * allowed day itself when it lies further out. Empty once the safety net
 * holds the task, or when tomorrow is already D−1: then the row has no Defer.
 */
export function deferLeadDays(
  deadlineAt: string,
  timezone: string,
  now: Date,
  rolloverTime: string | null,
  /** The row's current lead day: a Defer only moves it later (`leadDeferRefusal`). */
  leadFrom: string | null = null,
): DeferLeadDay[] {
  const last = lastDeferDay(deadlineAt, timezone, rolloverTime)
  const today = DateTime.fromISO(openTaskToday(timezone, now, rolloverTime), { zone: timezone })
  const days: DeferLeadDay[] = []
  for (let n = 1; n <= DECK_MENU_NAMED_DAYS; n++) {
    const d = today.plus({ days: n })
    const day = d.toFormat(DECK_DAY_FORMAT)
    if (day > last) return markLast(days, last)
    if (leadFrom && day <= leadFrom) continue
    days.push({ label: n === 1 ? 'Tomorrow' : d.toFormat('cccc'), day })
  }
  const lastDay = DateTime.fromISO(last, { zone: timezone })
  const latest = days.length > 0 ? days[days.length - 1].day : (leadFrom ?? '')
  if (last > latest) {
    days.push({ label: lastDay.toFormat('ccc LLL d'), day: last })
  }
  return markLast(days, last)
}

function markLast(days: DeferLeadDay[], last: string): DeferLeadDay[] {
  return days.map((d) => (d.day === last ? { ...d, caption: '2 days before the deadline' } : d))
}
