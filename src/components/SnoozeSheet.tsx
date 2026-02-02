'use client'

import { useState } from 'react'
import { Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useTimezone } from '@/hooks/useTimezone'
import { getTimezoneDayBoundaries, parseLocalDatetimeInput } from '@/lib/format-date'
import type { Task } from '@/types'

interface SnoozeSheetProps {
  task: Task
  onSnooze: (until: string) => void
  onClose: () => void
  customOnly?: boolean
}

/**
 * Round a UTC Date to the nearest hour per SPEC:
 * minutes < 35 round down, >= 35 round up
 */
function roundToHour(date: Date): Date {
  const result = new Date(date)
  if (result.getUTCMinutes() >= 35) {
    result.setUTCHours(result.getUTCHours() + 1)
  }
  result.setUTCMinutes(0, 0, 0)
  return result
}

/**
 * Get a UTC ISO string for a specific hour in the user's timezone on the day
 * represented by the given UTC Date. Extracts date parts in the target timezone
 * (not UTC) to avoid calendar-day mismatches for timezones ahead of UTC.
 */
function dateAtHourInTimezone(dayUtc: Date, hour: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dayUtc)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const pad = (n: number) => n.toString().padStart(2, '0')
  return parseLocalDatetimeInput(
    `${get('year')}-${get('month')}-${get('day')}T${pad(hour)}:00`,
    timezone,
  )
}

export function SnoozeSheet({ task, onSnooze, onClose, customOnly = false }: SnoozeSheetProps) {
  const timezone = useTimezone()
  const [showPicker, setShowPicker] = useState(customOnly)
  const [customDateTime, setCustomDateTime] = useState('')

  const getSnoozeTime = (option: string): string => {
    const now = new Date()
    const { tomorrowStart } = getTimezoneDayBoundaries(timezone)

    switch (option) {
      case '+1h': {
        const t = roundToHour(new Date(now.getTime() + 60 * 60 * 1000))
        return t.toISOString()
      }
      case '+2h': {
        const t = roundToHour(new Date(now.getTime() + 2 * 60 * 60 * 1000))
        return t.toISOString()
      }
      case '+3h': {
        const t = roundToHour(new Date(now.getTime() + 3 * 60 * 60 * 1000))
        return t.toISOString()
      }
      case 'tomorrow9am': {
        return dateAtHourInTimezone(tomorrowStart, 9, timezone)
      }
      case '+1d': {
        const t = roundToHour(new Date(now.getTime() + 24 * 60 * 60 * 1000))
        return t.toISOString()
      }
      case '+3d': {
        const dayTarget = new Date(tomorrowStart.getTime() + 2 * 24 * 60 * 60 * 1000)
        return dateAtHourInTimezone(dayTarget, 9, timezone)
      }
      case '+1w': {
        const dayTarget = new Date(tomorrowStart.getTime() + 6 * 24 * 60 * 60 * 1000)
        return dateAtHourInTimezone(dayTarget, 9, timezone)
      }
      default:
        return new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    }
  }

  const options = [
    { id: '+1h', label: '+1 hour', icon: '1h' },
    { id: '+2h', label: '+2 hours', icon: '2h' },
    { id: '+3h', label: '+3 hours', icon: '3h' },
    { id: 'tomorrow9am', label: 'Tomorrow 9 AM', icon: '9AM' },
    { id: '+1d', label: '+1 day', icon: '+1d' },
    { id: '+3d', label: '+3 days', icon: '+3d' },
    { id: '+1w', label: '+1 week', icon: '+1w' },
  ]

  const handleCustomSubmit = () => {
    if (customDateTime) {
      onSnooze(parseLocalDatetimeInput(customDateTime, timezone))
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={true}>
        <SheetHeader>
          <SheetTitle>Snooze</SheetTitle>
        </SheetHeader>

        {/* Task preview */}
        <div className="bg-muted -mx-4 px-4 py-3">
          <p className="text-muted-foreground truncate text-sm">{task.title}</p>
        </div>

        {/* Options */}
        {!customOnly && (
          <div className="grid grid-cols-2 gap-2 px-4">
            {options.map((option) => (
              <button
                key={option.id}
                onClick={() => onSnooze(getSnoozeTime(option.id))}
                className="hover:bg-accent flex items-center gap-3 rounded-lg border p-3 text-left transition-colors"
              >
                <span className="bg-muted text-muted-foreground flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                  {option.icon}
                </span>
                <span className="text-sm font-medium">{option.label}</span>
              </button>
            ))}

            {/* Pick date & time button */}
            <button
              onClick={() => setShowPicker(!showPicker)}
              className="hover:bg-accent flex items-center gap-3 rounded-lg border p-3 text-left transition-colors"
            >
              <span className="bg-muted text-muted-foreground flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full">
                <Calendar className="size-4" />
              </span>
              <span className="text-sm font-medium">Pick date & time</span>
            </button>
          </div>
        )}

        {/* Custom datetime picker */}
        {showPicker && (
          <div className="flex gap-2 px-4 pb-4">
            <Input
              type="datetime-local"
              value={customDateTime}
              onChange={(e) => setCustomDateTime(e.target.value)}
              className="flex-1"
              autoFocus
            />
            <Button onClick={handleCustomSubmit} disabled={!customDateTime}>
              Set
            </Button>
          </div>
        )}

        {/* Safe area padding for mobile */}
        <div className="h-6 sm:hidden" />
      </SheetContent>
    </Sheet>
  )
}
