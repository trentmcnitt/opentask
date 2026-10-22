'use client'

import { useMemo } from 'react'
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
 * (9:05) is kept as a choice of its own, so opening the row never changes it.
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
  const options = useMemo(
    () =>
      !value || QUARTER_HOURS.includes(value) ? QUARTER_HOURS : [...QUARTER_HOURS, value].sort(),
    [value],
  )
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled} defaultOpen={autoOpen}>
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
      </SelectContent>
    </Select>
  )
}
