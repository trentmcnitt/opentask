'use client'

import type { GroupingMode } from '@/lib/grouping'
import { VIEW_MODE_OPTIONS } from '@/components/ViewModeToggle'

interface ViewModeFabProps {
  /** The dashboard's effective grouping — the one `ViewModeToggle` shows. */
  grouping: GroupingMode
  isSelectionMode: boolean
  /** Back to Now — the same `onGroupingChange('project')` a tap on "Now" makes. */
  onShowAll: () => void
}

/**
 * "You are not looking at everything" button (Trent, 2026-09-29: he got stuck
 * in Newest without noticing — the view toggle is up by the filters and
 * scrolls away, so nothing on screen said the list was a narrower view).
 *
 * **When it shows.** While the view is Newest (`'new'`) — the one view switch
 * option that isn't Now (Today, `'slot'`, was the other until it was dropped
 * on 2026-10-14). Not for `'unified'` (the AI-sort toggle's flat list,
 * which has its own control and isn't a `ViewModeToggle` option). Hidden in
 * selection mode, like the rest of the FAB column. Independent of the
 * Overdue filter: that is a filter over any view, so the two buttons can both
 * be lit at once.
 *
 * **What it looks like.** The view's own icon, read from `VIEW_MODE_OPTIONS`
 * so the button and the toggle can't disagree. Drawn as a pressed toggle, the
 * overdue button's "this is on" look — a `ring-2` with a `ring-offset-2` gap
 * around the disc — but in blue rather than coral, on a solid background-
 * coloured disc with a blue icon. A solid blue disc would be a twin of the
 * snooze FAB just below it (the reason the overdue button isn't blue either).
 *
 * **Tap:** back to Now, through the same `onGroupingChange` the toggle's "Now"
 * uses — so the preference is saved and AI-sort's unified override is cleared
 * exactly as a click on "Now" would. The button then disappears.
 *
 * It sits in `DashboardFabStack`, which places it; this component only draws.
 */
export function ViewModeFab({ grouping, isSelectionMode, onShowAll }: ViewModeFabProps) {
  if (isSelectionMode || grouping !== 'new') return null
  const option = VIEW_MODE_OPTIONS.find((o) => o.value === grouping)
  if (!option) return null
  const Icon = option.icon
  return (
    <button
      type="button"
      onClick={onShowAll}
      aria-label={`Viewing ${option.label} — tap to show Now`}
      title={`Viewing ${option.label} — tap to show Now`}
      data-view-mode-fab={grouping}
      className="bg-background ring-offset-background pointer-events-auto flex size-12 cursor-pointer items-center justify-center rounded-full text-blue-600 shadow-md ring-2 ring-blue-500 ring-offset-2 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/60"
    >
      <Icon className="size-5" aria-hidden />
    </button>
  )
}
