'use client'

import { deadlineChip, type DeadlineTone } from '@/lib/deadline-chip'
import { useTaskQueue } from '@/components/PreferencesProvider'
import { TimeChip, type TimeChipTone } from '@/components/TimeChip'

/**
 * THE DEADLINE CHIP (the deadlines page, 2026-10-22, plan §9): the one way a
 * task row shows its deadline — on its second line right after the project
 * (first on the dashboard row, whose line has none), on every
 * row type (task segments, Upcoming, the deadlines page, Now's On deck
 * section, the dashboard row). Words and tone are `deadlineChip`'s; the box
 * is the time chips' (`TimeChip`, 2026-10-28): teal with a flag, solid teal
 * on the deadline's own day, red once passed. The OpenTask day needs the
 * user's rollover time: with the task queue off, or before the preferences
 * load, calendar days.
 */
const TONE: Record<DeadlineTone, TimeChipTone> = {
  passed: 'passed',
  today: 'today',
  ahead: 'deadline',
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
    <TimeChip
      tone={TONE[chip.tone]}
      title={chip.title}
      className={className}
      data-deadline-chip={chip.tone}
    >
      {chip.text}
    </TimeChip>
  )
}
