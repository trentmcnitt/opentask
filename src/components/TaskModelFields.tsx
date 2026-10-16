'use client'

import { Flag } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { DateTimePicker } from '@/components/DateTimePicker'
import { DEADLINE_WORD, HORIZON_WORD, targetQuietUntil } from '@/lib/task-model-words'
import { isPastDeadline } from '@/lib/task-segments'

/**
 * The editor's deadline and horizon line (2026-10-10, docs/TASK-MODEL.md
 * § Deadline, target, horizon), under the target line.
 *
 * The deadline has its OWN picker and no snooze button ever moves it — that is
 * the whole difference between it and the target above. Clearing it is the
 * picker's Clear.
 *
 * The horizon's own control moved to the chip row (`HorizonPicker`, 2026-10-15,
 * Trent: "why can't i set the horizon here?") so it is always settable; this
 * line keeps only the note below when the horizon isn't in effect.
 *
 * Staged like every other field in the panel: blue while dirty, saved with the
 * rest on Save.
 *
 * Recurring tasks (2026-10-12, Trent's morning QA): the deadline line says it
 * repeats ("· moves with each week", `repeatLabel`) — `advanceDeadline` carries
 * it to every next occurrence, the same distance after it — and the horizon is
 * hidden (`showHorizon`), because a recurring task never enters a task segment,
 * so its horizon does nothing; "Horizon: Unset" there read as broken.
 *
 * A one-off with a target of its own (2026-10-12, spec §1 — a target makes a
 * task quiet until its date): the horizon isn't in effect, and the line says
 * so — "Horizon not in effect · Target set: quiet until Nov 1" (`quietUntil`).
 * The chip above still changes it, ready for when the target goes. Only a REAL
 * target (stored, or one staged in the editor) says this: a task with none
 * once read "No target" and "quiet until Oct 15" at once (2026-10-15).
 */
export function TaskModelFields({
  deadline,
  deadlineDirty,
  timezone,
  onDeadline,
  repeatLabel = null,
  showHorizon = true,
  emptyAnchor = null,
  quietUntil = null,
}: {
  deadline: string | null
  deadlineDirty: boolean
  timezone: string
  onDeadline: (value: string | null) => void
  /** "moves with each week": the deadline follows each occurrence (`deadlineRepeatLabel`). */
  repeatLabel?: string | null
  /** False on a recurring task: it never enters a segment, so a horizon means nothing. */
  showHorizon?: boolean
  /** Where an empty deadline picker opens: a recurring task's occurrence target. */
  emptyAnchor?: string | null
  /** A one-off's own target: the horizon is greyed, "Target set: quiet until …". */
  quietUntil?: string | null
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
        emptyAnchor={emptyAnchor}
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
          {when && repeatLabel && (
            <span
              data-quick-panel-deadline-repeat
              className={cn(deadlineDirty ? 'text-blue-500' : 'text-muted-foreground')}
            >
              &middot; {repeatLabel}
            </span>
          )}
        </p>
      </DateTimePicker>
      {showHorizon && quietUntil && (
        <span
          data-quick-panel-horizon-quiet
          className="text-muted-foreground/60 inline-flex items-center gap-1"
          title="A target makes a task quiet until its date. Remove the target to use its horizon."
        >
          <span className="text-muted-foreground/50">{HORIZON_WORD} not in effect ·</span>
          {targetQuietUntil(DateTime.fromISO(quietUntil).setZone(timezone).toFormat('LLL d'))}
        </span>
      )}
    </div>
  )
}
