'use client'

import { useState } from 'react'
import { DateTime } from 'luxon'
import { CalendarDays, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { leadDaysWords } from '@/lib/editor-target-labels'
import { cn } from '@/lib/utils'

/**
 * THE STARTS ROW'S DATE (2026-11-12, Trent's E3): on a deadline one-off with
 * no target the quick panel's "Lead time" row is "Starts", and says when the
 * task starts showing on the Due page in one of three ways — Default, Days
 * (the stepper, `LeadRow` in ThisOneFields) or A DATE, drawn here:
 *
 *   Starts   [▦ Fri Jan 1 ✕]  89 days before   Days instead
 *            Comes round weekly from Sat Jan 9 until Sat Mar 27, then daily
 *
 * The chip opens the calendar again; its ✕ goes back to Default; "Days
 * instead" switches to the stepper. In the Default and Days forms the row
 * ends with "Pick a date" (`PickStartDate`). The calendar greys the days
 * that cannot be a start: before today, and the last two days before the
 * deadline (the safety net; the latest start is D−2, as Defer's).
 * (restates RULE START-1, home: src/lib/task-segments.ts)
 * (restates RULE START-2, home: src/lib/task-segments.ts)
 */
export interface StartsProps {
  /** The picked date, staged or stored — null in the Default and Days forms. */
  date: { day: string; chip: string; daysBefore: number; line: string } | null
  /** The OpenTask day today, and the latest day a start may be (D−2); null = none can be picked. */
  today: string
  latest: string | null
  onPick: (day: string) => void
  /** Back to Default (the chip's ✕). */
  onClear: () => void
  /** "Days instead": the stepper, on the default lead. */
  onDaysInstead: () => void
}

const QUIET_BUTTON =
  'text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded px-1.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40'

/** Whether any day can be picked (a deadline two or more days out). */
function pickable(starts: StartsProps): boolean {
  return starts.latest !== null && starts.latest >= starts.today
}

/** "Pick a date", at the end of the Default / Days form. Nothing when no day can be a start. */
export function PickStartDate({ starts, disabled }: { starts: StartsProps; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  if (!pickable(starts)) return null
  return (
    <>
      <button
        type="button"
        data-starts-pick
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(QUIET_BUTTON, 'inline-flex items-center gap-1')}
      >
        <CalendarDays className="size-3.5" aria-hidden />
        Pick a date
      </button>
      {open && <StartDatePicker starts={starts} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The date form: the chip, how far ahead of the deadline it is, "Days instead", and the line. */
export function StartsDateRow({
  starts,
  staged,
  disabled,
}: {
  starts: StartsProps & { date: NonNullable<StartsProps['date']> }
  staged: boolean
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const { date } = starts
  const tone = staged ? 'font-medium text-blue-500' : 'text-foreground'
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-quick-panel-lead="deadline" data-starts>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="border-border inline-flex items-center rounded-md border">
          <button
            type="button"
            data-starts-date={date.day}
            disabled={disabled || !pickable(starts)}
            onClick={() => setOpen(true)}
            aria-label={`Starts ${date.chip}: change the date`}
            className={cn(
              'hover:bg-foreground/5 inline-flex items-center gap-1 rounded-l-md py-1 pr-1 pl-1.5',
              tone,
            )}
          >
            <CalendarDays className="size-3.5" aria-hidden />
            {date.chip}
          </button>
          <button
            type="button"
            data-starts-clear
            disabled={disabled}
            onClick={starts.onClear}
            aria-label="Remove the start date"
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 inline-flex items-center rounded-r-md px-1 py-1.5 pointer-coarse:px-2 pointer-coarse:py-2"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
        <span data-starts-before className="text-muted-foreground">
          {leadDaysWords(date.daysBefore)}
        </span>
        <button
          type="button"
          data-starts-days
          disabled={disabled}
          onClick={starts.onDaysInstead}
          className={QUIET_BUTTON}
        >
          Days instead
        </button>
      </div>
      <span data-starts-line className="text-muted-foreground">
        {date.line}
      </span>
      {open && <StartDatePicker starts={starts} onClose={() => setOpen(false)} />}
    </div>
  )
}

/**
 * A calendar and nothing else — a start is a day (the deck picker's shape,
 * `DeckDatePicker` in OnDeckButton). The calendar works in the browser's
 * local dates and a start is the user's OpenTask date, so days convert
 * through their parts, never through an instant.
 */
function StartDatePicker({ starts, onClose }: { starts: StartsProps; onClose: () => void }) {
  const { today, latest } = starts
  const toLocal = (day: string) => {
    const d = DateTime.fromISO(day)
    return new Date(d.year, d.month - 1, d.day)
  }
  const fromLocal = (d: Date) =>
    DateTime.local(d.getFullYear(), d.getMonth() + 1, d.getDate()).toFormat('yyyy-MM-dd')
  const allowed = (day: string | null): day is string =>
    !!day && day >= today && latest !== null && day <= latest
  const [selected, setSelected] = useState<string | null>(() =>
    allowed(starts.date?.day ?? null) ? starts.date!.day : null,
  )
  const disabled = [{ before: toLocal(today) }, ...(latest ? [{ after: toLocal(latest) }] : [])]
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Starts on…</DialogTitle>
          <DialogDescription>
            The last two days before the deadline are its safety net, so a start is earlier.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center">
          <Calendar
            mode="single"
            selected={selected ? toLocal(selected) : undefined}
            onSelect={(date) => {
              if (date) setSelected(fromLocal(date))
            }}
            defaultMonth={toLocal(selected ?? today)}
            disabled={disabled}
            // The "today" ring is the OpenTask day, not the browser's calendar day.
            today={toLocal(today)}
          />
        </div>
        <Button
          data-starts-submit
          disabled={!allowed(selected)}
          onClick={() => {
            if (!allowed(selected)) return
            starts.onPick(selected)
            onClose()
          }}
          className="w-full"
        >
          <CalendarDays className="mr-1.5 size-4" />
          Start then
        </Button>
      </DialogContent>
    </Dialog>
  )
}
