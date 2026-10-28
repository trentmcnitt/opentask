'use client'

import { cn } from '@/lib/utils'
import { deadlineChip, type DeadlineTone } from '@/lib/deadline-chip'
import { useTaskQueue } from '@/components/PreferencesProvider'

/**
 * THE DEADLINE CHIP (the deadlines page, 2026-10-22, plan §9): the one way a
 * task row shows its deadline — on its second line right after the project
 * (first on the dashboard row, whose line has none), on every
 * row type (task segments, Upcoming, the deadlines page, Now's On deck
 * section, the dashboard row). Words and tone are `deadlineChip`'s: red once
 * passed, amber in the safety net (from the day before the deadline's
 * OpenTask day), otherwise neutral and bold. A soft background box, the
 * affordance made of the text itself (no glyph). The OpenTask day needs the
 * user's rollover time: with the task queue off, or before the preferences
 * load, calendar days.
 */
// Each tinted tone's text is a step darker (lighter in dark mode) than its
// tint, as amber's: `text-destructive` on its own 10% tint was 3.99:1 in both
// themes, under the 4.5:1 small text needs; red-700 / red-400 are 5.4 / 6.6
// (2026-10-28).
const TONE: Record<DeadlineTone, string> = {
  passed: 'bg-destructive/10 text-red-700 dark:text-red-400',
  close: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  ahead: 'bg-foreground/[0.06] text-foreground',
}

export function DeadlineChip({
  deadlineAt,
  timezone,
  className,
}: {
  deadlineAt: string
  timezone: string
  className?: string
}) {
  const { attemptsRolloverTime } = useTaskQueue()
  const chip = deadlineChip(deadlineAt, timezone, new Date(), attemptsRolloverTime)
  return (
    <span
      data-deadline-chip={chip.tone}
      title={chip.title}
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1 font-semibold whitespace-nowrap',
        TONE[chip.tone],
        className,
      )}
    >
      {chip.text}
    </span>
  )
}
