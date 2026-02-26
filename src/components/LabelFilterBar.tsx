'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { EXCLUDED_CHIP_CLASSES } from '@/lib/priority'
import { cn } from '@/lib/utils'
import { useChipInteraction, type ChipState } from '@/hooks/useChipInteraction'
import type { Task } from '@/types'

interface LabelFilterBarProps {
  tasks: Task[]
  selectedLabels: string[]
  excludedLabels?: string[]
  onToggleLabel: (label: string) => void
  onExclusiveLabel?: (label: string) => void
  onExcludeLabel?: (label: string) => void
}

/**
 * Renders label filter badges inline (no wrapper).
 * Parent component handles layout and clear button.
 * Uses pill-shaped badges (default rounded-full) to visually distinguish from square priority badges.
 *
 * Supports single-click toggle, double-click exclude, Cmd/Ctrl+click exclusive select,
 * and mobile long-press (400ms, 10px jitter) for exclusive select.
 */
export function LabelFilterBar({
  tasks,
  selectedLabels,
  excludedLabels = [],
  onToggleLabel,
  onExclusiveLabel,
  onExcludeLabel,
}: LabelFilterBarProps) {
  const { labelConfig } = useLabelConfig()

  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      for (const label of task.labels) {
        counts.set(label, (counts.get(label) || 0) + 1)
      }
    }
    // Ensure active filters appear even at count 0
    for (const l of selectedLabels) {
      if (!counts.has(l)) counts.set(l, 0)
    }
    for (const l of excludedLabels) {
      if (!counts.has(l)) counts.set(l, 0)
    }
    return [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
  }, [tasks, selectedLabels, excludedLabels])

  if (labelCounts.length === 0) return null

  return (
    <>
      {labelCounts.map(([label, count]) => {
        const chipState: ChipState = excludedLabels.includes(label)
          ? 'excluded'
          : selectedLabels.includes(label)
            ? 'included'
            : 'unselected'
        const colorClasses = getLabelClasses(label, labelConfig)

        const className =
          chipState === 'excluded'
            ? cn('border', EXCLUDED_CHIP_CLASSES)
            : colorClasses
              ? cn(
                  'border',
                  chipState === 'included'
                    ? `${colorClasses} border-transparent`
                    : `bg-muted/40 ${colorClasses} border-current/20 hover:opacity-80`,
                )
              : undefined

        return (
          <LabelChipBadge
            key={label}
            label={label}
            count={count}
            chipState={chipState}
            className={className}
            variant={
              !colorClasses && chipState !== 'excluded'
                ? chipState === 'included'
                  ? 'default'
                  : 'outline'
                : undefined
            }
            onToggle={onToggleLabel}
            onExclusive={onExclusiveLabel}
            onExclude={onExcludeLabel}
          />
        )
      })}
    </>
  )
}

function LabelChipBadge({
  label,
  count,
  chipState,
  className,
  variant,
  onToggle,
  onExclusive,
  onExclude,
}: {
  label: string
  count: number
  chipState: ChipState
  className?: string
  variant?: 'default' | 'outline'
  onToggle: (label: string) => void
  onExclusive?: (label: string) => void
  onExclude?: (label: string) => void
}) {
  const handlers = useChipInteraction({
    chipKey: label,
    chipState,
    onToggle,
    onExclusive,
    onExclude,
  })

  return (
    <Badge
      variant={variant}
      className={cn('flex-shrink-0 cursor-pointer select-none', className)}
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
