'use client'

import { useMemo, useRef, useCallback } from 'react'
import { Repeat, Timer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface AttributeFilterBarProps {
  tasks: Task[]
  attributeFilters: Set<string>
  onToggleAttribute: (key: string) => void
  onExclusiveAttribute?: (key: string) => void
}

/**
 * Renders attribute filter badges inline (no wrapper) for recurring and custom auto-snooze tasks.
 * Uses square badges (rounded-sm) matching priority chip style. Neutral color scheme.
 * Only renders chips whose corresponding tasks exist in the task list.
 */
export function AttributeFilterBar({
  tasks,
  attributeFilters,
  onToggleAttribute,
  onExclusiveAttribute,
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
          isSelected={attributeFilters.has('recurring')}
          onToggle={onToggleAttribute}
          onExclusive={onExclusiveAttribute}
        />
      )}
      {counts.autoSnooze > 0 && (
        <AttributeChipBadge
          chipKey="custom_auto_snooze"
          icon={<Timer className="size-3" />}
          count={counts.autoSnooze}
          isSelected={attributeFilters.has('custom_auto_snooze')}
          onToggle={onToggleAttribute}
          onExclusive={onExclusiveAttribute}
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
  isSelected,
  onToggle,
  onExclusive,
  title,
}: {
  chipKey: string
  icon: React.ReactNode
  label?: string
  count: number
  isSelected: boolean
  onToggle: (key: string) => void
  onExclusive?: (key: string) => void
  title?: string
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
      className={cn(
        'flex-shrink-0 cursor-pointer gap-1 rounded-sm transition-colors select-none',
        isSelected
          ? 'bg-foreground text-background hover:bg-foreground/90'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 border-transparent',
      )}
      title={title}
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
      {icon}
      {label && <span className="leading-none">{label}</span>}
      <span className="text-[10px] leading-none opacity-60">{count}</span>
    </Badge>
  )
}
