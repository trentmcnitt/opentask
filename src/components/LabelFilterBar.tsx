'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { AI_LABELS, AiLabelGlyph } from '@/components/LabelName'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { labelChipCounts } from '@/lib/label-filter'
import { EXCLUDED_CHIP_CLASSES } from '@/lib/priority'
import { cn } from '@/lib/utils'
import { useChipInteraction, type ChipState } from '@/hooks/useChipInteraction'
import type { Task } from '@/types'

interface LabelFilterBarProps {
  /** The items to count — any shape with labels (tasks on the dashboard, quotas on /quotas). */
  tasks: Pick<Task, 'labels'>[]
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

  // Counting is shared with every label filter (src/lib/label-filter.ts).
  const labelCounts = useMemo(
    () => labelChipCounts(tasks, { selectedLabels, excludedLabels }),
    [tasks, selectedLabels, excludedLabels],
  )

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
      data-label-chip={label}
      data-chip-state={chipState}
      onClick={handlers.onClick}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
    >
      {AI_LABELS.has(label) && <AiLabelGlyph />}
      <span className="leading-none">{label}</span>
      <span className="ml-1 text-[10px] leading-none opacity-60">{count}</span>
    </Badge>
  )
}
