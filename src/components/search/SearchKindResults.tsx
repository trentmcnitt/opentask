'use client'

import { createContext, useContext } from 'react'
import { CalendarClock, ChevronRight, Gauge, Lightbulb } from 'lucide-react'
import { PriorityTabMark } from '@/components/RowCorner'
import { priorityTab } from '@/lib/row-corner'
import {
  SEARCH_KIND_WORDS,
  matchedKinds,
  searchWhere,
  type SearchKind,
  type SearchKindCounts,
  type SearchKindFilter,
} from '@/lib/search-kinds'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

/**
 * THE DASHBOARD'S SEARCH RESULTS ACROSS KINDS (Trent, 2026-11-12, mockup
 * S3; `src/lib/search-kinds.ts`): the kind chips, each group's heading, and
 * the pointer rows for reminders and quotas. Task hits are drawn by
 * `TaskList` with its real rows, between the Tasks heading and these.
 */

const KIND_LOOK: Readonly<
  Record<SearchKind, { Icon: typeof Gauge; color: string; title: string }>
> = {
  task: { Icon: CalendarClock, color: 'text-muted-foreground', title: 'Tasks' },
  reminder: { Icon: Lightbulb, color: 'text-badge-reminders', title: 'Reminders' },
  quota: { Icon: Gauge, color: 'text-indigo-600 dark:text-indigo-400', title: 'Quotas' },
}

/**
 * True inside the dashboard's search results: a task row there says "Task
 * queue · Weeks" when its horizon is what places it (`searchQueueWord`,
 * read by `LeanRow`'s meta line).
 */
export const SearchResultsContext = createContext(false)
export const useInSearchResults = () => useContext(SearchResultsContext)

/** All N · Tasks n · Reminders n · Quotas n — only the kinds that matched. */
export function SearchKindChips({
  counts,
  value,
  onChange,
}: {
  counts: SearchKindCounts
  value: SearchKindFilter
  onChange: (next: SearchKindFilter) => void
}) {
  const kinds = matchedKinds(counts)
  if (kinds.length === 0) return null
  const total = kinds.reduce((sum, kind) => sum + counts[kind], 0)
  const chip = (id: SearchKindFilter, label: React.ReactNode, count: number) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={value === id}
      data-search-kind-chip={id}
      onClick={() => onChange(id)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-0.5 text-sm font-medium whitespace-nowrap transition-colors',
        value === id
          ? 'bg-foreground text-background border-foreground'
          : 'border-border hover:bg-foreground/5',
      )}
    >
      {label}
      <span className={cn('text-xs tabular-nums', value === id ? 'opacity-80' : 'opacity-60')}>
        {count}
      </span>
    </button>
  )
  return (
    <div
      role="radiogroup"
      aria-label="Kinds of result"
      data-search-kind-chips
      className="mb-3 flex flex-wrap gap-2"
    >
      {chip('all', 'All', total)}
      {kinds.map((kind) => {
        const { Icon, color, title } = KIND_LOOK[kind]
        return chip(
          kind,
          <>
            <Icon className={cn('size-3.5', value === kind ? '' : color)} aria-hidden />
            {title}
          </>,
          counts[kind],
        )
      })}
    </div>
  )
}

/** A group's heading: its kind's mark, name and count. */
export function SearchKindHeading({ kind, count }: { kind: SearchKind; count: number }) {
  const { Icon, color, title } = KIND_LOOK[kind]
  return (
    <h2
      data-search-kind-heading={kind}
      className="text-muted-foreground mb-1 flex min-h-7 items-center gap-2 px-1 text-xs font-semibold tracking-wider uppercase"
    >
      <Icon className={cn('size-4', color)} aria-hidden />
      {title}
      <span className="font-normal opacity-70">{count}</span>
    </h2>
  )
}

/**
 * The reminders or quotas that matched, as POINTER rows — not check-offs:
 * the kind's mark, the title (with its "!" / "!!"), where it lives ("After
 * School · Daily", "2 a week · 1 done · After School"), and a chevron. A tap
 * goes to it (`onOpen`: the dashboard's lift for one waiting today, its
 * details otherwise).
 */
export function SearchPointerRows({
  kind,
  tasks,
  timeSlots,
  timezone,
  onOpen,
}: {
  kind: Exclude<SearchKind, 'task'>
  tasks: Task[]
  timeSlots: TimeSlot[]
  timezone: string
  onOpen: (task: Task) => void
}) {
  if (tasks.length === 0) return null
  const { Icon, color } = KIND_LOOK[kind]
  return (
    <section data-search-kind-section={kind} className="mt-6">
      <SearchKindHeading kind={kind} count={tasks.length} />
      <ul>
        {tasks.map((task) => {
          const tab = task.priority >= 3 ? priorityTab(task.priority, 'icons') : null
          const where = searchWhere(task, timeSlots, timezone)
          return (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpen(task)}
                data-search-pointer-row={task.id}
                aria-label={`${task.title} — ${SEARCH_KIND_WORDS[kind].one}${where ? `, ${where}` : ''}. Go to it.`}
                className="border-border/40 hover:bg-foreground/[0.04] flex w-full items-start gap-3 border-b px-1 py-2.5 text-left"
              >
                <Icon className={cn('mt-1 size-4 shrink-0', color)} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] leading-6 font-medium break-words">
                    {task.title}
                    {tab && <PriorityTabMark tab={tab} inline className="ml-1.5" />}
                  </span>
                  {where && (
                    <span data-search-where className="text-muted-foreground block text-xs">
                      {where}
                    </span>
                  )}
                </span>
                <ChevronRight
                  className="text-muted-foreground/60 mt-1 size-4 shrink-0"
                  aria-hidden
                />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
