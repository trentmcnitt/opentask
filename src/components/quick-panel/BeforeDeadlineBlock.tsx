'use client'

import { useState } from 'react'
import { DateTime } from 'luxon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import {
  RelativeTargetControl,
  type DaysChoice,
} from '@/components/quick-panel/RelativeTargetControl'
import {
  AFTER_THE_DEADLINE,
  BEFORE_THE_DEADLINE,
  deadlineChipRows,
  periodChoiceLabel,
  pickAfterDeadline,
  pickAt,
  samePick,
  type RelativePick,
  type SlotChoice,
} from '@/lib/relative-target-ui'

/** The one-off control's "days before" choices: the deadline day to two weeks before. */
const MAX_DAYS = 14

/**
 * THE TARGET PICKER'S "BEFORE THE DEADLINE" BLOCK (2026-10-24, plan §9): a
 * one-off with a deadline still ahead gets a target RELATIVE to it — derived
 * from the deadline and moved with it, until a date pick or a pad tap makes
 * it fixed again (ruling 1). Above the calendar:
 *
 *   BEFORE THE DEADLINE
 *   The day before    [Morning · 9:00 AM] [Evening · 8:30 PM]
 *   The deadline day  [Morning · 9:00 AM] [Evening · 8:30 PM]  (greyed: after the deadline)
 *   [the day before ▾] at [Evening · 8:30 PM ▾]   [Set Mon Nov 2, 8:30 PM]
 *
 * The chips are the user's reminder periods; a tap stages that pick and
 * closes, like the calendar's Set Date. A moment already past is left out; a
 * deadline-day period after the deadline is greyed, its reason said beside
 * the row. Then the full control (`RelativeTargetControl`), whose Set button
 * names the moment it gives — "already past" when it is (ruling 3: the task
 * is then over target at once). This REPLACES the editor picker's old
 * "Morning of the deadline" pick (ruling 4); the defer menu and the Today
 * picker keep theirs.
 *
 * `slots` is empty on a task the user doesn't own (its periods are the
 * owner's): no chips, and the control offers custom times only.
 */
export function BeforeDeadlineBlock({
  deadlineAt,
  timezone,
  slots,
  current,
  currentIsSet,
  onPick,
}: {
  deadlineAt: string
  timezone: string
  slots: readonly SlotChoice[]
  /** What the control opens on: the staged or stored pick, else the default. */
  current: RelativePick
  /** The current pick is the task's own (staged or stored) — its chip shows pressed. */
  currentIsSet: boolean
  onPick: (pick: RelativePick) => void
}) {
  const [draft, setDraft] = useState<RelativePick>(current)
  const now = new Date()
  const rows = deadlineChipRows(deadlineAt, slots, timezone, now)
  const daysChoices: DaysChoice[] = Array.from({ length: MAX_DAYS + 1 }, (_, days) => ({
    days,
    refused: pickAfterDeadline({ days, time: draft.time }, deadlineAt, timezone)
      ? AFTER_THE_DEADLINE
      : null,
  }))
  const refused = pickAfterDeadline(draft, deadlineAt, timezone)
  const at = pickAt(draft, deadlineAt, timezone)
  const past = Date.parse(at) <= now.getTime()
  const when = DateTime.fromISO(at, { zone: 'utc' }).setZone(timezone).toFormat('ccc LLL d, h:mm a')
  return (
    // `w-0 min-w-full`: the block takes the popover's (the calendar's) width
    // and adds none of its own, so chips wrap instead of widening it past a
    // phone's edge (the old quick pick's rule).
    <div className="w-0 min-w-full space-y-2 border-b px-3 py-2" data-before-deadline>
      <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
        {BEFORE_THE_DEADLINE}
      </p>
      {rows.map((row) => {
        const greyed = row.chips.some((c) => c.afterDeadline)
        return (
          <div key={row.days} data-chip-row={row.days} className="space-y-1">
            <p className="text-xs">
              {row.title}
              {greyed && (
                <span className="text-muted-foreground"> · greyed: {AFTER_THE_DEADLINE}</span>
              )}
            </p>
            {/* Two to a row at the calendar's width (one chip a line made the
                picker twice as tall); a long name wraps inside its chip. */}
            <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-1.5">
              {row.chips.map((chip) => {
                const pressed = currentIsSet && samePick(chip.pick, current)
                return (
                  <button
                    key={chip.slot.id}
                    type="button"
                    data-before-deadline-chip
                    disabled={chip.afterDeadline}
                    aria-pressed={pressed}
                    aria-label={`${row.title}, ${periodChoiceLabel(chip.slot)}${chip.afterDeadline ? `, ${AFTER_THE_DEADLINE}` : ''}`}
                    onClick={() => onPick(chip.pick)}
                    className={cn(
                      'min-w-0 rounded-md border px-2 py-1 text-left text-xs leading-tight transition-colors',
                      'hover:bg-accent active:bg-accent disabled:cursor-not-allowed disabled:opacity-40',
                      pressed && 'border-foreground/40 bg-accent font-semibold',
                    )}
                  >
                    {chip.slot.label}{' '}
                    <span className="text-muted-foreground whitespace-nowrap">
                      · {formatClockTime(chip.slot.start_time)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      <div className="space-y-1.5 pt-0.5">
        <RelativeTargetControl
          pick={draft}
          daysChoices={daysChoices}
          slots={slots}
          timeRefused={(time) =>
            pickAfterDeadline({ days: draft.days, time }, deadlineAt, timezone)
          }
          onDays={(days) => setDraft((d) => ({ ...d, days }))}
          onTime={(time, slotId) => setDraft((d) => ({ ...d, time, slot_id: slotId }))}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-relative-set
          disabled={refused}
          onClick={() => onPick(draft)}
          className="h-auto min-h-8 w-full justify-start py-1.5 text-left whitespace-normal"
        >
          {refused ? (
            <span>{AFTER_THE_DEADLINE}</span>
          ) : (
            <span>
              Set {when}
              {past && <span className="text-over-target"> · already past</span>}
            </span>
          )}
        </Button>
      </div>
    </div>
  )
}
