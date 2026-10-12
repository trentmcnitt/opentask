'use client'

import { Check, CalendarClock, ChevronDown, FolderOpen } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { getPriorityOption } from '@/lib/priority'
import { useProjects } from '@/components/ProjectsProvider'
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
 * A TASK SEGMENT's rows (2026-10-10, docs/TASK-MODEL.md § Task segments).
 *
 * Tasks whose target hasn't arrived, for awareness — one segment per horizon,
 * each on its own day. Since 2026-10-11 a segment is a SEGMENT of the
 * reminders structure rather than a card of its own (Trent: "why isn't tasks
 * segmented like reminders? days, weeks, etc. should be individual segments
 * and behave similarly to the segments for reminders"): a page of the
 * dashboard panel's pager after the slots (`DashboardRemindersPanel`), and a
 * section shaped like a slot's on /reminders (`reminders/TaskSegmentGroup`).
 * This file holds what both draw inside that frame: the row, its horizon chip,
 * the over-50 nudge, and the considered row with its put-back. Never counted
 * in the headline, the nav badge or "Considered all so far".
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
 * Considered rows LEAVE the list like considered reminders, so the next row
 * moves up under the pointer; the segment's "X of Y" counts them. Deferred
 * ones leave for today. A segment with nothing left waiting is finished for
 * the day.
 */

/** A segment's rows still waiting — the only ones listed (Trent, 10-11: a
 *  considered row leaves, "that's how it works with Reminders"). */
export function waitingRows(segment: SegmentView): SegmentRow[] {
  return segment.rows.filter((r) => r.state === 'waiting')
}

/** Its considered and deferred rows, behind "Show N considered". */
export function handledRows(segment: SegmentView): SegmentRow[] {
  return segment.rows.filter((r) => r.state !== 'waiting')
}

/**
 * "X of Y" for a segment, the slots' count (Trent, 2026-10-11): X is what was
 * handled today — considered, or deferred by Defer all — and Y the segment's
 * size today, so the number climbs rather than counting down. A task marked
 * done leaves the segment altogether, so it is in neither.
 */
export function segmentCounts(segment: SegmentView): { handled: number; total: number } {
  return { handled: segment.considered + segment.deferred, total: segment.rows.length }
}

/** "Tasks · Days": the segment's name on both surfaces. */
export function segmentLabel(segment: SegmentView): string {
  return `Tasks · ${HORIZON_LABELS[segment.horizon]}`
}

/** What sits where a slot shows its start time: when the segment comes round. */
export function segmentHint(segment: SegmentView): string {
  return HORIZON_HINTS[segment.horizon]
}

/**
 * A segment's colour (2026-10-11, Trent's pick): one teal per horizon, darkest
 * for the soonest — the `--segment-*` tokens in globals.css, light and dark.
 * It fills the segment's bar while it fills (finished is green, like a slot),
 * rings the bar of the page on screen, and colours the segment's title.
 */
export function segmentColor(horizon: HorizonValue): string {
  return `var(--segment-${horizon})`
}

/**
 * A segment TITLE's colour: `--segment-title-*`. Its own token so the title can
 * be tuned apart from the bar — in light mode every title is one darker teal
 * (the lighter fills are too faint for small text); in dark mode it is the fill.
 */
export function segmentTitleColor(horizon: HorizonValue): string {
  return `var(--segment-title-${horizon})`
}

/** The pager page / section key of a segment — never a slot id ("tasks:days"). */
export function segmentKey(segment: SegmentView): string {
  return `tasks:${segment.horizon}`
}

/**
 * Over SEGMENT_NUDGE_THRESHOLD waiting, a nudge toward Process or the AI.
 * Counted from what still waits, so it leaves as rows are considered, without
 * waiting for the next fetch (the server's `nudge` rule).
 */
export function SegmentNudge({ segment, className }: { segment: SegmentView; className?: string }) {
  if (segment.waiting <= SEGMENT_NUDGE_THRESHOLD) return null
  return (
    <p
      className={cn(
        'text-muted-foreground mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs',
        className,
      )}
    >
      Over {SEGMENT_NUDGE_THRESHOLD} tasks to consider. Use{' '}
      <button
        type="button"
        className="text-foreground underline underline-offset-2"
        onClick={() => window.dispatchEvent(new CustomEvent('open-process'))}
      >
        Process
      </button>{' '}
      or ask the AI to help thin this out.
    </p>
  )
}

export function TaskSegmentRow({
  row,
  actions,
  timezone,
  panel,
  segmentHorizon,
  hiddenWhenNarrow = false,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
  segmentHorizon: HorizonValue
  /** Past the panel's narrow cap: in the DOM, on screen only from `xl` up —
   *  the panel's slot rows' own rule (`PanelRow`). */
  hiddenWhenNarrow?: boolean
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
      // The SAME geometry as the rows around it (Trent, 2026-10-11: circles and
      // checkboxes must line up down the whole column): on the panel the
      // panel's reminder row (`gap-2.5 px-1 py-1.5`, 19px controls, 13.5px
      // title), on /reminders the page's (`gap-3 px-2 py-2.5`, 24px controls,
      // 16px title) — `QuotaPromptRow`'s two variants, exactly.
      className={cn(
        'group items-start rounded-xl',
        hiddenWhenNarrow ? 'hidden xl:flex' : 'flex',
        panel ? 'gap-2.5 px-1 py-1.5' : 'gap-3 px-2 py-2.5',
        considered
          ? 'opacity-60'
          : cn('cursor-pointer', panel ? 'hover:bg-foreground/5' : 'hover:bg-foreground/[0.04]'),
      )}
    >
      {considered ? (
        <span
          aria-hidden
          className={cn(
            'flex shrink-0 items-center justify-center rounded-full bg-green-600 text-white',
            panel ? 'size-[19px]' : 'mt-[3px] size-6',
          )}
        >
          <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
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
          className={cn(
            'hover:border-foreground/60 hover:bg-foreground/5 flex shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors',
            panel ? 'border-foreground/25 size-[19px]' : 'border-foreground/20 mt-[3px] size-6',
          )}
        >
          <Check
            className={cn(
              'group-hover:text-foreground/40 text-transparent transition-colors',
              panel ? 'size-3' : 'size-3.5',
            )}
            strokeWidth={3}
          />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-foreground text-pretty',
            panel ? 'text-[13.5px] leading-[1.42]' : 'text-[16px] leading-6',
          )}
        >
          {task.title}
        </p>
        <TaskSegmentMeta task={task} timezone={timezone} />
      </div>
      {!considered && (
        <TaskSegmentRowActions
          task={task}
          actions={actions}
          panel={panel}
          segmentHorizon={segmentHorizon}
        />
      )}
    </li>
  )
}

/** The row's right side: horizon chip, "Today", and the done square. */
function TaskSegmentRowActions({
  task,
  actions,
  panel,
  segmentHorizon,
}: {
  task: Task
  actions: TaskSegmentActions
  panel: boolean
  segmentHorizon: HorizonValue
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 sm:gap-1.5',
        panel ? '-my-[3px]' : 'mt-[3px]',
      )}
    >
      <HorizonChip
        task={task}
        segmentHorizon={segmentHorizon}
        onChange={(h) => void actions.setHorizon(task, h, segmentHorizon)}
      />
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
        {/* Icon-only on a phone, so the title keeps the width. */}
        <span className="sr-only sm:not-sr-only">Today</span>
      </button>
      {/* The quota prompt's did-it square (`QuotaPromptRow`), not the
          stock checkbox: same size, radius, border and no shadow. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void actions.done(task)
        }}
        aria-label={`Done: "${task.title}"`}
        title="Done"
        className={cn(
          'group/done border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 flex shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-[1.5px] transition-colors',
          panel ? 'size-[19px]' : 'size-6',
        )}
      >
        <Check
          className={cn(
            'group-hover/done:text-foreground/50 text-transparent transition-colors',
            panel ? 'size-3' : 'size-3.5',
          )}
          strokeWidth={3}
        />
      </button>
    </div>
  )
}

/**
 * The second line, only when there is something to say: a future target date
 * ("Nov 1") or a deadline. Without either the row is one line, a reminder row's
 * height — the segment stays bite-size.
 */
function TaskSegmentMeta({ task, timezone }: { task: Task; timezone: string }) {
  const { projects } = useProjects()
  const project = projects.find((p) => p.id === task.project_id)
  const priority = task.priority > 0 ? getPriorityOption(task.priority) : null
  const target = task.due_at ? DateTime.fromISO(task.due_at).setZone(timezone) : null
  const deadline = task.deadline_at ? DateTime.fromISO(task.deadline_at).setZone(timezone) : null
  // The dashboard row's context, compactly (Trent, 10-11): the project, the
  // priority, a future target and the deadline. Segments hold one-off tasks
  // only, so there is never a recurrence to show.
  return (
    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {project && (
        <span data-segment-project className="inline-flex items-center gap-1">
          <FolderOpen className="size-3" aria-hidden />
          {project.name}
        </span>
      )}
      {priority && (
        <span data-segment-priority className={priority.color}>
          {priority.label}
        </span>
      )}
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
 * The horizon, visible and changeable (spec §3). Unset is never reported as if
 * the user had said "weeks".
 *
 * On a segment row (`segmentHorizon` given) the segment header already names
 * the horizon, so the chip is quiet: its word shows only when the task's own
 * horizon differs from the segment's (a deadline pulled it in), a faint dot
 * marks unset, and otherwise it is just the small chevron — still one tap to
 * change. In the editor it always shows its word.
 */
export function HorizonChip({
  task,
  onChange,
  segmentHorizon,
}: {
  task: Pick<Task, 'horizon' | 'title'>
  onChange: (horizon: HorizonValue | null) => void
  segmentHorizon?: HorizonValue
}) {
  const label = task.horizon ? HORIZON_LABELS[task.horizon] : HORIZON_UNSET_LABEL
  const quiet = segmentHorizon !== undefined
  const shown = !quiet || (task.horizon !== null && task.horizon !== segmentHorizon)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        data-horizon-chip
        aria-label={`${HORIZON_WORD}: ${label}. Change`}
        title={`${HORIZON_WORD}: ${label}`}
        className={cn(
          'hover:bg-foreground/5 inline-flex items-center gap-0.5 rounded px-1 py-1 text-xs',
          task.horizon ? 'text-foreground/60' : 'text-muted-foreground/70 italic',
        )}
      >
        {quiet && !task.horizon && (
          <span aria-hidden className="bg-muted-foreground/40 size-1.5 rounded-full" />
        )}
        {shown && label}
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

/**
 * One considered (or deferred) task behind a segment's "Show N considered" —
 * the slots' considered row on each surface (`ConsideredRow` on /reminders,
 * the panel's `ConsideredList` row), so the lists line up. Its filled circle
 * puts it back (`/api/task-segments/restore`, 2026-10-11): it waits again, and
 * comes back daily until it is considered.
 */
export function ConsideredSegmentRow({
  row,
  panel,
  onPutBack,
}: {
  row: SegmentRow
  panel: boolean
  onPutBack: (task: Task) => void
}) {
  const { task, state } = row
  return (
    <li
      data-considered-task-id={task.id}
      className={cn(
        'flex items-start rounded-xl',
        panel ? 'gap-2.5 px-1 py-1.5' : 'gap-3 px-2 py-2.5',
      )}
    >
      <button
        type="button"
        onClick={() => onPutBack(task)}
        aria-label={`Put back "${task.title}"`}
        title="Put back"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-600/50',
          panel ? 'size-[19px]' : 'mt-[3px] size-6',
        )}
      >
        <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
      </button>
      <p
        className={cn(
          'text-muted-foreground min-w-0 flex-1 text-pretty',
          panel ? 'text-[13.5px] leading-[1.42]' : 'text-[16px] leading-6',
        )}
      >
        {task.title}
        {state === 'deferred' && <span className="ml-1.5 text-xs">· deferred</span>}
      </p>
    </li>
  )
}
