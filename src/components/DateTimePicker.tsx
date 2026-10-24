'use client'

import { useState, useCallback, useRef } from 'react'
import { CalendarDays } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateTime } from 'luxon'
import { to12Hour, to24Hour } from '@/lib/time-utils'
import { snapToNearestFiveMinutes } from '@/lib/quick-select-dates'
import { computeSnoozeTime } from '@/lib/snooze'
import { useDayStart, useSnoozePreferences } from '@/components/PreferencesProvider'

interface DateTimePickerProps {
  /** Current value as UTC ISO string, or null if no date */
  value: string | null
  /** User's IANA timezone for display and conversion */
  timezone: string
  /** Called with UTC ISO string or null (clear) */
  onChange: (isoUtc: string | null) => void
  /** Trigger element */
  children: React.ReactNode
  /**
   * Show the Clear button (default true). The multi-task quick panel turns it
   * off when the selection's due dates can't be cleared in one save (e.g. a
   * quota is selected — clearing takes the recurrence with it, and a quota
   * must keep its period).
   */
  allowClear?: boolean
  /**
   * What the picker opens on when `value` is null: tomorrow at the user's
   * Morning time (the default; anchor times, 2026-10-21 — it was a fixed
   * 9:00 AM), or the current time snapped to five minutes. Computed when the
   * popover opens, not during render, so "now" is the moment of the tap.
   */
  emptyDefault?: 'tomorrow' | 'now'
  /**
   * When `value` is null, open on this moment (UTC ISO) instead of
   * `emptyDefault`. A recurring task's deadline picker opens on the
   * occurrence's target, so "target late morning, deadline before bed that
   * night" is a change of time, not a hunt through the calendar for Sunday
   * (Trent, 2026-10-12). Opening on it sets nothing until the user picks.
   */
  emptyAnchor?: string | null
  /**
   * Controlled mode (2026-10-12): the parent opens the picker itself, and
   * `children` is only where it anchors — NOT a trigger, so a plain tap on it
   * does whatever the parent wired (a task segment's Today button targets on
   * a tap and opens this on a hold or right-click; a Radix trigger would open
   * it on the tap too). Leave both unset for the usual tap-to-open.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The confirm button's text (default "Set Date"). */
  submitLabel?: string
  /** The Clear button's text (default "Clear"): "Remove target" on the Quick panel's target. */
  clearLabel?: string
  /**
   * One ready choice above the calendar — the target picker's "Morning of the deadline"
   * (ruling Q8, 2026-10-12: the morning of the deadline's day, or the deadline
   * itself if earlier). A tap picks it and closes, like Set Date.
   */
  quickPick?: { label: string; at: string } | null
  /**
   * A block of choices above the calendar, given the picker's close — the
   * editor's "Before the deadline" block (relative targets, 2026-10-24,
   * `BeforeDeadlineBlock`): its picks are staged by the block itself, not
   * through `onChange`, then it closes the picker. Mounted on each open.
   */
  beforeCalendar?: ((close: () => void) => React.ReactNode) | null
}

/**
 * Where an empty picker opens (`emptyDefault`): tomorrow at the user's Morning
 * time, or now snapped to five minutes. UTC ISO.
 */
function emptyDefaultAt(
  kind: 'tomorrow' | 'now',
  timezone: string,
  morningTime: string,
  dayStart: string,
): string {
  return kind === 'now'
    ? snapToNearestFiveMinutes()
    : computeSnoozeTime('tomorrow', timezone, morningTime, dayStart)
}

