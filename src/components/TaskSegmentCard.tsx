'use client'

import { Check, CalendarClock, ChevronDown } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  HORIZON_HINTS,
  HORIZON_LABELS,
  HORIZON_UNSET_LABEL,
  HORIZON_WORD,
} from '@/lib/task-model-words'
import { HORIZON_ORDER, SEGMENT_NUDGE_THRESHOLD, type HorizonValue } from '@/lib/task-segments'
import type { SegmentRow, SegmentView, TaskSegmentActions } from '@/hooks/useTaskSegments'
import type { Task } from '@/types'

/**
 * One TASK SEGMENT on a reminders surface (2026-10-10, docs/TASK-MODEL.md
 * § Task segments).
 *
 * Tasks whose target hasn't arrived, for awareness — one segment per horizon,
 * each on its own day, shown FIRST: "tasks are an early-day thing". Separate
 * from the time slots, and never counted in the headline, the nav badge or
 * "Considered all so far".
 *
 * The row copies the reminder row (`ReminderRow`) where it can — the circle on
 * the left in the same place, the 16px wrapping title, never truncated — and
 * the quota prompt row's square on the right for "done", because a task row
 * has the same two verbs a prompt has: the CIRCLE means "considered" (seen,
 * never a completion) and the CHECKBOX means done. A tap anywhere else on the
 * row considers it, as on a reminder, so the rapid-fire flow is unchanged.
 * "Today" (target today) sits just left of the checkbox.
 *
 * The meta line shows the HORIZON (a chip that changes it — an unset one says
 * so rather than pretending to be "weeks"), a future target as a date chip
 * ("Nov 1"), and the deadline.
 *
 * Considered rows stay, filled green, so the segment can go green; deferred
 * ones leave for today. A segment with nothing left waiting is finished for
 * the day. Over SEGMENT_NUDGE_THRESHOLD items it suggests Process or AI help.
 */
export function TaskSegmentCard({
  segment,
  actions,
  timezone,
  variant = 'surface',
}: {
  segment: SegmentView
  actions: TaskSegmentActions
  timezone: string
  variant?: 'surface' | 'panel'
}) {
  const panel = variant === 'panel'
  const total = segment.rows.length
  const doneCount = segment.considered + segment.deferred
  const finished = segment.waiting === 0
  return (
    <section
      aria-label={`Tasks: ${HORIZON_LABELS[segment.horizon]}`}
      data-task-segment={segment.horizon}
      className={cn(panel ? 'px-3 pt-3 pb-2' : 'bg-muted/30 rounded-2xl px-3 py-3')}
    >
      <header className="flex items-start gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-foreground text-sm font-semibold">
            Tasks · {HORIZON_LABELS[segment.horizon]}
            <span className="text-muted-foreground ml-2 text-xs font-normal">
              {finished ? 'Done for today' : `${segment.waiting} to consider`}
            </span>
          </h2>
          <p className="text-muted-foreground/80 text-xs">{HORIZON_HINTS[segment.horizon]}</p>
        </div>
        {!finished && (
          <button
            type="button"
            onClick={() => void actions.deferAll(segment)}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 shrink-0 rounded-md px-2 py-1 text-xs font-medium"
            title="Take the rest off today's list; they come back tomorrow"
          >
            Defer all
          </button>
        )}
      </header>

      <div className="bg-foreground/10 mx-1 mt-2 mb-2 h-1 overflow-hidden rounded-full" aria-hidden>
        <div
          className="h-full rounded-full bg-green-600 transition-[width]"
          style={{ width: `${total === 0 ? 0 : (doneCount / total) * 100}%` }}
        />
      </div>

      {segment.nudge && (
        <p className="text-muted-foreground mx-1 mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs">
          Over {SEGMENT_NUDGE_THRESHOLD} tasks here. Use{' '}
          <button
            type="button"
            className="text-foreground underline underline-offset-2"
            onClick={() => window.dispatchEvent(new CustomEvent('open-process'))}
          >
            Process
          </button>{' '}
          or ask the AI to help thin this out.
        </p>
      )}

      <ul className="space-y-0.5">
        {segment.rows
          .filter((r) => r.state !== 'deferred')
          .map((row) => (
            <TaskSegmentRow
              key={row.task.id}
              row={row}
              actions={actions}
              timezone={timezone}
              panel={panel}
            />
          ))}
      </ul>
    </section>
  )
}

