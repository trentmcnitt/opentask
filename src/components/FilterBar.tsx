import { X } from 'lucide-react'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { PriorityFilterBar } from '@/components/PriorityFilterBar'
import type { Task } from '@/types'

/**
 * Combined filter bar for priority and label filters.
 * Priority badges (square) appear first, then a gray separator, then label badges (pill).
 * The separator only appears if both filter types have content.
 */
export function FilterBar({
  tasks,
  selectedPriorities,
  selectedLabels,
  onTogglePriority,
  onToggleLabel,
  onClearAll,
}: {
  tasks: Task[]
  selectedPriorities: number[]
  selectedLabels: string[]
  onTogglePriority: (priority: number) => void
  onToggleLabel: (label: string) => void
  onClearAll: () => void
}) {
  const hasPriorities = tasks.some((t) => t.priority > 0)
  const hasLabels = tasks.some((t) => t.labels.length > 0)

  if (!hasPriorities && !hasLabels) return null

  const hasSelection = selectedPriorities.length > 0 || selectedLabels.length > 0

  return (
    <div className="relative mb-4 flex items-center">
      <div className="scrollbar-hide flex flex-1 items-center gap-2 overflow-x-auto pr-8">
        <PriorityFilterBar
          tasks={tasks}
          selectedPriorities={selectedPriorities}
          onTogglePriority={onTogglePriority}
        />

        {hasPriorities && hasLabels && <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />}

        <LabelFilterBar
          tasks={tasks}
          selectedLabels={selectedLabels}
          onToggleLabel={onToggleLabel}
        />
      </div>

      {hasSelection && (
        <div className="from-background pointer-events-none absolute right-0 flex items-center bg-gradient-to-l from-50% to-transparent pl-4">
          <button
            onClick={onClearAll}
            className="text-muted-foreground hover:text-foreground pointer-events-auto flex-shrink-0 rounded-full p-1 transition-colors"
            aria-label="Clear all filters"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}
