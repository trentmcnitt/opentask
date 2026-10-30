'use client'

import { useEffect, useCallback, useState } from 'react'
import { Clock, XCircle, CalendarDays } from 'lucide-react'
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
import { OptionMenu, type OptionMenuItem } from '@/components/OptionMenu'
import {
  useDayStart,
  useDayStartKnown,
  useSnoozePreferences,
} from '@/components/PreferencesProvider'
import { useTimezone } from '@/hooks/useTimezone'
import { computeSnoozeTime } from '@/lib/snooze'
import { to12Hour, to24Hour } from '@/lib/time-utils'
import { DateTime } from 'luxon'
import { nextSlotStart, type TimeSlot } from '@/lib/time-slot-assign'
import { SLOT_OPTION_PREFIX, targetMenu } from '@/lib/target-menu'
import { deadlineDayPick } from '@/lib/editor-target-labels'
import { REMOVE_TARGET as REMOVE_TARGET_LABEL } from '@/lib/task-model-words'

/**
 * The user's time slots, fetched when a menu opens and kept for the session.
 *
 * Not `useTimeSlots`: every task row mounts its own `SnoozeMenu`, and that
 * hook fetches on mount — one request per row, for a menu most rows never
 * open. Here nothing is fetched until a menu opens; the first open shows the
 * slots as soon as they arrive, and every later one starts from the cache
 * while it refreshes (slots are rarely edited, but they can be).
 */
let slotCache: TimeSlot[] = []
function useSlotsWhenOpen(open: boolean): TimeSlot[] {
  const [slots, setSlots] = useState<TimeSlot[]>(slotCache)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/time-slots')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const fresh = json?.data?.time_slots as TimeSlot[] | undefined
        if (!fresh) return
        slotCache = fresh
        if (!cancelled) setSlots(fresh)
      })
      // A failed fetch keeps whatever was cached: the fixed options still work.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])
  return slots
}

/** The menu's Remove target entry (not a snooze option). */
const REMOVE_TARGET = 'remove-target'
/** The picker's "Morning of the deadline" (ruling Q8, 2026-10-12). */
const DEADLINE_DAY_OPTION = 'deadline-day'

/** Each option's icon: custom → calendar, Remove target → ✕, else a clock. */
function OptionIcon({ option, className }: { option: string; className: string }) {
  if (option === 'custom') return <CalendarDays className={className} />
  if (option === REMOVE_TARGET) return <XCircle className={className} />
  return <Clock className={className} />
}

interface SnoozeMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with UTC ISO string when user picks a snooze option */
  onSnooze: (until: string) => void
  /** Trigger element — rendered as-is; parent controls click/long-press behavior */
  children?: React.ReactNode
  /**
   * Remove the target (2026-10-10; on a deadline task too since 2026-10-22,
   * when "Back to auto" went — the task goes on the deadlines page). Offered
   * only where the caller passes it and `targetReset` allows it.
   */
  onRemoveTarget?: () => void
  /** `targetReset(task)`: 'remove' → "Remove target", null → nothing. */
  targetReset?: 'remove' | null
  /**
   * The task's deadline: while it is ahead the menu offers "Morning of the deadline"
   * (ruling Q8 — the morning of its day, or the deadline itself if earlier),
   * and every option stops at it anyway (the server caps, §8.2).
   */
  deadlineAt?: string | null
  /** The sheet's title and the menu's accessible name: "Snooze" by default; Today's menu says "Target". */
  title?: string
  /**
   * Custom... opens the caller's own picker instead of the snooze dialog. The
   * segment rows' Today menu uses it for its "Set target" picker, which knows
   * the deadline (ruling Q8).
   */
  onCustom?: () => void
}

/**
 * Snooze option menu opened via long-press, in the shared hold-menu shell
 * (`OptionMenu`): desktop, a portal-rendered dropdown positioned via
 * getBoundingClientRect to escape stacking contexts; mobile, a bottom Sheet. Children (trigger button) are never wrapped in a Radix trigger
 * to avoid event interception — the parent component controls open state directly.
 */
