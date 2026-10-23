'use client'

import { cn } from '@/lib/utils'
import { deadlineChip, type DeadlineTone } from '@/lib/deadline-chip'
import { useTaskQueue } from '@/components/PreferencesProvider'

/**
 * THE DEADLINE CHIP (the deadlines page, 2026-10-22, plan §9): the one way a
 * task row shows its deadline — at the START of its second line, on every
 * row type (task segments, Upcoming, the deadlines page, Now's On deck
 * section, the dashboard row). Words and tone are `deadlineChip`'s: red once
 * passed, amber in the safety net (from the day before the deadline's
 * OpenTask day), otherwise neutral and bold. A soft background box, the
 * affordance made of the text itself (no glyph). The OpenTask day needs the
 * user's rollover time: with the task queue off, or before the preferences
 * load, calendar days.
 */
const TONE: Record<DeadlineTone, string> = {
  passed: 'bg-destructive/10 text-destructive',
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
