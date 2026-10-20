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
 *     that list; when it is today or tomorrow, the NEXT one is its own item
 *     ("Sat Oct 31 · check-in")
 *   Pick a date…        — the caller's date-only picker
 *   Remove              — only when the task is on deck (A10)
 *
 * Re-deck = hold → Tomorrow (spec rule 7).
 *
 * A DEADLINE TASK (red-team A1): a deck may not land after the day its
 * automatic target starts reminding. When the client knows that day
 * (`deckLatestDay`), the later days are greyed out; otherwise the server
 * refuses the pick and the toast says why.
 */
import { DateTime } from 'luxon'
import {
  CHECK_IN_DAY_DEFAULT,
  DECK_DAY_FORMAT,
  calendarToday,
  type CheckInDay,
} from './task-segments'

export interface DeckMenuDay {
  /** "Tomorrow", "Thursday", "Saturday · check-in", "Sat Oct 31 · check-in". */
  label: string
  /** The local calendar date it decks for (yyyy-MM-dd). */
  day: string
  /** After the deadline's automatic target day (A1): shown, not choosable. */
  disabled: boolean
}

/** How many days out the named days run (Tomorrow is day 1). */
export const DECK_MENU_NAMED_DAYS = 6

const CHECK_IN_MARK = 'check-in'

/**
 * The hold menu's day items, nearest first. `latestDay` (yyyy-MM-dd) greys
 * every later day (A1); null = no limit.
 */
export function deckMenuDays(
  timezone: string,
  now: Date,
  checkInDay: CheckInDay = CHECK_IN_DAY_DEFAULT,
  latestDay: string | null = null,
): DeckMenuDay[] {
  const today = DateTime.fromISO(calendarToday(timezone, now), { zone: timezone })
  const item = (d: DateTime, label: string): DeckMenuDay => {
    const day = d.toFormat(DECK_DAY_FORMAT)
    return { label, day, disabled: latestDay !== null && day > latestDay }
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
 * The last day a deck may land on for this task, when the client can tell
 * (A1): a deadline task whose target IS its automatic one — the day BEFORE
 * that target's local day (a deck on the automatic target's own day would
 * nag that day, so the server refuses it too). A task with a picked target (decking drops it, and the server
 * computes the automatic one) or no deadline: null — the server decides.
 */
export function deckLatestDay(
  task: { deadline_at: string | null; due_at: string | null; target_auto?: boolean },
  timezone: string,
): string | null {
  if (!task.deadline_at || !task.target_auto || !task.due_at) return null
  return DateTime.fromISO(task.due_at, { zone: 'utc' })
    .setZone(timezone)
    .minus({ days: 1 })
    .toFormat(DECK_DAY_FORMAT)
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
 * Whether a row offers the On deck button: an open one-off (rule 6 — no
 * repeating task, reminder or quota) with no target the user picked (rule
 * 1: a picked target and a deck never coexist — Today's hover rule,
 * `offersTargetToday`), or one already on deck. The queue switch is the
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
  if (task.done || task.rrule || task.is_reminder) return false
  if (task.is_tracked || (task.progress_target ?? 1) > 1) return false
  if (task.on_deck_day) return true
  return task.due_at === null || task.target_auto === true
}
