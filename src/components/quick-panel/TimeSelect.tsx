'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NumberBox } from '@/components/quick-panel/NumberBox'
import { to12Hour, to24Hour } from '@/lib/time-utils'
import { cn } from '@/lib/utils'
import { hhmmWords } from '@/lib/every-time'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Every quarter hour of the day, "00:00" … "23:45". */
const QUARTER_HOURS = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4)
  const m = (i % 4) * 15
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
})

/**
 * EVERY-TIME MODE'S TIME DROPDOWN (2026-10-22, editor PR 4c; mock E's
 * "4:00 PM ▾"): one select of quarter hours, replacing the old recurrence
 * picker's three hour / minute / AM-PM selects. A rule's own off-grid time
 * (9:05) is kept as a choice of its own, so opening the row never changes it,
 * and "Exact time…" sets any minute — the date picker's own hour : minute
 * AM/PM boxes (`DateTimePicker`), then Set.
 *
 * `refused` greys a choice the server would refuse (a deadline-anchored
 * target later than the deadline on the deadline day, `targetTimeRefused`)
 * — disabled, with the reason in its label for a screen reader.
 */
export function TimeSelect({
  value,
  onChange,
  label,
  dirty = false,
  refused,
  refusedReason,
  disabled = false,
  testId,
  placeholder,
  autoOpen = false,
}: {
  /** "HH:MM"; '' shows the placeholder (nothing picked yet). */
  value: string
  placeholder?: string
  /** Open on mount ("+ Add" a deadline asks for its time at once). */
  autoOpen?: boolean
  onChange: (time: string) => void
  /** The accessible name ("Target time", "Deadline time"). */
  label: string
  dirty?: boolean
  refused?: (time: string) => boolean
  refusedReason?: string
  disabled?: boolean
  testId?: string
}) {
  const [exact, setExact] = useState(false)
  const options = useMemo(
    () =>
      !value || QUARTER_HOURS.includes(value) ? QUARTER_HOURS : [...QUARTER_HOURS, value].sort(),
    [value],
  )
  if (exact) {
    return (
      <ExactTime
        label={label}
        initial={value || '09:00'}
        refused={refused}
        onSet={(time) => {
          setExact(false)
          onChange(time)
        }}
        onCancel={() => setExact(false)}
      />
    )
  }
  return (
    <Select
      value={value}
      onValueChange={(v) => (v === EXACT ? setExact(true) : onChange(v))}
      disabled={disabled}
      defaultOpen={autoOpen}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        data-testid={testId}
        className={cn('min-w-[6.5rem]', dirty && 'font-medium text-blue-500')}
      >
        <SelectValue placeholder={placeholder}>{value ? hhmmWords(value) : undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((t) => {
          const no = refused?.(t) ?? false
          return (
            <SelectItem
              key={t}
              value={t}
              disabled={no}
              aria-label={no && refusedReason ? `${hhmmWords(t)}, ${refusedReason}` : undefined}
            >
              {hhmmWords(t)}
            </SelectItem>
          )
        })}
        <SelectItem value={EXACT}>Exact time…</SelectItem>
      </SelectContent>
    </Select>
  )
}

const EXACT = '__exact'

/** "Exact time…": hour : minute and AM/PM, as the date picker sets a time. */
function ExactTime({
  label,
  initial,
  refused,
  onSet,
  onCancel,
}: {
  label: string
  initial: string
  refused?: (time: string) => boolean
  onSet: (time: string) => void
  onCancel: () => void
}) {
  const [h24, m0] = initial.split(':').map(Number)
  const [hour12, setHour12] = useState(to12Hour(h24))
  const [minute, setMinute] = useState(m0)
  const [pm, setPm] = useState(h24 >= 12)
  const time = `${String(to24Hour(hour12, pm ? 'PM' : 'AM')).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const no = refused?.(time) ?? false
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <NumberBox
        value={hour12}
        min={1}
        max={12}
        onChange={setHour12}
        label="Hour"
        className="w-11"
      />
      <span className="text-muted-foreground text-sm">:</span>
      <NumberBox
        value={minute}
        min={0}
        max={59}
        pad={2}
        onChange={setMinute}
        label="Minute"
        className="w-11"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 px-2"
        onClick={() => setPm(!pm)}
      >
        {pm ? 'PM' : 'AM'}
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-8 px-2"
        disabled={no}
        onClick={() => onSet(time)}
      >
        Set
      </Button>
      <button
        type="button"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground px-1 text-xs"
      >
        Cancel
      </button>
    </div>
  )
}
