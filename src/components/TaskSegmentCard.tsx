'use client'

import { useState } from 'react'
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
 * One TASK SEGMENT on a reminders surface (2026-10-10, docs/TASK-MODEL.md
 * § Task segments).
 *
 * Tasks whose target hasn't arrived, for awareness — one segment per horizon,
 * each on its own day, shown UNDER the reminder slots (Trent, 10-11: "Tasks
 * should go underneath Reminders"; it replaced 10-10's "first"). Separate from
 * the time slots, and never counted in the headline, the nav badge or
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
 * Considered rows LEAVE the list like considered reminders, so the next row
 * moves up under the pointer; the bar counts them, so the segment goes green.
 * Deferred ones leave for today. A segment with nothing left waiting is finished for
 * the day. Over SEGMENT_NUDGE_THRESHOLD items it suggests Process or AI help.
 */
/** Rows a segment shows on the dashboard panel before "Show all". */
export const PANEL_SEGMENT_CAP = 6

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
  const [showAll, setShowAll] = useState(false)
  // Only what still waits is listed (Trent, 10-11: "that's not how it works
  // with Reminders"): a considered row LEAVES, so the next one moves up under
  // the pointer and the list can be tapped through without moving the mouse.
  // The bar above still counts the considered ones, so the segment goes green.
  const shown = segment.rows.filter((r) => r.state === 'waiting')
  // The dashboard panel shares its column with the slot pager, so a long
  // segment shows its first PANEL_SEGMENT_CAP rows and a "Show all" (the slot
  // cards' own cap pattern). The Reminders page shows everything.
  const capped = panel && !showAll && shown.length > PANEL_SEGMENT_CAP
  const visible = capped ? shown.slice(0, PANEL_SEGMENT_CAP) : shown
  const total = segment.rows.length
  const doneCount = segment.considered + segment.deferred
  const finished = segment.waiting === 0
  return (
    <section
      aria-label={`Tasks: ${HORIZON_LABELS[segment.horizon]}`}
      data-task-segment={segment.horizon}
      // The card's inset + the row's own padding = the slot rows' (12px on both
      // surfaces), so circles and checkboxes line up down the whole column.
      className={cn(panel ? 'px-2 pt-3 pb-2' : 'bg-muted/30 rounded-2xl px-1 py-3')}
    >
      <div className={cn('flex items-start gap-2', panel ? 'px-1' : 'px-2')}>
        <div className="min-w-0 flex-1">
          <h2 className="text-foreground text-sm font-semibold">
            Tasks · {HORIZON_LABELS[segment.horizon]}
            {/* "X of Y", the slots' count (Trent, 2026-10-11): X is what was
                handled today — considered, or deferred by Defer all — and Y
                the segment's size today, so the number climbs rather than
                counting down. A task marked done leaves the segment
                altogether, so it is in neither. */}
            <span
              className={cn(
                'ml-2 text-xs font-normal tabular-nums',
                finished ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
              )}
              aria-label={`${doneCount} of ${total} considered`}
            >
              <span className={cn(!finished && 'text-foreground font-medium')}>{doneCount}</span> of{' '}
              {total}
              {finished && (
                <Check className="ml-1 inline size-3.5 align-[-2px]" strokeWidth={2.5} />
              )}
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
      </div>

      <div
        className={cn(
          'bg-foreground/10 mt-2 mb-2 h-1 overflow-hidden rounded-full',
          panel ? 'mx-1' : 'mx-2',
        )}
        aria-hidden
      >
        <div
          className="h-full rounded-full bg-green-600 transition-[width]"
          style={{ width: `${total === 0 ? 0 : (doneCount / total) * 100}%` }}
        />
      </div>

      {/* Counted from what still waits, so it leaves as rows are considered,
          without waiting for the next fetch (the server's `nudge` rule). */}
      {segment.waiting > SEGMENT_NUDGE_THRESHOLD && (
        <p
          className={cn(
            'text-muted-foreground mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs',
            panel ? 'mx-1' : 'mx-2',
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
      )}

      <ul className="space-y-0.5">
        {visible.map((row) => (
          <TaskSegmentRow
            key={row.task.id}
            row={row}
            actions={actions}
            timezone={timezone}
            panel={panel}
            segmentHorizon={segment.horizon}
          />
        ))}
      </ul>
      {panel && shown.length > PANEL_SEGMENT_CAP && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground mt-1 w-full rounded-md py-1.5 text-xs font-medium"
        >
          {showAll ? 'Show fewer' : `Show all ${shown.length}`}
        </button>
      )}
      <SegmentConsideredDisclosure
        rows={segment.rows.filter((r) => r.state !== 'waiting')}
        label={HORIZON_LABELS[segment.horizon]}
        onPutBack={(task) => void actions.restore(task)}
      />
    </section>
  )
}

function TaskSegmentRow({
  row,
  actions,
  timezone,
  panel,
  segmentHorizon,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
  segmentHorizon: HorizonValue
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
      // checkboxes must line up down the whole card): on the panel the
      // panel's reminder row (`gap-2.5 px-1 py-1.5`, 19px controls, 13.5px
      // title), on /reminders the page's (`gap-3 px-2 py-2.5`, 24px controls,
      // 16px title) — `QuotaPromptRow`'s two variants, exactly.
      className={cn(
        'group flex items-start rounded-xl',
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
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5 sm:gap-1.5',
            panel ? '-my-[3px]' : 'mt-[3px]',
          )}
        >
          <HorizonChip
            task={task}
            segmentHorizon={segmentHorizon}
            onChange={(h) => void actions.setHorizon(task, h)}
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
      )}
    </li>
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
 * "Show N considered" (2026-10-11): today's considered and deferred rows,
 * folded away by default so the rapid-fire list stays short — the slots'
 * `ConsideredDisclosure`, on both the Reminders page and the dashboard panel.
 * A row's filled circle puts it back (`/api/task-segments/restore`): it waits
 * again, and comes back daily until it is considered.
 */
function SegmentConsideredDisclosure({
  rows,
  label,
  onPutBack,
}: {
  rows: SegmentRow[]
  label: string
  onPutBack: (task: Task) => void
}) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-segment-considered-toggle
        className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground mt-1 w-full rounded-lg py-2 pl-9 text-left text-xs font-medium transition-colors"
      >
        {open ? 'Hide' : 'Show'} {rows.length} considered
      </button>
      {open && (
        <ul className="space-y-0.5 px-1" aria-label={`Considered in Tasks · ${label}`}>
          {rows.map(({ task, state }) => (
            <li
              key={task.id}
              data-considered-task-id={task.id}
              className="flex items-start gap-3 rounded-xl px-2 py-2"
            >
              <button
                type="button"
                onClick={() => onPutBack(task)}
                aria-label={`Put back "${task.title}"`}
                title="Put back"
                className="mt-0.5 flex size-[19px] shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-600/50"
              >
                <Check className="size-3" strokeWidth={3} />
              </button>
              <p className="text-muted-foreground min-w-0 flex-1 text-[14px] leading-snug text-pretty">
                {task.title}
                {state === 'deferred' && <span className="ml-1.5 text-xs">· deferred</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
