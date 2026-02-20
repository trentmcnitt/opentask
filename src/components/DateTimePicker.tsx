'use client'

import { useState, useCallback } from 'react'
import { CalendarDays } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateTime } from 'luxon'

interface DateTimePickerProps {
  /** Current value as UTC ISO string, or null if no date */
  value: string | null
  /** User's IANA timezone for display and conversion */
  timezone: string
  /** Called with UTC ISO string or null (clear) */
  onChange: (isoUtc: string | null) => void
  /** Trigger element */
  children: React.ReactNode
}

/** Convert 24-hour to 12-hour display value (1-12) */
function to12Hour(hour24: number): number {
  return hour24 % 12 || 12
}

/** Convert 12-hour + period back to 24-hour */
function to24Hour(hour12: number, period: 'AM' | 'PM'): number {
  if (period === 'AM') return hour12 % 12
  return (hour12 % 12) + 12
}

/**
 * Calendar + time picker popover.
 *
 * Wraps a trigger element (children prop) with a popover containing a shadcn
 * Calendar for date selection and 12-hour time inputs with AM/PM toggle.
 * Converts the selected local date+time to UTC using Luxon before calling onChange.
 */
export function DateTimePicker({ value, timezone, onChange, children }: DateTimePickerProps) {
  const [open, setOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [hour12, setHour12] = useState(9)
  const [minute, setMinute] = useState(0)
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM')

  // Initialize internal state from external value when popover opens
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (newOpen) {
        if (value) {
          const dt = DateTime.fromISO(value, { zone: 'utc' }).setZone(timezone)
          setSelectedDate(dt.toJSDate())
          setHour12(to12Hour(dt.hour))
          setMinute(dt.minute)
          setPeriod(dt.hour >= 12 ? 'PM' : 'AM')
        } else {
          const tomorrow = DateTime.now()
            .setZone(timezone)
            .plus({ days: 1 })
            .set({ hour: 9, minute: 0 })
          setSelectedDate(tomorrow.toJSDate())
          setHour12(9)
          setMinute(0)
          setPeriod('AM')
        }
      }
      setOpen(newOpen)
    },
    [value, timezone],
  )

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
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" sideOffset={4}>
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
          {/* Action buttons */}
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={handleSetDate} disabled={!selectedDate} className="flex-1">
              <CalendarDays className="mr-1 size-3.5" />
              Set Date
            </Button>
            <Button size="sm" variant="outline" onClick={handleClear} className="flex-1">
              Clear
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
