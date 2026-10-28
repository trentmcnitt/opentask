/**
 * The dashboard task row's CORNER (2026-10-14, Trent's picks from mockups
 * r3 "E2b" and r5 "R1"): small tabs flush with the row's top-right corner,
 * read left to right as
 *
 *     horizon dot · attempts (2×) · priority tab
 *
 * so the coloured priority tab owns the corner itself and stays the loud one.
 * This file holds the pure rules behind it — which tab shows, its words and
 * colours, the horizon dot's size and tooltip, which rows offer "Today" and
 * what the target-time menu offers — so they are tested without a browser
 * (tests/behavioral/tm-row-corner.test.ts). The components are
 * `RowCorner.tsx` and `HorizonDot.tsx`.
 */
import {
  HORIZON_ORDER,
  UNSET_HORIZON,
  effectiveHorizon,
  targetReset,
  type CheckInDay,
  type HorizonValue,
} from '@/lib/task-segments'
import { HORIZON_LABELS, HORIZON_UNSET_LABEL, horizonHints } from '@/lib/task-model-words'
import { isTracked } from '@/lib/track'

// ---------------------------------------------------------------------------
// Priority tab
// ---------------------------------------------------------------------------

export interface PriorityTab {
  /** "Urgent" / "High", or the compact symbol (see `badgeStyle`). */
  text: string
  /** The accessible name and tooltip: "High priority". */
  name: string
  /** Solid fill + text colour, the app's priority colours (`PRIORITY_OPTIONS`). */
  className: string
}

/**
 * The solid tab for High and Urgent only. Medium, Low and None show NOTHING
 * (Trent, 2026-10-15: "just use a colored corner, while only adding '!' and
 * '!!' for high and urgent (medium and low get no colored corner tab)" — a
 * Medium dot read as a second horizon dot beside R1's). Medium stays visible
 * and settable everywhere else: the editor's chip, filters.
 *
 * Colours are `PRIORITY_OPTIONS`'s hues (orange / red 500) as fills.
 *
 * `badgeStyle` is the user's existing Priority Display choice: 'icons' puts the
 * compact symbol in the tab (! and !!) instead of the word. Kept because it
 * still means something on a tab; see `TaskRow` for the other settings.
 */
