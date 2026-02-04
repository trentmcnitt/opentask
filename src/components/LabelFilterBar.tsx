'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { useLabelConfig } from '@/components/LabelConfigProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface LabelFilterBarProps {
  tasks: Task[]
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
}

/**
 * Renders label filter badges inline (no wrapper).
 * Parent component handles layout and clear button.
 * Uses pill-shaped badges (default rounded-full) to visually distinguish from square priority badges.
 */
export function LabelFilterBar({ tasks, selectedLabels, onToggleLabel }: LabelFilterBarProps) {
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

  return (
    <>
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
              <span className="leading-none">{label}</span>
              <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
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
            <span className="leading-none">{label}</span>
            <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
          </Badge>
        )
      })}
    </>
  )
}
