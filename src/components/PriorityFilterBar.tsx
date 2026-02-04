'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { PRIORITY_OPTIONS, getPriorityBadgeClasses } from '@/lib/priority'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface PriorityFilterBarProps {
  tasks: Task[]
  selectedPriorities: number[]
  onTogglePriority: (priority: number) => void
}

/**
 * Renders priority filter badges inline (no wrapper).
 * Parent component handles layout and clear button.
 * Uses square badges (rounded-sm) to visually distinguish from pill-shaped label badges.
 */
export function PriorityFilterBar({
  tasks,
  selectedPriorities,
  onTogglePriority,
}: PriorityFilterBarProps) {
  const priorityCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const task of tasks) {
      const p = task.priority ?? 0
      counts.set(p, (counts.get(p) || 0) + 1)
    }
    // Sort by priority value (0-4) for consistent ordering
    return [...counts.entries()].sort((a, b) => a[0] - b[0])
  }, [tasks])

  if (priorityCounts.length === 0) return null

  return (
    <>
      {priorityCounts.map(([priority, count]) => {
        const isSelected = selectedPriorities.includes(priority)
        const option = PRIORITY_OPTIONS.find((p) => p.value === priority) || PRIORITY_OPTIONS[0]
        const badgeClasses = getPriorityBadgeClasses(priority, isSelected)

        return (
          <Badge
            key={priority}
            className={cn(
              'flex-shrink-0 cursor-pointer rounded-sm transition-colors select-none',
              badgeClasses,
            )}
            onClick={() => onTogglePriority(priority)}
          >
            <span className="leading-none">{option.label}</span>
            <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
          </Badge>
        )
      })}
    </>
  )
}
