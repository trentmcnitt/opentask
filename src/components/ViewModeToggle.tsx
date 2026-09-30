'use client'

import { ArrowDownWideNarrow, List, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GroupingMode } from '@/lib/grouping'

interface ViewModeToggleProps {
  grouping: GroupingMode
  onChange: (grouping: GroupingMode) => void
}

/**
 * The toggle's options, in order. Exported so `ViewModeFab` draws the same
 * icon and label for the view it announces — one list, so the two can't drift.
 *
 * 'unified' is driven by the AI-sort toggle elsewhere; showing it here as an
 * extra option would let the two controls disagree about what's active.
 */
export const VIEW_MODE_OPTIONS: readonly {
  value: GroupingMode
  label: string
  icon: typeof List
  hint: string
}[] = [
  { value: 'project', label: 'All', icon: List, hint: 'Everything, grouped by project' },
  { value: 'slot', label: 'Today', icon: Sun, hint: "Today's tasks by time of day" },
  {
    value: 'new',
    label: 'Newest',
    icon: ArrowDownWideNarrow,
    hint: 'Everything, newest added first',
  },
]

/**
 * Switches how the task list is grouped (REDESIGN-V03 §7.3).
 *
 * "Today" is the front door: today's work grouped by time slot, so opening the
 * app answers "what now" without scanning. The other two exist because §7.3 is
 * equally explicit that the corpus stays fully accessible — it just isn't what
 * greets you. Without a visible control the old views would be unreachable,
 * which would trade one kind of stuck for another.
 *
 * Deliberately few options, not a dropdown of every permutation: the point of
 * the redesign is fewer decisions at the front door, and a picker with six
 * entries would just be the 20-filter-chip problem in miniature.
 *
 * Every option here is a view of the same task list. The Reminders surface
 * (§6) used to ride along as a fourth chip — it is now a real route (`/reminders`)
 * with its own tab, so this control is back to doing exactly one job.
 *
 * All · Today · Newest (2026-09-29 — in that order; "Newest", not "New").
 * Newest is one tap to everything newest-added first (a flat list, each row
 * naming its project — `'new'` in `src/lib/grouping.ts`).
 *
 * All is everything grouped by project (`'project'`). On 2026-09-29 the
 * Projects view was retired by mistake and All showed due-date groups; "All"
 * had been meant as the by-project view, so it was restored as All on
 * 2026-09-30 and the due-date grouping went away. Newest's icon is
 * a sort arrow, not Sparkles: Sparkles means AI across the app, and most new
 * tasks aren't AI-made (Trent picked the sort arrow from a mockup, 09-29).
 * Today's icon is a sun, not a calendar-clock: the Overdue FAB already uses
 * CalendarClock, and the view-mode FAB (which takes its icon from these
 * options) would otherwise sit right above it wearing the same icon (Trent,
 * 09-29).
 */
export function ViewModeToggle({ grouping, onChange }: ViewModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="View mode"
      className="bg-muted/50 inline-flex items-center gap-0.5 rounded-lg p-0.5"
    >
      {VIEW_MODE_OPTIONS.map((option) => {
        const Icon = option.icon
        const active = grouping === option.value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            title={option.hint}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
