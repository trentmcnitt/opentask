'use client'

import { cn } from '@/lib/utils'
import { NumberBox } from '@/components/quick-panel/NumberBox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DAYS_OF_WEEK,
  monthWeekdayLabel,
  type RuleDraft,
  type RuleFrequency,
} from '@/lib/rrule-draft'

const FREQUENCIES: Array<{ value: RuleFrequency; label: string; unit: [string, string] }> = [
  { value: 'DAILY', label: 'Daily', unit: ['day', 'days'] },
  { value: 'WEEKLY', label: 'Weekly', unit: ['week', 'weeks'] },
  { value: 'MONTHLY', label: 'Monthly', unit: ['month', 'months'] },
  { value: 'YEARLY', label: 'Yearly', unit: ['year', 'years'] },
]

/** "1st", "2nd", … for the month-day select. */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

/**
 * EVERY-TIME MODE'S "HOW OFTEN" ROW (2026-10-22, editor PR 4c; mock E):
 * "Weekly ▾ every 1 week" with the day chips under it, or "Monthly ▾ on the
 * 1st Sat ▾". Split out of the old `RecurrencePicker` (its frequency select,
 * interval, day chips and `MonthDaySelect`), with no "None" choice: a rule is
 * removed by "Stop repeating", never by a frequency (the picker's "None" was
 * a second, hidden way to delete one).
 *
 * The day chips are `aria-pressed` toggles named with the full day
 * ("Friday"), 36px tall and sharing the row's width (at most 276px: 7 × 36
 * + 6 × 4), so seven fit a 375px phone and the desktop popover alike. Hidden for from_completion, which schedules N weeks from the
 * completion and ignores the days (they are kept for a switch back).
 *
 * A monthly rule on a weekday of the month ("the 1st Sat": BYDAY=1SA) is
 * carried through as its own choice until a day of the month is picked
 * (`MonthlyWeekday`, src/lib/rrule-draft.ts).
 */
export function HowOftenField({
  rule,
  fromCompletion,
  dirty,
  disabled,
  onFreq,
  onInterval,
  onToggleDay,
  onMonthDay,
}: {
  rule: RuleDraft
  fromCompletion: boolean
  /** Which parts differ from the saved schedule (drawn blue). */
  dirty: { freq: boolean; interval: boolean; days: boolean; monthDay: boolean }
  disabled: boolean
  onFreq: (freq: RuleFrequency) => void
  onInterval: (n: number) => void
  onToggleDay: (day: string) => void
  onMonthDay: (day: number | 'last') => void
}) {
  const freq = FREQUENCIES.find((f) => f.value === rule.freq)!
  return (
    <div className="space-y-2" data-every-time-how-often>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={rule.freq}
          onValueChange={(v) => onFreq(v as RuleFrequency)}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            aria-label="How often"
            className={cn('min-w-[6rem]', dirty.freq && 'font-medium text-blue-500')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FREQUENCIES.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="text-muted-foreground flex items-center gap-1.5 text-sm">
          every
          <NumberBox
            value={rule.interval}
            min={1}
            max={99}
            disabled={disabled}
            dirty={dirty.interval}
            label={`Every how many ${freq.unit[1]}`}
            onChange={onInterval}
            className="w-12"
          />
          {rule.interval === 1 ? freq.unit[0] : freq.unit[1]}
        </label>
        {rule.freq === 'MONTHLY' && (
          <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
            on the
            <MonthDaySelect
              rule={rule}
              dirty={dirty.monthDay}
              disabled={disabled}
              onMonthDay={onMonthDay}
            />
          </span>
        )}
      </div>
      {rule.freq === 'WEEKLY' && !fromCompletion && (
        <div
          className="grid max-w-[17.25rem] grid-cols-7 gap-1"
          role="group"
          aria-label="Days of the week"
        >
          {DAYS_OF_WEEK.map((day) => {
            const on = rule.days.includes(day.id)
            return (
              <button
                key={day.id}
                type="button"
                aria-pressed={on}
                aria-label={day.full}
                title={day.full}
                disabled={disabled}
                onClick={() => onToggleDay(day.id)}
                className={cn(
                  'flex h-9 w-full min-w-0 items-center justify-center rounded-md border text-xs font-medium transition-colors disabled:opacity-50',
                  on
                    ? dirty.days
                      ? 'border-blue-500 bg-blue-500 text-white'
                      : 'bg-foreground text-background border-foreground'
                    : 'hover:bg-accent active:bg-accent',
                )}
              >
                {day.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The monthly day: 1st–31st, the last day, and — only while the rule is on a
 * weekday of the month — that rule's own choice ("1st Sat"), shown selected.
 */
function MonthDaySelect({
  rule,
  dirty,
  disabled,
  onMonthDay,
}: {
  rule: RuleDraft
  dirty: boolean
  disabled: boolean
  onMonthDay: (day: number | 'last') => void
}) {
  const value = rule.monthWeekday ? 'weekday' : String(rule.monthDay)
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        if (v !== 'weekday') onMonthDay(v === 'last' ? 'last' : parseInt(v))
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Day of the month"
        className={cn('min-w-[5.5rem]', dirty && 'font-medium text-blue-500')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {rule.monthWeekday && (
          <SelectItem value="weekday">{monthWeekdayLabel(rule.monthWeekday, false)}</SelectItem>
        )}
        {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
          <SelectItem key={day} value={String(day)}>
            {ordinal(day)}
          </SelectItem>
        ))}
        <SelectItem value="last">last day</SelectItem>
      </SelectContent>
    </Select>
  )
}