export function SnoozeMenu({
  open,
  onOpenChange,
  onSnooze,
  children,
  onRemoveTarget,
  targetReset = 'remove',
  deadlineAt = null,
  title = 'Defer',
  onCustom,
}: SnoozeMenuProps) {
  const timezone = useTimezone()
  const { morningTime } = useSnoozePreferences()
  // "Tomorrow" is the next OpenTask day ("Day starts at" PR 2); until the
  // browser knows the day start, Tomorrow is shown but not choosable.
  const dayStart = useDayStart()
  const dayKnown = useDayStartKnown()
  const [customPickerOpen, setCustomPickerOpen] = useState(false)

  const slots = useSlotsWhenOpen(open)

  // T1 (Trent, 2026-10-30; `src/lib/target-menu.ts`): Next period, 1 hour, 2
  // hours, Tomorrow, This (or Next) weekend, Next week — then the deadline's
  // morning when the task has one, then every other period as ONE wrapping
  // row of buttons (the menu stays the same height at 8 or 10 periods), then
  // Custom… and Remove target. A period goes to its next start — today if
  // still ahead, else tomorrow — as before.
  const now = new Date()
  const menu = targetMenu({ now, timezone, dayStart, morningTime, slots })
  const pick = new Map(menu.rows.map((r) => [r.option, r.at]))
  const deadlineDay = deadlineDayPick(deadlineAt, { timezone, morningTime }, now, dayStart)
  const resetLabel = onRemoveTarget && targetReset ? REMOVE_TARGET_LABEL : null
  const options: Omit<OptionMenuItem, 'icon'>[] = [
    ...menu.rows.map((r) => ({
      label: r.label,
      option: r.option,
      caption: r.detail,
      disabled: r.needsDay && !dayKnown,
    })),
    ...(deadlineDay ? [{ label: deadlineDay.label, option: DEADLINE_DAY_OPTION }] : []),
    ...menu.periods.map((p) => ({
      label: p.label,
      option: p.option,
      caption: p.time,
      chipGroup: 'Periods',
    })),
    { label: 'Custom...', option: 'custom' },
    ...(resetLabel ? [{ label: resetLabel, option: REMOVE_TARGET }] : []),
  ]

  const handleSelect = (option: string) => {
    if (option === REMOVE_TARGET) {
      onOpenChange(false)
      onRemoveTarget?.()
      return
    }
    if (option === DEADLINE_DAY_OPTION && deadlineDay) {
      onSnooze(deadlineDay.at)
      onOpenChange(false)
      return
    }
    if (option === 'custom') {
      onOpenChange(false)
      if (onCustom) onCustom()
      else setCustomPickerOpen(true)
      return
    }
    // A period: its next start, and an offset: from now (the menu may have
    // sat open). A named day: as the menu worked it out.
    const at = option.startsWith(SLOT_OPTION_PREFIX)
      ? nextSlotStart(option.slice(SLOT_OPTION_PREFIX.length), timezone)
      : /^\d+$/.test(option)
        ? computeSnoozeTime(option, timezone, morningTime, dayStart)
        : pick.get(option)
    if (!at) return
    onSnooze(at)
    onOpenChange(false)
  }

  const handleCustomSnooze = (until: string) => {
    onSnooze(until)
    setCustomPickerOpen(false)
  }

  return (
    <OptionMenu
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      options={options.map((o) => ({
        ...o,
        icon: <OptionIcon option={o.option} className="size-4" />,
      }))}
      onSelect={handleSelect}
      after={
        <CustomSnoozePicker
          open={customPickerOpen}
          onOpenChange={setCustomPickerOpen}
          timezone={timezone}
          onSnooze={handleCustomSnooze}
        />
      }
    >
      {children}
    </OptionMenu>
  )
}

/**
 * Custom date/time picker dialog for snooze. Calendar + 12-hour time inputs.
 * Opens on tomorrow at the user's Morning time (it was a fixed 9:00 AM until
 * the anchor times, 2026-10-21), in the user's timezone.
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

  const { morningTime } = useSnoozePreferences()
  const dayStart = useDayStart()

  // Initialize to tomorrow at the Morning time when opening, via the
  // open-change handler (same pattern as DateTimePicker — avoids
  // setState-in-effect cascade)
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (newOpen) {
        const at = computeSnoozeTime('tomorrow', timezone, morningTime, dayStart)
        const tomorrow = DateTime.fromISO(at, { zone: 'utc' }).setZone(timezone)
        setSelectedDate(tomorrow.toJSDate())
        setHour12(to12Hour(tomorrow.hour))
        setMinute(tomorrow.minute)
        setPeriod(tomorrow.hour >= 12 ? 'PM' : 'AM')
      }
      onOpenChange(newOpen)
    },
    [timezone, morningTime, dayStart, onOpenChange],
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
          <DialogTitle>Defer until...</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a custom date and time to defer
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
          Defer
        </Button>
      </DialogContent>
    </Dialog>
  )
}
