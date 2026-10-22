/**
 * THE ON DECK HOLD MENU's days (On deck D2, 2026-10-20; spec rule 7,
 * docs/TASK-MODEL.md § On deck). Pure, so the menu and the behavioural tests
 * share one copy.
 *
 * A tap on the On deck button decks the task for today (the calendar day —
 * red-team A2: between midnight and the rollover that is the coming day). A
 * HOLD picks the day instead:
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
  calendarToday,
  repeatingDeadlineDay,
  type CheckInDay,
  type TargetContext,
} from './task-segments'

export interface DeckMenuDay {
  /** "Tomorrow", "Thursday", "Saturday · check-in", "Sat Oct 31 · check-in". */
  label: string
  /** The local calendar date it decks for (yyyy-MM-dd). */
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
 * the calendar day after today (A2: between midnight and the rollover, the
 * day after the coming one). No limit here: a deadline task the server
 * refuses (A1) comes back with its reason, as from the menu.
 */
export function deckTomorrowDay(timezone: string, now: Date): string {
  return deckMenuDays(timezone, now)[0].day
}

/**
 * The hold menu's day items, nearest first. `limit` (A1) greys every day
 * after its `latestDay`, with its caption; null = no limit.
 */
export function deckMenuDays(
  timezone: string,
  now: Date,
  checkInDay: CheckInDay = CHECK_IN_DAY_DEFAULT,
  limit: DeckLimit | null = null,
): DeckMenuDay[] {
  const today = DateTime.fromISO(calendarToday(timezone, now), { zone: timezone })
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
  now: Date = new Date(),
  ctx?: TargetContext | null,
  /** The user's rollover time: the deadline's day is its OpenTask day (`repeatingDeadlineDay`). */
  rolloverTime: string | null = null,
): DeckLimit | null {
  if (!task.deadline_at) return null
  const today = DateTime.fromISO(calendarToday(timezone, now), { zone: timezone })
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
): null | undefined {
  return task.on_deck_day && task.on_deck_day <= calendarToday(timezone, now) ? null : undefined
}

/**
 * Whether a row offers the On deck button: an open task that is not a
 * reminder or quota (rule 6), and — a one-off — has no target the user picked
 * (rule 1: a picked target and a deck never coexist — Today's hover rule,
 * `offersTargetToday`), or one already on deck. A REPEATING task always
 * offers it (2026-10-20): its target is its occurrence, and decking it decks
 * that occurrence (the target goes while decked). The queue switch is the
 * caller's.
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
  if (task.is_tracked || (task.progress_target ?? 1) > 1) return false
  if (task.on_deck_day || task.rrule) return true
  return task.due_at === null || task.target_auto === true
}
