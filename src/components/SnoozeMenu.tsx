'use client'

import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useSnoozePreferences } from '@/components/LabelConfigProvider'
import { useTimezone } from '@/hooks/useTimezone'
import { computeSnoozeTime, formatMorningTime } from '@/lib/snooze'

interface SnoozeMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with UTC ISO string when user picks a snooze option */
  onSnooze: (until: string) => void
  /** Trigger element — rendered as-is; parent controls click/long-press behavior */
  children?: React.ReactNode
}

/**
 * Snooze option menu opened via long-press. Desktop: portal-rendered dropdown
 * positioned via getBoundingClientRect to escape stacking contexts.
 * Mobile: bottom Sheet. Children (trigger button) are never wrapped in a Radix trigger
 * to avoid event interception — the parent component controls open state directly.
 */
export function SnoozeMenu({ open, onOpenChange, onSnooze, children }: SnoozeMenuProps) {
  const isMobile = useIsMobile()
  const timezone = useTimezone()
  const { morningTime } = useSnoozePreferences()
  const triggerRef = useRef<HTMLDivElement>(null)

  const options = [
    { label: '1 hour', option: '60' },
    { label: '2 hours', option: '120' },
    { label: `Tomorrow at ${formatMorningTime(morningTime)}`, option: 'tomorrow' },
  ]

  const handleSelect = (option: string) => {
    onSnooze(computeSnoozeTime(option, timezone, morningTime))
    onOpenChange(false)
  }

  if (isMobile) {
    return (
      <>
        {children}
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={false}>
            <SheetHeader>
              <SheetTitle>Snooze</SheetTitle>
              <SheetDescription className="sr-only">Choose snooze duration</SheetDescription>
            </SheetHeader>
            <div className="space-y-1 px-4 pb-4">
              {options.map((opt) => (
                <button
                  key={opt.option}
                  type="button"
                  onClick={() => handleSelect(opt.option)}
                  className="hover:bg-accent active:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors"
                >
                  <Clock className="text-muted-foreground size-4" />
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="h-6 sm:hidden" />
          </SheetContent>
        </Sheet>
      </>
    )
  }

  // Desktop: portal-rendered dropdown positioned via getBoundingClientRect.
  // This escapes all stacking contexts (SwipeableRow's position:relative)
  // so the dropdown renders above subsequent task rows.
  return (
    <div ref={triggerRef} className="relative inline-flex">
      {children}
      {open && (
        <SnoozeDropdown
          triggerRef={triggerRef}
          options={options}
          onSelect={handleSelect}
          onClose={() => onOpenChange(false)}
        />
      )}
    </div>
  )
}

/**
 * Desktop dropdown rendered via portal into document.body, positioned using
 * the trigger's bounding rect. This fully escapes SwipeableRow stacking contexts.
 */
function SnoozeDropdown({
  triggerRef,
  options,
  onSelect,
  onClose,
}: {
  triggerRef: React.RefObject<HTMLDivElement | null>
  options: { label: string; option: string }[]
  onSelect: (option: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  // Compute position from trigger's bounding rect before paint to avoid flash
  useLayoutEffect(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPosition({
      top: rect.bottom + 4, // 4px gap below trigger
      left: rect.right, // right-aligned with trigger
    })
  }, [triggerRef])

  // Close on click outside
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    },
    [onClose],
  )

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    // Use setTimeout to avoid the click that opened the menu from immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClickOutside, handleKeyDown])

  if (!position) return null

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Snooze options"
      className="bg-popover text-popover-foreground fixed z-50 min-w-[200px] rounded-md border p-1 shadow-md"
      style={{ top: position.top, left: position.left, transform: 'translateX(-100%)' }}
    >
      {options.map((opt) => (
        <button
          key={opt.option}
          role="menuitem"
          type="button"
          onClick={() => onSelect(opt.option)}
          className="hover:bg-accent active:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm whitespace-nowrap transition-colors"
        >
          <Clock className="size-4 flex-shrink-0" />
          {opt.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
