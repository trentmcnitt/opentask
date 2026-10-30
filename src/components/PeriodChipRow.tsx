'use client'

import { useEffect, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { to12Hour, to24Hour } from '@/lib/time-utils'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * THE PERIODS IN A CUSTOM PICKER (Trent, 2026-10-30: "it'd be nice to be able
 * to pick from my periods… a horizontally scrolling thing. That way, it always
 * takes up the same amount of space no matter how many periods you have"):
 * one row of buttons under the Time field — the T1 menu's (`target-menu.ts`)
 * short names and times — that scrolls sideways. A tap sets the time fields to
 * that period's start and leaves the picked date alone; the period the fields
 * match is shown pressed (no period is when they match none).
 *
 * THE DEFAULT TASK TIME is offered too (Trent, 2026-10-30: "it should offer a
 * default pill or something. If a default pill is a period, the period should
 * just be bolded"): the period that starts at it is BOLD; when none does, a
 * "Default · 6:30" pill leads the row. Bold (the default) and pressed (what
 * the fields say) are separate looks, so one button can be both.
 *
 * THE ROW SAYS IT SCROLLS (2026-10-30): an edge with more periods past it
 * fades out (`useRowEdges`), and on open the row scrolls the pressed button —
 * else the default — into the middle, so the one that matters is never off to
 * the side.
 */
export function PeriodChipRow({
  slots,
  value,
  defaultTime,
  onPick,
}: {
  slots: readonly TimeSlot[]
  /** The time fields now, HH:MM (24h). */
  value: string
  /** The user's Default task time, HH:MM (`morningTime`). */
  defaultTime: string
  onPick: (startTime: string) => void
}) {
  const ordered = [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))
  // The Default task time as a period, else its own pill at the start.
  const choices = ordered.some((s) => s.start_time === defaultTime)
    ? ordered
    : [{ start_time: defaultTime, label: 'Default' } as TimeSlot, ...ordered]
  const { ref, edges } = useRowEdges(choices.map((c) => c.start_time).join())
  // `w-0 min-w-full`: the row fills the picker but adds nothing to its width,
  // so a long list scrolls instead of widening the popover past the screen.
  return (
    <div className="w-0 min-w-full">
      <div
        role="group"
        aria-label="Periods"
        data-picker-periods
        data-more-start={edges.start ? '' : undefined}
        data-more-end={edges.end ? '' : undefined}
        ref={ref}
        style={{ maskImage: edgeFade(edges), WebkitMaskImage: edgeFade(edges) }}
        className="-mx-3 flex gap-1.5 overflow-x-auto overscroll-x-contain px-3 pt-2 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {choices.map((slot) => {
          const on = slot.start_time === value
          const isDefault = slot.start_time === defaultTime
          return (
            <button
              key={`${slot.label}-${slot.start_time}`}
              type="button"
              aria-pressed={on}
              aria-label={`${slot.label} ${slot.start_time}${isDefault ? ', the default task time' : ''}`}
              data-picker-period={slot.start_time}
              data-picker-default={isDefault ? '' : undefined}
              onClick={() => onPick(slot.start_time)}
              className={cn(
                'shrink-0 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors',
                on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                isDefault && 'font-bold',
              )}
            >
              {slot.label}
              <span className={cn('ml-1', on ? 'opacity-80' : 'text-muted-foreground')}>
                {DateTime.fromFormat(slot.start_time, 'HH:mm').toFormat('h:mm')}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The fade on each edge with more past it (a mask: the buttons go transparent). */
function edgeFade({ start, end }: { start: boolean; end: boolean }): string | undefined {
  if (!start && !end) return undefined
  const from = start ? 'transparent, black 1.5rem' : 'black'
  const to = end ? 'black calc(100% - 1.5rem), transparent' : 'black'
  return `linear-gradient(to right, ${from}, ${to})`
}

/**
 * Which edges of the scrolling row have more past them, kept current on
 * scroll and resize; and, each time the list changes (the periods arrive
 * after the picker opens), the pressed button — else the default — scrolled
 * to the middle. The 1px is sub-pixel scroll positions, which can stop a
 * fraction short of the end.
 */
function useRowEdges(listKey: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const target =
      el.querySelector<HTMLElement>('[aria-pressed="true"]') ??
      el.querySelector<HTMLElement>('[data-picker-default]')
    if (target) el.scrollLeft = target.offsetLeft - (el.clientWidth - target.offsetWidth) / 2
    const measure = () =>
      setEdges({
        start: el.scrollLeft > 1,
        end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    el.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', measure)
    }
  }, [listKey])
  return { ref, edges }
}

/**
 * `PeriodChipRow` over a picker's 12-hour time fields (hour, minute, AM/PM):
 * reads them as HH:MM and sets all three from a pick. Both custom pickers use
 * it (`DateTimePicker`, the menu's Custom…).
 */
export function PeriodRowForFields({
  slots,
  hour12,
  minute,
  period,
  defaultTime,
  onSet,
}: {
  slots: readonly TimeSlot[]
  hour12: number
  minute: number
  period: 'AM' | 'PM'
  defaultTime: string
  onSet: (hour12: number, minute: number, period: 'AM' | 'PM') => void
}) {
  const value = `${String(to24Hour(hour12, period)).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  return (
    <PeriodChipRow
      slots={slots}
      value={value}
      defaultTime={defaultTime}
      onPick={(startTime) => {
        const [h, m] = startTime.split(':').map(Number)
        onSet(to12Hour(h), m, h >= 12 ? 'PM' : 'AM')
      }}
    />
  )
}
