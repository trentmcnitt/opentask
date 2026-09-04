'use client'

import { CalendarClock, FolderTree, List } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GroupingMode } from '@/components/TaskList'

interface ViewModeToggleProps {
  grouping: GroupingMode
  onChange: (grouping: GroupingMode) => void
}

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
 * Every option here is a grouping of the same task list. The Reminders surface
 * (§6) used to ride along as a fourth chip — it is now a real route (`/reminders`)
 * with its own tab, so this control is back to doing exactly one job.
 */
export function ViewModeToggle({ grouping, onChange }: ViewModeToggleProps) {
  // 'unified' is driven by the AI-sort toggle elsewhere; showing it here as an
  // extra option would let the two controls disagree about what's active.
  const options: { value: GroupingMode; label: string; icon: typeof List; hint: string }[] = [
    { value: 'slot', label: 'Today', icon: CalendarClock, hint: "Today's tasks by time of day" },
    { value: 'project', label: 'Projects', icon: FolderTree, hint: 'Group by project' },
    { value: 'time', label: 'All', icon: List, hint: 'Everything by due date' },
  ]

  return (
    <div
      role="group"
      aria-label="View mode"
      className="bg-muted/50 inline-flex items-center gap-0.5 rounded-lg p-0.5"
    >
      {options.map((option) => {
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
