'use client'

import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TimeSelect } from '@/components/quick-panel/TimeSelect'
import { relativeDaysWords } from '@/lib/editor-target-labels'
import {
  AFTER_THE_DEADLINE,
  periodChoiceLabel,
  pickSlot,
  type RelativePick,
  type SlotChoice,
} from '@/lib/relative-target-ui'
import { sortSlotsByStart } from '@/lib/time-slot-assign'

/** One "days before" choice, greyed with its reason when the server would refuse it. */
export interface DaysChoice {
  days: number
  /** "after the deadline", "overlaps the previous one", or null. */
  refused: string | null
}

/**
 * A RELATIVE TARGET'S CONTROL (2026-10-24, plan-relative-targets §9):
 *
 *   [the day before ▾] at [Evening · 8:30 PM ▾]
 *   [3 days before ▾]  at [Custom time ▾] [6:00 PM ▾]
 *
 * ONE control for both places a relative target is set — every-time mode's
 * Target row on a deadline-anchored repeat, and the target picker's "Before
 * the deadline" block on a one-off — so repeats and one-offs share one
 * control and one stored shape (`target_days_before` / `target_time` /
 * `target_slot_id`).
 *
 * The time half copies Settings' link-or-custom rows (`AnchorTimeRow`): a
 * select of the user's periods first ("Evening · 8:30 PM"), then "Custom
 * time…"; a time field (`TimeSelect`, quarter hours and "Exact time…")
 * appears only for a custom time. Choosing "Custom time…" on a linked pick
 * unlinks it AT THE TIME IT READS, so nothing jumps. With no periods to offer
 * (none yet, or a task someone else owns — its periods are the owner's) the
 * time field alone.
 *
 * `timeRefused` greys a period or time the server would refuse — on the
 * deadline day, one after the deadline ("after the deadline").
 *
 * Accessible names: "Days before the deadline", "Target follows" (the period
 * select) and "Target time" (the time field) — never two that contain each
 * other, so a test (or a screen reader user) asks for exactly one.
 */
export function RelativeTargetControl({
  pick,
  daysChoices,
  slots,
  timeRefused,
  daysDirty = false,
  timeDirty = false,
  disabled = false,
  timeTestId,
  onDays,
  onTime,
}: {
  pick: RelativePick
  daysChoices: DaysChoice[]
  /** The periods the user may link to (empty: custom times only). */
  slots: readonly SlotChoice[]
  timeRefused?: (time: string) => boolean
  daysDirty?: boolean
  timeDirty?: boolean
  disabled?: boolean
  timeTestId?: string
  onDays: (days: number) => void
  /** A period's start with its id (linked), or a custom time with null. */
  onTime: (time: string, slotId: number | null) => void
}) {
  const all = daysChoices.some((c) => c.days === pick.days)
    ? daysChoices
    : [...daysChoices, { days: pick.days, refused: null }].sort((a, b) => a.days - b.days)
  return (
    <div className="flex flex-wrap items-center gap-2" data-relative-target-control>
      <Select
        value={String(pick.days)}
        disabled={disabled}
        onValueChange={(v) => onDays(parseInt(v))}
      >
        <SelectTrigger
          size="sm"
          aria-label="Days before the deadline"
          className={cn('min-w-[8rem]', daysDirty && 'font-medium text-blue-500')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {all.map((c) => (
            <SelectItem
              key={c.days}
              value={String(c.days)}
              disabled={c.refused !== null && c.days !== pick.days}
              aria-disabled={c.refused !== null || undefined}
              data-refused={c.refused ?? undefined}
            >
              {relativeDaysWords(c.days)}
              {c.refused && (
                <span className="text-muted-foreground ml-1 text-xs">— {c.refused}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground text-sm">at</span>
      <PeriodOrTimeSelect
        pick={pick}
        slots={slots}
        refused={timeRefused}
        dirty={timeDirty}
        disabled={disabled}
        testId={timeTestId}
        onChange={onTime}
      />
    </div>
  )
}

const CUSTOM = 'custom'

/**
 * [Evening · 8:30 PM ▾] or [Custom time ▾] [6:00 PM ▾] — see the header. A
 * link to a period not in `slots` (removed meanwhile, or the owner's on a
 * shared task) reads as its time, custom.
 */
export function PeriodOrTimeSelect({
  pick,
  slots,
  refused,
  dirty,
  disabled,
  testId,
  onChange,
}: {
  pick: Pick<RelativePick, 'time' | 'slot_id'>
  slots: readonly SlotChoice[]
  refused?: (time: string) => boolean
  dirty: boolean
  disabled: boolean
  testId?: string
  onChange: (time: string, slotId: number | null) => void
}) {
  const ordered = sortSlotsByStart(slots)
  const linked = pickSlot({ days: 0, ...pick }, ordered)
  const timeField = (
    <TimeSelect
      label="Target time"
      value={pick.time}
      dirty={dirty}
      disabled={disabled}
      testId={testId}
      refused={refused}
      refusedReason={AFTER_THE_DEADLINE}
      onChange={(time) => onChange(time, null)}
    />
  )
  if (ordered.length === 0) return timeField
  return (
    <>
      <Select
        value={linked ? String(linked.id) : CUSTOM}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === CUSTOM) {
            onChange(pick.time, null)
            return
          }
          const slot = ordered.find((s) => String(s.id) === v)
          if (slot) onChange(slot.start_time, slot.id)
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label="Target follows"
          data-relative-target-follows
          className={cn('min-w-[8rem]', dirty && 'font-medium text-blue-500')}
        >
          <SelectValue>{linked ? periodChoiceLabel(linked) : 'Custom time'}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ordered.map((slot) => {
            const no = refused?.(slot.start_time) ?? false
            return (
              <SelectItem
                key={slot.id}
                value={String(slot.id)}
                disabled={no}
                data-refused={no ? AFTER_THE_DEADLINE : undefined}
              >
                {periodChoiceLabel(slot)}
                {no && (
                  <span className="text-muted-foreground ml-1 text-xs">— {AFTER_THE_DEADLINE}</span>
                )}
              </SelectItem>
            )
          })}
          <SelectItem value={CUSTOM}>Custom time…</SelectItem>
        </SelectContent>
      </Select>
      {!linked && timeField}
    </>
  )
}