function TaskSegmentRow({
  row,
  actions,
  timezone,
  panel,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
}) {
  const { task } = row
  const considered = row.state === 'considered'
  const consider = () => {
    if (!considered) void actions.consider(task)
  }
  return (
    <li
      data-segment-task={task.id}
      data-segment-state={row.state}
      tabIndex={considered ? -1 : 0}
      onClick={consider}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          consider()
        }
      }}
      className={cn(
        'group flex items-start gap-3 rounded-lg px-1 py-1.5',
        considered ? 'opacity-60' : 'hover:bg-foreground/[0.03] cursor-pointer',
      )}
    >
      {considered ? (
        <span
          aria-hidden
          className="mt-[3px] flex size-6 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"
        >
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            consider()
          }}
          aria-label={`Mark "${task.title}" as considered`}
          title="Considered (seen — not done)"
          className="border-foreground/20 hover:border-foreground/60 hover:bg-foreground/5 mt-[3px] flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors"
        >
          <Check
            className="group-hover:text-foreground/40 size-3.5 text-transparent transition-colors"
            strokeWidth={3}
          />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn('text-pretty', panel ? 'text-[13.5px] leading-5' : 'text-[16px] leading-6')}
        >
          <span className={task.priority >= 3 ? 'text-foreground font-medium' : 'text-foreground'}>
            {task.title}
          </span>
        </p>
        <TaskSegmentMeta task={task} timezone={timezone} actions={actions} />
      </div>
      {!considered && (
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void actions.targetToday(task)
            }}
            title="Target today — start nagging at the next period"
            aria-label={`Target "${task.title}" today`}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium"
          >
            <CalendarClock className="size-3.5" />
            <span className={panel ? 'sr-only sm:not-sr-only' : undefined}>Today</span>
          </button>
          <Checkbox
            checked={false}
            onCheckedChange={() => void actions.done(task)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Done: "${task.title}"`}
            title="Done"
            className="size-6 cursor-pointer"
          />
        </div>
      )}
    </li>
  )
}

function TaskSegmentMeta({
  task,
  timezone,
  actions,
}: {
  task: Task
  timezone: string
  actions: TaskSegmentActions
}) {
  const target = task.due_at ? DateTime.fromISO(task.due_at).setZone(timezone) : null
  const deadline = task.deadline_at ? DateTime.fromISO(task.deadline_at).setZone(timezone) : null
  return (
    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <HorizonChip task={task} onChange={(h) => void actions.setHorizon(task, h)} />
      {target && (
        <span data-target-chip title={`Target ${target.toFormat('ccc LLL d, h:mm a')}`}>
          {target.toFormat('LLL d')}
        </span>
      )}
      {deadline && (
        <span data-deadline-chip className="text-amber-700 dark:text-amber-400">
          deadline {deadline.toFormat('LLL d')}
        </span>
      )}
    </div>
  )
}

/**
 * The horizon, visible and changeable (spec §3). Unset shows as "Unset" — it
 * is treated as weeks, but never reported as if the user had said so.
 */
export function HorizonChip({
  task,
  onChange,
}: {
  task: Pick<Task, 'horizon' | 'title'>
  onChange: (horizon: HorizonValue | null) => void
}) {
  const label = task.horizon ? HORIZON_LABELS[task.horizon] : HORIZON_UNSET_LABEL
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        data-horizon-chip
        aria-label={`${HORIZON_WORD}: ${label}. Change`}
        className={cn(
          'hover:bg-foreground/5 inline-flex items-center gap-0.5 rounded px-1 py-0.5',
          task.horizon ? 'text-foreground/70' : 'text-muted-foreground/70 italic',
        )}
      >
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>{HORIZON_WORD}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={task.horizon ?? 'unset'}
          onValueChange={(v) => onChange(v === 'unset' ? null : (v as HorizonValue))}
        >
          {HORIZON_ORDER.map((h) => (
            <DropdownMenuRadioItem key={h} value={h}>
              {HORIZON_LABELS[h]}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="unset">{HORIZON_UNSET_LABEL} (weeks)</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
