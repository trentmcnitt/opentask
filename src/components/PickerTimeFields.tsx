'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PeriodRowForFields } from '@/components/PeriodChipRow'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * A custom picker's time: 12-hour hour and minute fields with an AM/PM
 * toggle, and under them the user's periods and the Default task time
 * (`PeriodChipRow`, 2026-10-30). The picker owns the values.
 */
export function PickerTimeFields({
  hour12,
  minute,
  period,
  slots,
  defaultTime,
  onSet,
}: {
  hour12: number
  minute: number
  period: 'AM' | 'PM'
  slots: readonly TimeSlot[]
  defaultTime: string
  onSet: (hour12: number, minute: number, period: 'AM' | 'PM') => void
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <label className="text-muted-foreground text-xs">Time:</label>
        <Input
          type="number"
          min={1}
          max={12}
          value={hour12}
          onChange={(e) =>
            onSet(Math.min(12, Math.max(1, parseInt(e.target.value) || 1)), minute, period)
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
            onSet(hour12, Math.min(59, Math.max(0, parseInt(e.target.value) || 0)), period)
          }
          className="h-8 w-14 text-center text-sm"
          aria-label="Minute"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-12 text-xs font-medium"
          onClick={() => onSet(hour12, minute, period === 'AM' ? 'PM' : 'AM')}
          aria-label={`Toggle AM/PM, currently ${period}`}
        >
          {period}
        </Button>
      </div>
      <PeriodRowForFields
        slots={slots}
        hour12={hour12}
        minute={minute}
        period={period}
        defaultTime={defaultTime}
        onSet={onSet}
      />
    </>
  )
}
