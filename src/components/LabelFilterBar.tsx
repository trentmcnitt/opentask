'use client'

import { useMemo } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useLabelConfig } from '@/components/LabelConfigProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface LabelFilterBarProps {
  tasks: Task[]
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  onClearAll: () => void
}

export function LabelFilterBar({
  tasks,
  selectedLabels,
  onToggleLabel,
  onClearAll,
}: LabelFilterBarProps) {
  const { labelConfig } = useLabelConfig()

  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      for (const label of task.labels) {
        counts.set(label, (counts.get(label) || 0) + 1)
      }
    }
    // Sort by count descending, then alphabetically
    return [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
  }, [tasks])

  if (labelCounts.length === 0) return null

  const hasSelection = selectedLabels.length > 0

  return (
    <div className="relative mb-4 flex items-center">
      <div className="scrollbar-hide flex flex-1 items-center gap-2 overflow-x-auto pr-8">
        {labelCounts.map(([label, count]) => {
          const isSelected = selectedLabels.includes(label)
          const colorClasses = getLabelClasses(label, labelConfig)

          // Predefined label with color
          if (colorClasses) {
            return (
              <Badge
                key={label}
                className={cn(
                  'flex-shrink-0 cursor-pointer border transition-colors select-none',
                  isSelected
                    ? `${colorClasses} border-transparent`
                    : `bg-transparent ${colorClasses} border-current/20 hover:opacity-80`,
                )}
                onClick={() => onToggleLabel(label)}
              >
                <span>{label}</span>
                <span className="ml-1 text-[10px] opacity-60">{count}</span>
              </Badge>
            )
          }

          // Ad-hoc label — neutral
          return (
            <Badge
              key={label}
              variant={isSelected ? 'default' : 'outline'}
              className="flex-shrink-0 cursor-pointer select-none"
              onClick={() => onToggleLabel(label)}
            >
              <span>{label}</span>
              <span className="ml-1 text-[10px] opacity-60">{count}</span>
            </Badge>
          )
        })}
      </div>

      {/* Clear button - sticky right end */}
      {hasSelection && (
        <div className="from-background pointer-events-none absolute right-0 flex items-center bg-gradient-to-l from-50% to-transparent pl-4">
          <button
            onClick={onClearAll}
            className="text-muted-foreground hover:text-foreground pointer-events-auto flex-shrink-0 rounded-full p-1 transition-colors"
            aria-label="Clear label filters"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}
