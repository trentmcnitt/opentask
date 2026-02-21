'use client'

import { useMemo } from 'react'
import { Repeat, Timer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { EXCLUDED_CHIP_CLASSES } from '@/lib/priority'
import { useChipInteraction, type ChipState } from '@/hooks/useChipInteraction'
import type { Task } from '@/types'

interface AttributeFilterBarProps {
  tasks: Task[]
  attributeFilters: Set<string>
  excludedAttributes?: Set<string>
  onToggleAttribute: (key: string) => void
  onExclusiveAttribute?: (key: string) => void
  onExcludeAttribute?: (key: string) => void
}

/**
 * Renders attribute filter badges inline (no wrapper) for recurring and custom auto-snooze tasks.
 * Uses square badges (rounded-sm) matching priority chip style. Neutral color scheme.
 * Only renders chips whose corresponding tasks exist in the task list.
 */
export function AttributeFilterBar({
  tasks,
  attributeFilters,
  excludedAttributes = new Set(),
  onToggleAttribute,
  onExclusiveAttribute,
  onExcludeAttribute,
}: AttributeFilterBarProps) {
  const counts = useMemo(() => {
    let recurring = 0
    let autoSnooze = 0
    for (const task of tasks) {
      if (task.rrule != null) recurring++
      if (task.auto_snooze_minutes != null) autoSnooze++
    }
    return { recurring, autoSnooze }
  }, [tasks])

  if (counts.recurring === 0 && counts.autoSnooze === 0) return null

  return (
    <>
      {counts.recurring > 0 && (
        <AttributeChipBadge
          chipKey="recurring"
          icon={<Repeat className="size-3" />}
          label="Recurring"
          count={counts.recurring}
          chipState={
            excludedAttributes.has('recurring')
              ? 'excluded'
              : attributeFilters.has('recurring')
                ? 'included'
                : 'unselected'
          }
          onToggle={onToggleAttribute}
          onExclusive={onExclusiveAttribute}
          onExclude={onExcludeAttribute}
        />
      )}
      {counts.autoSnooze > 0 && (
        <AttributeChipBadge
          chipKey="custom_auto_snooze"
          icon={<Timer className="size-3" />}
          count={counts.autoSnooze}
          chipState={
            excludedAttributes.has('custom_auto_snooze')
              ? 'excluded'
              : attributeFilters.has('custom_auto_snooze')
                ? 'included'
                : 'unselected'
          }
          onToggle={onToggleAttribute}
          onExclusive={onExclusiveAttribute}
          onExclude={onExcludeAttribute}
          title="Custom auto-snooze"
        />
      )}
    </>
  )
}

function AttributeChipBadge({
  chipKey,
  icon,
  label,
  count,
  chipState,
  onToggle,
  onExclusive,
  onExclude,
  title,
}: {
  chipKey: string
  icon: React.ReactNode
  label?: string
  count: number
  chipState: ChipState
  onToggle: (key: string) => void
  onExclusive?: (key: string) => void
  onExclude?: (key: string) => void
  title?: string
}) {
  const handlers = useChipInteraction({ chipKey, chipState, onToggle, onExclusive, onExclude })

  return (
    <Badge
      className={cn(
        'flex-shrink-0 cursor-pointer gap-1 rounded-sm transition-colors select-none',
        chipState === 'excluded'
          ? EXCLUDED_CHIP_CLASSES
          : chipState === 'included'
            ? 'bg-foreground text-background hover:bg-foreground/90'
            : 'bg-muted text-muted-foreground hover:bg-muted/80 border-transparent',
      )}
      title={title}
      onClick={handlers.onClick}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
    >
      {icon}
      {label && <span className="leading-none">{label}</span>}
      <span className="text-[10px] leading-none opacity-60">{count}</span>
    </Badge>
  )
}