/** The picker's one ready choice above the calendar (`quickPick`). */
function QuickPickRow({ label, onPick }: { label: string; onPick: () => void }) {
  return (
    // `w-0 min-w-full`: the row takes the popover's width (the calendar's)
    // and adds none of its own, so a long label wraps instead of widening
    // the popover past a phone's edge.
    <div className="w-0 min-w-full border-b px-3 py-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        // A long label ("Morning of the deadline · Tue 8:30 AM (Deadline
        // time)") wraps inside the button on a phone instead of widening it.
        className="h-auto min-h-8 w-full justify-start py-1.5 text-left whitespace-normal"
        data-quick-pick
        onClick={onPick}
      >
        <CalendarDays className="mr-1 size-3.5 shrink-0" />
        <span>{label}</span>
      </Button>
    </div>
  )
}

/** Set Date and Clear (the Clear absent when `clearLabel` is null). */
function PickerActions({
  submitLabel,
  onSubmit,
  canSubmit,
  clearLabel,
  onClear,
}: {
  submitLabel: string
  onSubmit: () => void
  canSubmit: boolean
  clearLabel: string | null
  onClear: () => void
}) {
  return (
    <div className="mt-2 flex gap-2">
      <Button size="sm" onClick={onSubmit} disabled={!canSubmit} className="flex-1">
        <CalendarDays className="mr-1 size-3.5" />
        {submitLabel}
      </Button>
      {clearLabel !== null && (
        <Button size="sm" variant="outline" onClick={onClear} className="flex-1">
          {clearLabel}
        </Button>
      )}
    </div>
  )
}

/**
 * Calendar + time picker popover.
 *
 * Wraps a trigger element (children prop) with a popover containing a shadcn
 * Calendar for date selection and 12-hour time inputs with AM/PM toggle.
 * Converts the selected local date+time to UTC using Luxon before calling onChange.
 */
export function DateTimePicker({
  value,
  timezone,
  onChange,
  children,
  allowClear = true,
  emptyDefault = 'tomorrow',
  emptyAnchor = null,
  open: controlledOpen,
  onOpenChange,
  submitLabel = 'Set Date',
  clearLabel = 'Clear',
  quickPick = null,
  beforeCalendar = null,
}: DateTimePickerProps) {
  const { morningTime } = useSnoozePreferences()
  const dayStart = useDayStart()
  const controlled = controlledOpen !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlled ? controlledOpen : uncontrolledOpen
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [hour12, setHour12] = useState(9)
  const [minute, setMinute] = useState(0)
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM')

  // Initialize internal state from external value when popover opens
  const initialize = useCallback(() => {
    const initial =
      value ?? emptyAnchor ?? emptyDefaultAt(emptyDefault, timezone, morningTime, dayStart)
    const dt = DateTime.fromISO(initial, { zone: 'utc' }).setZone(timezone)
    setSelectedDate(dt.toJSDate())
    setHour12(to12Hour(dt.hour))
    setMinute(dt.minute)
    setPeriod(dt.hour >= 12 ? 'PM' : 'AM')
  }, [value, timezone, emptyDefault, emptyAnchor, morningTime, dayStart])

  const setOpen = useCallback(
    (newOpen: boolean) => {
      if (controlled) onOpenChange?.(newOpen)
      else setUncontrolledOpen(newOpen)
    },
    [controlled, onOpenChange],
  )

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (newOpen) initialize()
      setOpen(newOpen)
    },
    [initialize, setOpen],
  )

  // Controlled: the parent opened it, so no `onOpenChange(true)` came through
  // here — initialise on the closed → open edge, during render (React's
  // "adjust state when a prop changes" pattern, no effect).
  const anchorRef = useRef<HTMLDivElement>(null)
  const [seenOpen, setSeenOpen] = useState(open)
  if (controlled && open !== seenOpen) {
    setSeenOpen(open)
    if (open) initialize()
  }

  // Controlled: the anchor is the very button that opened it, so the tail of
  // that press — the focus or click a touch long-press leaves behind on
  // release — is not "outside" and must not close it (it did: the picker shut
  // a moment after the finger lifted). A Radix trigger gets this exemption
  // built in; an anchor doesn't.
  const keepOpenOnAnchor = (e: Event) => {
    if (controlled && anchorRef.current?.contains(e.target as Node)) e.preventDefault()
  }

  const handleSetDate = () => {
    if (!selectedDate) return
    const hour24 = to24Hour(hour12, period)
    // Convert local date+time to UTC using Luxon.
    // fromJSDate + setZone with keepLocalTime interprets the calendar date in the user's timezone.
    const localDt = DateTime.fromJSDate(selectedDate)
      .setZone(timezone, { keepLocalTime: true })
      .set({ hour: hour24, minute, second: 0, millisecond: 0 })
    const utcIso = localDt.toUTC().toISO()
    if (utcIso) {
      onChange(utcIso)
    }
    setOpen(false)
  }

  const handleClear = () => {
    onChange(null)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {controlled ? (
        <PopoverAnchor asChild ref={anchorRef}>
          {children}
        </PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      )}
      {/* Never taller than the room on its side of the trigger: opened from a
          row in the middle of a phone's screen (the segment rows' Target menu,
          Custom...) it ran past the bottom with Set target out of reach. It
          scrolls inside instead. */}
      <PopoverContent
        className="max-h-[var(--radix-popover-content-available-height)] w-auto overflow-y-auto p-0"
        align="start"
        sideOffset={4}
        onInteractOutside={keepOpenOnAnchor}
      >
        {quickPick && (
          <QuickPickRow
            label={quickPick.label}
            onPick={() => {
              onChange(quickPick.at)
              setOpen(false)
            }}
          />
        )}
        {beforeCalendar?.(() => setOpen(false))}
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={(date) => {
            if (date) setSelectedDate(date)
          }}
          defaultMonth={selectedDate}
        />
        <div className="border-t px-3 py-3">
          {/* Time inputs — 12-hour format with AM/PM toggle */}
          <div className="flex items-center gap-2">
            <label className="text-muted-foreground text-xs">Time:</label>
            <Input
              type="number"
              min={1}
              max={12}
              value={hour12}
              onChange={(e) => setHour12(Math.min(12, Math.max(1, parseInt(e.target.value) || 1)))}
              className="h-8 w-14 text-center text-sm"
              aria-label="Hour"
            />
            <span className="text-muted-foreground text-sm">:</span>
            <Input
              type="number"
              min={0}
              max={59}
              value={minute.toString().padStart(2, '0')}
              onChange={(e) => setMinute(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
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
          <PickerActions
            submitLabel={submitLabel}
            onSubmit={handleSetDate}
            canSubmit={!!selectedDate}
            clearLabel={allowClear ? clearLabel : null}
            onClear={handleClear}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
