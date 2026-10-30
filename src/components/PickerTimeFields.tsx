'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PeriodRowForFields } from '@/components/PeriodChipRow'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * Two digits at whatever size the text is (the iOS app runs at 119%): text
 * fields with the numeric keypad (`inputMode`), no number spinners — a spinner
 * in a fixed `w-14` with `px-3` cut "00" to "0" at 375 (Trent, 2026-10-30) —
 * and the width in `ch` of the field's own font. The values are clamped on
 * change, as before.
 */
const TIME_FIELD = 'h-8 w-[calc(2ch+1.25rem)] px-2 text-center text-sm'

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
          type="text"
          value={hour12}
          onChange={(e) =>
            onSet(Math.min(12, Math.max(1, parseInt(e.target.value) || 1)), minute, period)
          }
          inputMode="numeric"
          className={TIME_FIELD}
          aria-label="Hour"
        />
        <span className="text-muted-foreground text-sm">:</span>
        <Input
          type="text"
          value={minute.toString().padStart(2, '0')}
          onChange={(e) =>
            onSet(hour12, Math.min(59, Math.max(0, parseInt(e.target.value) || 0)), period)
          }
          inputMode="numeric"
          className={TIME_FIELD}
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
