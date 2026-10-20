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
  autoTargetAt,
  calendarToday,
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
 * A deadline task's deck limit (A1, as the server's `deckRefusal` judges it):
 * the day BEFORE its automatic target's local day — a deck on that day would
 * nag, so the server refuses it. The automatic target is the stored one when
 * the target already is automatic, else the one the deadline gives now (a
 * picked target goes when decking; the Quick panel passes a STAGED deadline
 * here). One that has already arrived leaves no day at all (the latest day is
 * yesterday). No deadline: null.
 */
export function deckLimit(
  task: { deadline_at: string | null; due_at: string | null; target_auto?: boolean },
  timezone: string,
  now: Date = new Date(),
  ctx?: TargetContext | null,
): DeckLimit | null {
  if (!task.deadline_at) return null
  const auto =
    task.target_auto && task.due_at ? task.due_at : autoTargetAt(task.deadline_at, ctx, now)
  const autoDay = DateTime.fromISO(auto, { zone: 'utc' }).setZone(timezone)
  const today = DateTime.fromISO(calendarToday(timezone, now), { zone: timezone })
  const reminds = Date.parse(auto) <= now.getTime() ? today : autoDay.startOf('day')
  return {
    latestDay: reminds.minus({ days: 1 }).toFormat(DECK_DAY_FORMAT),
    caption: `deadline reminds from ${reminds.toFormat('ccc')}`,
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
