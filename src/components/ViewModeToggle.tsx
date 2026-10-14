'use client'

import { ArrowDownWideNarrow, List } from 'lucide-react'
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
  { value: 'project', label: 'Now', icon: List, hint: 'What matters now, grouped by project' },
  {
    value: 'new',
    label: 'Newest',
    icon: ArrowDownWideNarrow,
    hint: 'Everything, newest added first',
  },
]

/**
 * Switches how the task list is grouped: Now · Newest (2026-10-14).
 *
 * **Now** (`'project'`) is the front door: every open task grouped by project,
 * each project showing what matters now and folding the rest behind "+ N more
 * in <Project>" (the rule: `src/lib/now-view.ts`). The "N of M now · Show all
 * M" strip beside this switch lifts the folds — the old All.
 *
 * **Newest** (`'new'`) is one tap to everything newest-added first (a flat
 * list, each row naming its project — `src/lib/grouping.ts`).
 *
 * Deliberately few options, not a dropdown of every permutation: the point of
 * the redesign (REDESIGN-V03 §7.3) is fewer decisions at the front door, and a
 * picker with six entries would just be the 20-filter-chip problem in
 * miniature. 'unified' is driven by the AI-sort toggle elsewhere; showing it
 * here as an extra option would let the two controls disagree about what's
 * active. The Reminders surface (§6) once rode along as a chip too — it is a
 * real route (`/reminders`) with its own tab.
 *
 * History: All · Today · Newest from 2026-09-29. Today was the §7.3 front door
 * (today's tasks by time of day); All was everything grouped by project. On
 * 2026-10-14 All became Now — showing only what is relevant now — and Today
 * was dropped (Trent: "drop the separate Today view"), so Now answers "what
 * now" by itself. Newest's icon is a sort arrow, not Sparkles: Sparkles means
 * AI across the app, and most new tasks aren't AI-made (Trent picked the sort
 * arrow from a mockup, 09-29).
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