export function priorityTab(
  priority: number,
  badgeStyle: 'words' | 'icons' = 'words',
): PriorityTab | null {
  const icons = badgeStyle === 'icons'
  switch (priority) {
    case 3:
      return {
        text: icons ? '!' : 'High',
        name: 'High priority',
        className: 'bg-orange-500 text-white',
      }
    case 4:
      return {
        text: icons ? '!!' : 'Urgent',
        name: 'Urgent priority',
        className: 'bg-red-500 text-white',
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Horizon dot (R1, "perspective dot")
// ---------------------------------------------------------------------------

/**
 * One dot that shrinks and fades with distance: Days 8px dark, Weeks 6px
 * mid-grey, Months 5px light, Eventually the smallest and lightest.
 *
 * `r` is the radius in the 12×12 viewBox (so the diameter in CSS px), and
 * `opacity` is applied over the mark's colour (foreground at 78%).
 *
 * EVENTUALLY (2026-10-14): the mockup's 4px at 0.22 all but vanished at real
 * size, in light mode especially. It is 4.5px at 0.42 now — clearly there at
 * 1x and 2x in both themes, yet still the faintest of the four — and Months
 * moved up to 0.55 so the steps stay even. Checked in screenshots at 1x and
 * 2x, light and dark (E2E `row-corner.spec.ts` captures them).
 */
export const HORIZON_DOT: Record<HorizonValue, { r: number; opacity: number }> = {
  days: { r: 4, opacity: 1 },
  weeks: { r: 3, opacity: 0.7 },
  months: { r: 2.5, opacity: 0.55 },
  eventually: { r: 2.25, opacity: 0.42 },
}

/**
 * Unset (null, read as weeks — never reported as set): a HOLLOW RING the size
 * of the Weeks dot — hollow = not chosen, filled = chosen. A 1px stroke on
 * r 2.5 fills exactly the Weeks dot's 6px, and lies on whole pixels.
 *
 * It was a DASHED outline (r 3, dashes 1.6/1.3) until 2026-10-28, when Trent
 * saw it break up on a 1x monitor: the dashes didn't divide the circle evenly
 * and the stroke straddled pixel rows, so at 1x it drew as uneven grey
 * blotches. Mocked against pixel-aligned dashes (`.tmp/horizon-ring/`, 1x and
 * 2x, light and dark); the ring was his pick.
 *
 * QUIETER (2026-10-28, Trent: at 0.8 it was "a little too strong… It looks
 * intentionally set"): 0.36, 45% of that, so it reads as "nothing set" beside
 * a filled dot — fainter than every set dot (Eventually is 0.42), still
 * there at 1x in both themes. This one token is every surface's: the row
 * corner, a segment row's meta, the editor's chip and the horizon menu.
 */
export const HORIZON_DOT_UNSET = { r: 2.5, opacity: 0.36 } as const

/** The horizon value a stored string stands for, or null when unset/unknown. */
export function horizonOf(value: string | null | undefined): HorizonValue | null {
  return (HORIZON_ORDER as readonly string[]).includes(value ?? '') ? (value as HorizonValue) : null
}

interface CornerTask {
  due_at: string | null
  deadline_at: string | null
  target_auto?: boolean
  rrule?: string | null
  is_reminder?: boolean
  done?: boolean
  horizon?: string | null
  progress_target?: number
  is_tracked?: boolean
}

/**
 * Whether the task has no target the USER picked — none at all, or only the
 * deadline's automatic one (`target_auto`). These are the tasks whose horizon
 * decides when they come back (spec §1, 2026-10-12).
 */
function noPickedTarget(task: CornerTask): boolean {
  return task.due_at === null || task.target_auto === true
}

/** A plain one-off: not a quota, a reminder, a repeating task or a done one. */
function isPlainOneOff(task: CornerTask): boolean {
  return (
    !task.done &&
    !task.is_reminder &&
    !task.rrule &&
    !isTracked({
      progress_target: task.progress_target ?? 1,
      is_tracked: task.is_tracked ?? false,
    })
  )
}

/**
 * Whether the row shows the horizon dot: only where the horizon decides
 * something. A one-off with no picked target lives in its horizon segment, so
 * the dot shows. A PICKED target makes the horizon irrelevant until it is
 * removed (spec §1: "quiet until its date") — the dot is hidden there, as the
 * Upcoming rows already hide the horizon chip; removing the target brings it
 * back. Repeating tasks, reminders and quotas have no horizon segment at all.
 */
export function showsHorizonDot(task: CornerTask): boolean {
  return isPlainOneOff(task) && noPickedTarget(task)
}

/**
 * Whether the dashboard row offers "Today" (target today) on hover: the same
 * rows as the dot — a one-off without a target the user picked. A picked
 * target already says when; Move… on its time text changes it.
 */
export function offersTargetToday(task: CornerTask): boolean {
  return showsHorizonDot(task)
}

/**
 * The dot's tooltip: "Weeks · comes back Saturdays" — when its horizon
 * segment comes round, in the horizon picker's own words (`horizonHints`,
 * lower-cased where they are not a day name). Unset says so: "Unset (counts as
 * Weeks) · comes back Saturdays". When a near deadline pulls the task into a
 * sooner segment, the tooltip names the segment it is actually in.
 */
export function horizonDotTitle(task: CornerTask, checkInDay: CheckInDay, now: Date): string {
  const set = horizonOf(task.horizon)
  const name = set
    ? HORIZON_LABELS[set]
    : `${HORIZON_UNSET_LABEL} (counts as ${HORIZON_LABELS[UNSET_HORIZON]})`
  const effective = effectiveHorizon({ horizon: set, deadline_at: task.deadline_at ?? null }, now)
  const when = comesBack(effective, checkInDay)
  if (effective !== (set ?? UNSET_HORIZON)) {
    return `${name} · deadline near, comes back ${when}`
  }
  return `${name} · comes back ${when}`
}

/** "daily", "Saturdays", "1st Saturday", "quarterly". */
export function comesBack(horizon: HorizonValue, checkInDay: CheckInDay): string {
  const hint = horizonHints(checkInDay)[horizon]
  return horizon === 'days' || horizon === 'eventually' ? hint.toLowerCase() : hint
}

// ---------------------------------------------------------------------------
// Target time menu
// ---------------------------------------------------------------------------

/**
 * What tapping a row's target time offers: always "Move…" (the Target menu),
 * and "Remove target" where `targetReset` allows one (never on a repeating
 * task). `reset` null: Move… only.
 */
export function targetTimeMenu(task: CornerTask): { reset: 'remove' | null } {
  if (task.is_reminder) return { reset: null }
  return { reset: targetReset(task) }
}

/**
 * The bulk "Remove target" (the action bar's More sheet): which of the
 * selected tasks it applies to — the ones a row's own menu would offer it on.
 * Repeating tasks, reminders, quotas, automatic targets (task queue off) and
 * undated tasks are left alone (their other state is untouched; the date part is scoped to these
 * ids with `date_task_ids`).
 */
export function removableTargetIds(tasks: (CornerTask & { id: number })[]): number[] {
  return tasks.filter((t) => !t.done && targetTimeMenu(t).reset !== null).map((t) => t.id)
}

// ---------------------------------------------------------------------------
// Corner width
// ---------------------------------------------------------------------------

/**
 * Approximate widths (CSS px) of each corner tab at its 10.5px semibold text,
 * for the title's float spacer (`TaskRow`): a long title wraps around the
 * corner instead of running under it. Estimates, not measurements — a
 * ResizeObserver per row would cost more than the few px of slack it saves
 * (the list can hold hundreds of rows). Rounded up so text never touches.
 */
const TAB_WIDTH = { dot: 24, attemptsPerChar: 7, attemptsPad: 14 } as const
const PRIORITY_WIDTH: Record<string, number> = {
  Urgent: 50,
  High: 38,
  '!': 18,
  '!!': 22,
}

export function cornerWidth(parts: {
  dot: boolean
  attempts: number
  priorityText: string | null
}): number {
  let w = 0
  if (parts.dot) w += TAB_WIDTH.dot
  if (parts.attempts >= 1) {
    w += TAB_WIDTH.attemptsPad + TAB_WIDTH.attemptsPerChar * (String(parts.attempts).length + 1)
  }
  if (parts.priorityText) w += PRIORITY_WIDTH[parts.priorityText] ?? 56
  return w
}
