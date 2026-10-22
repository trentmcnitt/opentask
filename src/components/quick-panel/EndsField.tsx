'use client'

import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { NumberBox } from '@/components/quick-panel/NumberBox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { RuleDraft, RuleEndType } from '@/lib/rrule-draft'

/** "Dec 31, 2026" — an end date always said exactly (Trent's ruling, 2026-10-22). */
export function endDateWords(day: string): string {
  const d = DateTime.fromISO(day, { zone: 'utc' })
  return d.isValid ? d.toFormat('LLL d, yyyy') : day
}

/**
 * EVERY-TIME MODE'S "ENDS" ROW (2026-10-22, editor PR 4c; repeat ends):
 * Never / After N times / On date. Split out of the old recurrence picker's
 * `EndConditionPicker`; the end now travels as the task's `repeat_count` /
 * `repeat_until` fields, never in the rule (`draftToPatch`).
 *
 * The rulings (plan-repeat-ends RULINGS 10-22): the editor always says the
 * EXACT end date ("Ends Dec 31, 2026" — never "until December"), and a count
 * says how far it has got: "2 of 6 so far" (`repeat_count_used`, done or
 * skipped; a count set fresh starts with this occurrence as #1). A date
 * before today is refused inline by `draftProblem` (the `min` on the input is
 * only a convenience).
 */
export function EndsField({
  rule,
  storedCount,
  used,
  today,
  dirty,
  disabled,
  onEnds,
}: {
  rule: RuleDraft
  /** The count the task has now (null: none), for "2 of 6 so far". */
  storedCount: number | null
  /** `repeat_count_used` — occurrences closed since the count was set. */
  used: number
  /** Today, local (yyyy-MM-dd): the date input's minimum. */
  today: string
  dirty: boolean
  disabled: boolean
  onEnds: (end: { endType: RuleEndType; endCount?: number; endDate?: string }) => void
}) {
  const dirtyText = dirty && 'font-medium text-blue-500'
  // The count's progress reads from the stored count; a count set fresh starts at 0 used.
  const sofar = storedCount !== null ? used : 0
  return (
    <div className="flex flex-wrap items-center gap-2" data-every-time-ends>
      <Select
        value={rule.endType}
        disabled={disabled}
        onValueChange={(v) => onEnds({ endType: v as RuleEndType })}
      >
        <SelectTrigger size="sm" aria-label="Ends" className={cn('min-w-[6.5rem]', dirtyText)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="never">Never</SelectItem>
          <SelectItem value="count">After…</SelectItem>
          <SelectItem value="date">On date…</SelectItem>
        </SelectContent>
      </Select>
      {rule.endType === 'count' && (
        <>
          <label className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <NumberBox
              value={rule.endCount}
              min={1}
              max={999}
              disabled={disabled}
              dirty={dirty}
              label="How many times"
              onChange={(n) => onEnds({ endType: 'count', endCount: n })}
              className="w-16"
            />
            times
          </label>
          <span data-every-time-ends-progress className="text-muted-foreground text-xs">
            {storedCount !== null
              ? `${sofar} of ${rule.endCount} so far`
              : 'starting with this one'}
          </span>
        </>
      )}
      {rule.endType === 'date' && (
        <>
          <Input
            type="date"
            min={today}
            value={rule.endDate}
            disabled={disabled}
            aria-label="Last day"
            onChange={(e) => onEnds({ endType: 'date', endDate: e.target.value })}
            className={cn('h-8 w-40', dirtyText)}
          />
          {rule.endDate && (
            <span data-every-time-ends-date className="text-muted-foreground text-xs">
              Ends {endDateWords(rule.endDate)}
            </span>
          )}
        </>
      )}
    </div>
  )
}
