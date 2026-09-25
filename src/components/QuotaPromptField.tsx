'use client'

import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { assignDailyNumbers, resolvePromptSlot } from '@/lib/quota-prompts'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useQuotaPromptPrefs } from '@/hooks/useQuotaPromptPrefs'
import { useState } from 'react'
import { quotaPeriodOf, type QuotaFreq } from '@/lib/track'
import type { QuotaPromptConfig, Task } from '@/types'

/**
 * The quota editor's "Remind me daily" section (quota reminders, 2026-09-24).
 *
 * An unmet quota also shows up as a prompt in a reminder period each day.
 * Here the user turns that off for this quota, or chooses where it goes:
 *
 * - Weekly, monthly (and the rest): ONE prompt a day, in the period picked
 *   from chips — the same chips, in the same look, as this editor's period
 *   and label choices directly above.
 * - Daily with a target of N: N prompts spread over the day, so a picker PER
 *   NUMBER ("1st · Morning", "2nd · Midday"). A select rather than chips:
 *   N rows of five chips each would bury the editor.
 *
 * Every picker shows the RESOLVED period — where the prompt actually is now,
 * by the server's own rule (`resolvePromptSlot` / `assignDailyNumbers`) —
 * and only a choice the user makes is written. An untouched quota keeps a
 * NULL config, i.e. "follow the defaults", so changing the default period in
 * Settings still moves it.
 */
export function QuotaPromptField({
  value,
  onChange,
  daily,
  target,
  enabledByDefault,
  slots,
  userDefault,
}: {
  value: QuotaPromptConfig | null
  onChange: (next: QuotaPromptConfig) => void
  /** Resets every day (FREQ=DAILY, no INTERVAL): numbered prompts. */
  daily: boolean
  /** How many numbered prompts a daily quota has. */
  target: number
  /** On for daily/weekly/monthly, off for yearly and period-less. */
  enabledByDefault: boolean
  /** The user's periods, by start time. */
  slots: TimeSlot[]
  /** `users.quota_prompt_slot_id` — where an unassigned prompt goes. */
  userDefault: number | null
}) {
  const enabled = value?.enabled ?? enabledByDefault
  const set = (patch: Partial<QuotaPromptConfig>) => onChange({ ...(value ?? {}), ...patch })

  return (
    <fieldset className="space-y-2" aria-label="Quota reminders" data-quota-prompt-field>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Remind me daily</span>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => set({ enabled: checked })}
          aria-label="Remind me daily"
          data-quota-prompt-enabled
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {enabled
          ? 'Shows up among your reminders until it is met.'
          : 'Only on the Quotas page — no daily reminder.'}
      </p>
      {enabled && slots.length > 0 && daily && (
        <NumberPickers
          value={value}
          target={target}
          slots={slots}
          userDefault={userDefault}
          onPick={(k, slotId) =>
            set({ numbers: { ...(value?.numbers ?? {}), [String(k)]: slotId } })
          }
        />
      )}
      {enabled && slots.length > 0 && !daily && (
        <div className="flex flex-wrap gap-1.5">
          {slots.map((slot, i) => {
            const pressed = resolvePromptSlot(slots, value?.slot_id, userDefault) === i
            return (
              <button
                key={slot.id}
                type="button"
                onClick={() => set({ slot_id: slot.id })}
                aria-pressed={pressed}
                data-quota-prompt-slot={slot.id}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm transition-colors',
                  pressed
                    ? 'border-foreground bg-foreground text-background'
                    : 'hover:border-foreground/40',
                )}
              >
                {slot.label}
              </button>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

/**
 * The editor's staged "Remind me daily" setting for one quota: the draft, and
 * whether it differs from what is saved (compared by content — the draft is
 * rebuilt on every change). NULL until touched, so an untouched quota keeps
 * following the defaults.
 */
export function usePromptDraft(task: Task | null) {
  const saved = task?.quota_prompt_config ?? null
  const [config, setConfig] = useState<QuotaPromptConfig | null>(saved)
  return {
    config,
    setConfig,
    touched: JSON.stringify(config) !== JSON.stringify(saved),
    reset: () => setConfig(saved),
  }
}

/**
 * `QuotaPromptField` fed from the editor's own draft: whether the quota is
 * daily in the counting sense, what its default is, and the user's periods.
 */
export function QuotaPromptSection({
  value,
  onChange,
  period,
  periodTouched,
  task,
  target,
}: {
  value: QuotaPromptConfig | null
  onChange: (next: QuotaPromptConfig) => void
  /** The editor's period — its draft, not the saved rule. */
  period: QuotaFreq | null
  periodTouched: boolean
  /** The saved quota (null when creating), for its rule's INTERVAL. */
  task: Task | null
  /** The draft target; NaN while the field is empty. */
  target: number
}) {
  const { slots, userDefault } = usePromptSetup()
  // A period chosen in the editor is a bare FREQ (interval 1); an untouched
  // one keeps the quota's own rule, INTERVAL included — every other day is
  // not "daily" for numbering.
  const interval = periodTouched ? 1 : (quotaPeriodOf(task?.rrule)?.interval ?? 1)
  return (
    <QuotaPromptField
      value={value}
      onChange={onChange}
      daily={period === 'DAILY' && interval === 1}
      target={Number.isFinite(target) && target >= 1 ? target : 1}
      enabledByDefault={period !== null && period !== 'YEARLY'}
      slots={slots}
      userDefault={userDefault}
    />
  )
}

/**
 * What the section needs from outside the quota: the user's periods (by
 * start) and their default prompt period. Both cached hooks, so opening an
 * editor costs no extra wait once either surface has loaded them.
 */
export function usePromptSetup(): { slots: TimeSlot[]; userDefault: number | null } {
  const { timeSlots } = useTimeSlots()
  const { prefs } = useQuotaPromptPrefs()
  const slots = [...timeSlots].sort(
    (a, b) => (parseHHMM(a.start_time) ?? 0) - (parseHHMM(b.start_time) ?? 0),
  )
  return { slots, userDefault: prefs?.slotId ?? null }
}

/** More than this many numbered prompts is a counter, not a set of reminders. */
const MAX_NUMBER_PICKERS = 20

export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function NumberPickers({
  value,
  target,
  slots,
  userDefault,
  onPick,
}: {
  value: QuotaPromptConfig | null
  target: number
  slots: TimeSlot[]
  userDefault: number | null
  onPick: (k: number, slotId: number) => void
}) {
  const count = Math.min(Math.max(1, target), MAX_NUMBER_PICKERS)
  const placed = assignDailyNumbers(count, slots, value, userDefault)
  return (
    <div className="grid grid-cols-[auto_minmax(0,12rem)] items-center gap-x-3 gap-y-1.5">
      {placed.map((slotIndex, i) => {
        const k = i + 1
        const slot = slotIndex >= 0 ? slots[slotIndex] : null
        return (
          <div key={k} className="contents">
            <span className="text-muted-foreground text-sm tabular-nums">{ordinal(k)}</span>
            <Select
              value={slot ? String(slot.id) : undefined}
              onValueChange={(v) => onPick(k, Number(v))}
            >
              <SelectTrigger
                className="h-8 w-full"
                aria-label={`Period for the ${ordinal(k)} reminder`}
                data-quota-prompt-number={k}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {slots.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}
