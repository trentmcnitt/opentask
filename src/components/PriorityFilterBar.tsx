'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { PRIORITY_OPTIONS, getPriorityBadgeClasses } from '@/lib/priority'
import { cn } from '@/lib/utils'
import { useChipInteraction, type ChipState } from '@/hooks/useChipInteraction'
import type { Task } from '@/types'

interface PriorityFilterBarProps {
  tasks: Task[]
  selectedPriorities: number[]
  excludedPriorities?: number[]
  onTogglePriority: (priority: number) => void
  onExclusivePriority?: (priority: number) => void
  onExcludePriority?: (priority: number) => void
}

/**
 * Renders priority filter badges inline (no wrapper).
 * Parent component handles layout and clear button.
 * Uses square badges (rounded-sm) to visually distinguish from pill-shaped label badges.
 *
 * Supports single-click toggle, double-click exclude, Cmd/Ctrl+click exclusive select,
 * and mobile long-press (400ms, 10px jitter) for exclusive select.
 */
export function PriorityFilterBar({
  tasks,
  selectedPriorities,
  excludedPriorities = [],
  onTogglePriority,
  onExclusivePriority,
  onExcludePriority,
}: PriorityFilterBarProps) {
  const priorityCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const task of tasks) {
      const p = task.priority ?? 0
      counts.set(p, (counts.get(p) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0])
  }, [tasks])

  if (priorityCounts.length === 0) return null

  return (
    <>
      {priorityCounts.map(([priority, count]) => {
        const chipState: ChipState = excludedPriorities.includes(priority)
          ? 'excluded'
          : selectedPriorities.includes(priority)
            ? 'included'
            : 'unselected'
        const option = PRIORITY_OPTIONS.find((p) => p.value === priority) || PRIORITY_OPTIONS[0]
        const badgeClasses = getPriorityBadgeClasses(priority, chipState)

        return (
          <ChipBadge
            key={priority}
            chipKey={priority}
            chipState={chipState}
            label={option.label}
            count={count}
            className={cn('rounded-sm', badgeClasses)}
            onToggle={onTogglePriority}
            onExclusive={onExclusivePriority}
            onExclude={onExcludePriority}
          />
        )
      })}
    </>
  )
}

function ChipBadge<T extends string | number>({
  chipKey,
  chipState,
  label,
  count,
  className,
  onToggle,
  onExclusive,
  onExclude,
}: {
  chipKey: T
  chipState: ChipState
  label: string
  count: number
  className?: string
  onToggle: (key: T) => void
  onExclusive?: (key: T) => void
  onExclude?: (key: T) => void
}) {
  const handlers = useChipInteraction({ chipKey, chipState, onToggle, onExclusive, onExclude })

  return (
    <Badge
      className={cn('flex-shrink-0 cursor-pointer transition-colors select-none', className)}
      onClick={handlers.onClick}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
    >
      <span className="leading-none">{label}</span>
      <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
    </Badge>
  )
}
