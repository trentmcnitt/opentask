'use client'

import { useMemo, useRef, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { PRIORITY_OPTIONS, getPriorityBadgeClasses } from '@/lib/priority'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface PriorityFilterBarProps {
  tasks: Task[]
  selectedPriorities: number[]
  onTogglePriority: (priority: number) => void
  /** Cmd/Ctrl+click or mobile long-press: exclusive select (solo toggle) */
  onExclusivePriority?: (priority: number) => void
}

/**
 * Renders priority filter badges inline (no wrapper).
 * Parent component handles layout and clear button.
 * Uses square badges (rounded-sm) to visually distinguish from pill-shaped label badges.
 *
 * Supports Cmd/Ctrl+click for exclusive select (deselects all others) and
 * mobile long-press (400ms, 10px jitter) for the same behavior.
 */
export function PriorityFilterBar({
  tasks,
  selectedPriorities,
  onTogglePriority,
  onExclusivePriority,
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
          <ChipBadge
            key={priority}
            chipKey={priority}
            label={option.label}
            count={count}
            className={cn('rounded-sm', badgeClasses)}
            onToggle={onTogglePriority}
            onExclusive={onExclusivePriority}
          />
        )
      })}
    </>
  )
}

/**
 * Badge with Cmd+click exclusive select and mobile long-press support.
 * Generic over the chip key type (number for priority, string for labels).
 */
function ChipBadge<T extends string | number>({
  chipKey,
  label,
  count,
  className,
  onToggle,
  onExclusive,
}: {
  chipKey: T
  label: string
  count: number
  className?: string
  onToggle: (key: T) => void
  onExclusive?: (key: T) => void
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }, [])

  return (
    <Badge
      className={cn('flex-shrink-0 cursor-pointer transition-colors select-none', className)}
      onClick={(e: React.MouseEvent) => {
        if (firedRef.current) {
          firedRef.current = false
          return
        }
        if ((e.metaKey || e.ctrlKey) && onExclusive) {
          onExclusive(chipKey)
        } else {
          onToggle(chipKey)
        }
      }}
      onPointerDown={(e: React.PointerEvent) => {
        if (e.pointerType !== 'touch' || !onExclusive) return
        firedRef.current = false
        originRef.current = { x: e.clientX, y: e.clientY }
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          firedRef.current = true
          onExclusive(chipKey)
        }, 400)
      }}
      onPointerUp={cancel}
      onPointerMove={(e: React.PointerEvent) => {
        if (!timerRef.current || !originRef.current) return
        const dx = e.clientX - originRef.current.x
        const dy = e.clientY - originRef.current.y
        if (Math.sqrt(dx * dx + dy * dy) > 10) cancel()
      }}
      onPointerLeave={cancel}
    >
      <span className="leading-none">{label}</span>
      <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
    </Badge>
  )
}
