'use client'

import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock, CalendarDays } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { useTimezone } from '@/hooks/useTimezone'
import { computeSnoozeTime, formatMorningTime } from '@/lib/snooze'
import { to24Hour } from '@/lib/time-utils'
import { DateTime } from 'luxon'

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
  const [customPickerOpen, setCustomPickerOpen] = useState(false)

  const options = [
    { label: '1 hour', option: '60' },
    { label: '2 hours', option: '120' },
    { label: `Tomorrow at ${formatMorningTime(morningTime)}`, option: 'tomorrow' },
    { label: 'Custom...', option: 'custom' },
  ]

  const handleSelect = (option: string) => {
    if (option === 'custom') {
      onOpenChange(false)
      setCustomPickerOpen(true)
      return
    }
    onSnooze(computeSnoozeTime(option, timezone, morningTime))
    onOpenChange(false)
  }

  const handleCustomSnooze = (until: string) => {
    onSnooze(until)
    setCustomPickerOpen(false)
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
                  {opt.option === 'custom' ? (
                    <CalendarDays className="text-muted-foreground size-4" />
                  ) : (
                    <Clock className="text-muted-foreground size-4" />
                  )}
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="h-6 sm:hidden" />
          </SheetContent>
        </Sheet>
        <CustomSnoozePicker
          open={customPickerOpen}
          onOpenChange={setCustomPickerOpen}
          timezone={timezone}
          onSnooze={handleCustomSnooze}
        />
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
      <CustomSnoozePicker
        open={customPickerOpen}
        onOpenChange={setCustomPickerOpen}
        timezone={timezone}
        onSnooze={handleCustomSnooze}
      />
    </div>
  )
}

/**
 * Desktop dropdown rendered via portal into document.body, positioned using
 * the trigger's bounding rect. This fully escapes SwipeableRow stacking contexts.
 *
 * Uses pointerdown (not click) for outside detection so that the pointer-up
 * after a long-press doesn't immediately close the dropdown. The originating
 * pointerdown has already fired before the dropdown mounts, so it can't
 * accidentally trigger the outside handler.
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

  // Close on pointerdown outside. Using pointerdown instead of click prevents
  // the pointer-up from a long-press (which synthesizes a click) from closing
  // the dropdown immediately after it opens.
  const handlePointerDownOutside = useCallback(
    (e: PointerEvent) => {
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
    document.addEventListener('pointerdown', handlePointerDownOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handlePointerDownOutside, handleKeyDown])

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
          {opt.option === 'custom' ? (
            <CalendarDays className="size-4 flex-shrink-0" />
          ) : (
            <Clock className="size-4 flex-shrink-0" />
          )}
          {opt.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

/**
 * Custom date/time picker dialog for snooze. Calendar + 12-hour time inputs.
 * Defaults to tomorrow at 9:00 AM in the user's timezone.
 */
function CustomSnoozePicker({
  open,
  onOpenChange,
  timezone,
  onSnooze,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
  onSnooze: (until: string) => void
}) {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [hour12, setHour12] = useState(9)
  const [minute, setMinute] = useState(0)
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM')

  // Initialize to tomorrow 9 AM when opening, via the open-change handler
  // (same pattern as DateTimePicker — avoids setState-in-effect cascade)
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (newOpen) {
        const tomorrow = DateTime.now()
          .setZone(timezone)
          .plus({ days: 1 })
          .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
        setSelectedDate(tomorrow.toJSDate())
        setHour12(9)
        setMinute(0)
        setPeriod('AM')
      }
      onOpenChange(newOpen)
    },
    [timezone, onOpenChange],
  )

  const handleSnooze = () => {
    if (!selectedDate) return
    const hour24 = to24Hour(hour12, period)
    const localDt = DateTime.fromJSDate(selectedDate)
      .setZone(timezone, { keepLocalTime: true })
      .set({ hour: hour24, minute, second: 0, millisecond: 0 })
    const utcIso = localDt.toUTC().toISO()
    if (utcIso) onSnooze(utcIso)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze until...</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a custom date and time to snooze
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => {
              if (date) setSelectedDate(date)
            }}
            defaultMonth={selectedDate}
          />
          <div className="w-full border-t px-3 pt-3 pb-1">
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground text-xs">Time:</label>
              <Input
                type="number"
                min={1}
                max={12}
                value={hour12}
                onChange={(e) =>
                  setHour12(Math.min(12, Math.max(1, parseInt(e.target.value) || 1)))
                }
                className="h-8 w-14 text-center text-sm"
                aria-label="Hour"
              />
              <span className="text-muted-foreground text-sm">:</span>
              <Input
                type="number"
                min={0}
                max={59}
                value={minute.toString().padStart(2, '0')}
                onChange={(e) =>
                  setMinute(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))
                }
                className="h-8 w-14 text-center text-sm"
                aria-label="Minute"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-12 text-xs font-medium"
                onClick={() => setPeriod((p) => (p === 'AM' ? 'PM' : 'AM'))}
                aria-label={`Toggle AM/PM, currently ${period}`}
              >
                {period}
              </Button>
            </div>
          </div>
        </div>
        <Button onClick={handleSnooze} disabled={!selectedDate} className="w-full">
          <Clock className="mr-1.5 size-4" />
          Snooze
        </Button>
      </DialogContent>
    </Dialog>
  )
}
