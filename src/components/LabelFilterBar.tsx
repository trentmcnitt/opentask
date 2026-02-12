'use client'

import { useMemo, useRef, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface LabelFilterBarProps {
  tasks: Task[]
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  /** Cmd/Ctrl+click or mobile long-press: exclusive select (solo toggle) */
  onExclusiveLabel?: (label: string) => void
}

/**
 * Renders label filter badges inline (no wrapper).
 * Parent component handles layout and clear button.
 * Uses pill-shaped badges (default rounded-full) to visually distinguish from square priority badges.
 *
 * Supports Cmd/Ctrl+click for exclusive select and mobile long-press (400ms, 10px jitter).
 */
export function LabelFilterBar({
  tasks,
  selectedLabels,
  onToggleLabel,
  onExclusiveLabel,
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

  return (
    <>
      {labelCounts.map(([label, count]) => {
        const isSelected = selectedLabels.includes(label)
        const colorClasses = getLabelClasses(label, labelConfig)

        if (colorClasses) {
          return (
            <LabelChipBadge
              key={label}
              label={label}
              count={count}
              className={cn(
                'border',
                isSelected
                  ? `${colorClasses} border-transparent`
                  : `bg-transparent ${colorClasses} border-current/20 hover:opacity-80`,
              )}
              onToggle={onToggleLabel}
              onExclusive={onExclusiveLabel}
            />
          )
        }

        return (
          <LabelChipBadge
            key={label}
            label={label}
            count={count}
            variant={isSelected ? 'default' : 'outline'}
            onToggle={onToggleLabel}
            onExclusive={onExclusiveLabel}
          />
        )
      })}
    </>
  )
}

function LabelChipBadge({
  label,
  count,
  className,
  variant,
  onToggle,
  onExclusive,
}: {
  label: string
  count: number
  className?: string
  variant?: 'default' | 'outline'
  onToggle: (label: string) => void
  onExclusive?: (label: string) => void
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
      variant={variant}
      className={cn('flex-shrink-0 cursor-pointer select-none', className)}
      onClick={(e: React.MouseEvent) => {
        if (firedRef.current) {
          firedRef.current = false
          return
        }
        if ((e.metaKey || e.ctrlKey) && onExclusive) {
          onExclusive(label)
        } else {
          onToggle(label)
        }
      }}
      onPointerDown={(e: React.PointerEvent) => {
        if (e.pointerType !== 'touch' || !onExclusive) return
        firedRef.current = false
        originRef.current = { x: e.clientX, y: e.clientY }
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          firedRef.current = true
          onExclusive(label)
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
