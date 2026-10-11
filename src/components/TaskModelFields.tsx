'use client'

import { Flag } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { DateTimePicker } from '@/components/DateTimePicker'
import { HorizonChip } from '@/components/TaskSegmentRow'
import { DEADLINE_WORD, HORIZON_WORD } from '@/lib/task-model-words'
import { isPastDeadline, type HorizonValue } from '@/lib/task-segments'

/**
 * The editor's deadline and horizon line (2026-10-10, docs/TASK-MODEL.md
 * § Deadline, target, horizon), under the target line.
 *
 * The deadline has its OWN picker and no snooze button ever moves it — that is
 * the whole difference between it and the target above. Clearing it is the
 * picker's Clear. The horizon is the same chip the task segments use; unset
 * says so, rather than pretending to be "weeks".
 *
 * Staged like every other field in the panel: blue while dirty, saved with the
 * rest on Save.
 */
export function TaskModelFields({
  deadline,
  horizon,
  deadlineDirty,
  horizonDirty,
  timezone,
  onDeadline,
  onHorizon,
}: {
  deadline: string | null
  horizon: HorizonValue | null
  deadlineDirty: boolean
  horizonDirty: boolean
  timezone: string
  onDeadline: (value: string | null) => void
  onHorizon: (value: HorizonValue | null) => void
}) {
  const when = deadline ? DateTime.fromISO(deadline).setZone(timezone) : null
  const past = deadline ? isPastDeadline(deadline, new Date()) : false
  return (
    <div
      className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      data-task-model-fields
    >
      <DateTimePicker
        value={deadline}
        timezone={timezone}
        onChange={onDeadline}
        emptyDefault="tomorrow"
      >
        <p data-quick-panel-deadline className="inline-flex cursor-pointer items-center gap-1">
          <Flag className="text-muted-foreground/50 size-3 shrink-0" />
          <span className="text-muted-foreground/70">{DEADLINE_WORD}</span>
          <span
            className={cn(
              deadlineDirty
                ? 'font-bold text-blue-500'
                : past
                  ? 'text-destructive font-semibold'
                  : when
                    ? 'font-medium text-amber-700 dark:text-amber-400'
                    : 'text-muted-foreground/60',
            )}
          >
            {when ? `${past ? 'passed ' : ''}${when.toFormat('ccc LLL d, h:mm a')}` : 'None'}
          </span>
        </p>
      </DateTimePicker>
      <span className={cn('inline-flex items-center gap-1', horizonDirty && 'text-blue-500')}>
        <span className="text-muted-foreground/70">{HORIZON_WORD}</span>
        <HorizonChip task={{ horizon, title: '' }} onChange={onHorizon} />
      </span>
    </div>
  )
}
