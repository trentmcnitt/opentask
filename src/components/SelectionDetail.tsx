'use client'

import { ChevronDown, Flag, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HorizonDotMark, HorizonMenuContent } from '@/components/HorizonDot'
import { useDayStart } from '@/components/PreferencesProvider'
import { useProjects } from '@/components/ProjectsProvider'
import { getPriorityOption } from '@/lib/priority'
import { momentChipWords } from '@/lib/moment-chip-words'
import { QUEUE_TOMORROW, queueMarked } from '@/lib/queue-tomorrow'
import { horizonOf } from '@/lib/row-corner'
import { HORIZON_LABELS, HORIZON_WORD, UNSET_HORIZON_WORDS } from '@/lib/task-model-words'
import type { HorizonValue } from '@/lib/task-segments'
import type { Task } from '@/types'

/**
 * THE SELECT BAR'S DETAILS AND HORIZON (Trent, 2026-10-30; mockups
 * `.tmp/select-detail/`, L1 and the horizon ruling): with exactly one task
 * picked, the bar opens with that task — its title on the count's line, then
 * its meta line, its notes (only when it has some, two lines), and Open ·
 * Show in list. The long-press bubble's contents, in the bar. A second pick
 * drops them for "N selected".
 *
 * THE HORIZON is a control in that meta line — dot, word and chevron
 * ("● Days ⌄") — opening the SAME menu as the task details' horizon
 * (`HorizonMenuContent`): "I don't see why we can't just tap the horizon from
 * that menu and have it do a dropdown the same way that we change horizon in
 * the task details page." With several picked it sits on the "N selected"
 * line beside ⋯: "● Weeks ⌄" when they all share one, "Mixed ⌄" otherwise
 * (nothing marked in the menu). A pick sets every picked task's horizon in
 * one request, with one Undo.
 */

/** The picked tasks' one horizon (null: unset), or 'mixed'. */
export function sharedHorizon(
  tasks: readonly Pick<Task, 'horizon'>[],
): HorizonValue | null | 'mixed' {
  const values = new Set(tasks.map((t) => horizonOf(t.horizon)))
  return values.size === 1 ? [...values][0] : 'mixed'
}

/** The bar's horizon control: "● Days ⌄", "Weeks (unset) ⌄" or "Mixed ⌄". */
export function BarHorizonControl({
  tasks,
  onChange,
}: {
  tasks: readonly Pick<Task, 'horizon'>[]
  onChange: (horizon: HorizonValue | null) => void
}) {
  const value = sharedHorizon(tasks)
  const label = value === 'mixed' ? 'Mixed' : value ? HORIZON_LABELS[value] : UNSET_HORIZON_WORDS
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-bar-horizon={value ?? 'unset'}
        aria-label={`${HORIZON_WORD}: ${label}. Change`}
        className={cn(
          'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs transition-colors',
          'text-white/80 hover:bg-white/10 data-[state=open]:bg-white/15',
          value === null && 'italic',
        )}
      >
        {value !== 'mixed' && <HorizonDotMark horizon={value} className="text-white" />}
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <HorizonMenuContent value={value} onChange={onChange} align="start" />
    </DropdownMenu>
  )
}

/**
 * The one picked task's lines under its title: the meta line (project ·
 * target · deadline · priority · horizon), its notes when it has some, and
 * Open · Show in list.
 */
export function SelectionDetailLines({
  task,
  timezone,
  onHorizon,
  onOpen,
  onShowInList,
}: {
  task: Task
  timezone: string
  onHorizon: (horizon: HorizonValue | null) => void
  onOpen: () => void
  onShowInList?: () => void
}) {
  const dayStart = useDayStart()
  const { projects } = useProjects()
  const project = projects.find((p) => p.id === task.project_id)
  const priority = task.priority > 0 ? getPriorityOption(task.priority) : null
  const notes = task.notes?.trim()
  const parts = [
    <span key="project" className="inline-flex items-center gap-1">
      <Folder className="size-3" aria-hidden />
      {project?.name ?? 'Inbox'}
    </span>,
    task.due_at && (
      <span key="target" data-selection-detail-target>
        {queueMarked(task) ? QUEUE_TOMORROW : momentChipWords(task.due_at, timezone, dayStart)}
      </span>
    ),
    task.deadline_at && (
      <span key="deadline" className="inline-flex items-center gap-1 text-teal-300">
        <Flag className="size-3" aria-hidden />
        {momentChipWords(task.deadline_at, timezone, dayStart)}
      </span>
    ),
    priority && (
      <span key="priority" className={cn(task.priority >= 3 && 'text-orange-300')}>
        {priority.label}
      </span>
    ),
  ].filter(Boolean)
  return (
    <div data-selection-detail className="px-2 pb-0.5">
      <div
        data-selection-detail-meta
        className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-white/60"
      >
        {parts.map((part, i) => (
          <span key={i} className="contents">
            {i > 0 && <span aria-hidden>·</span>}
            {part}
          </span>
        ))}
        <span aria-hidden>·</span>
        <span className="-ml-1">
          <BarHorizonControl tasks={[task]} onChange={onHorizon} />
        </span>
      </div>
      {notes && (
        <p
          data-selection-detail-notes
          className="mt-1 line-clamp-2 text-xs break-words whitespace-pre-line text-white/70"
        >
          {notes}
        </p>
      )}
      <div className="mt-1 flex gap-3 text-xs">
        <button
          type="button"
          data-selection-open
          onClick={onOpen}
          className="text-blue-300 hover:text-blue-200"
        >
          Open
        </button>
        {onShowInList && (
          <button
            type="button"
            data-selection-show-in-list
            onClick={onShowInList}
            className="text-blue-300 hover:text-blue-200"
          >
            Show in list
          </button>
        )}
      </div>
    </div>
  )
}
