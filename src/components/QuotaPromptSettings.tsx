'use client'

import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useQuotaPromptPrefs } from '@/hooks/useQuotaPromptPrefs'
import { resolvePromptSlot } from '@/lib/quota-prompts'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { formatMinutes } from '@/lib/reminder-rule'
import { showToast } from '@/lib/toast'

/**
 * Settings → Reminder periods → quota reminders (2026-09-24).
 *
 * Unmet quotas also appear as prompts in a reminder period each day
 * (`src/core/tasks/quota-prompts.ts`). Two settings, both the user's own:
 * the switch for the whole feature (Trent wanted it easy to turn off), and
 * the period prompts go in when a quota has not chosen one ("Quota reminders
 * go in: Morning"). A quota's own editor overrides the period.
 *
 * Lives under the period list because the choice is one of those periods.
 * The picker shows the RESOLVED period — an unset default, or one pointing at
 * a removed period, shows the first period of the day, which is where the
 * prompts actually are (`resolvePromptSlot`, the server's own rule).
 *
 * Saves on change like the section's other switches; only a failure speaks.
 */
export function QuotaPromptSettings() {
  const { timeSlots } = useTimeSlots()
  const { prefs, save } = useQuotaPromptPrefs()
  const slots = [...timeSlots].sort(
    (a, b) => (parseHHMM(a.start_time) ?? 0) - (parseHHMM(b.start_time) ?? 0),
  )
  const index = prefs ? resolvePromptSlot(slots, prefs.slotId, null) : -1
  const current: TimeSlot | null = index >= 0 ? slots[index] : null

  const update = async (patch: { enabled?: boolean; slotId?: number }) => {
    try {
      await save(patch)
    } catch (err) {
      showToast({
        message: err instanceof Error && err.message ? err.message : 'Save failed',
        type: 'error',
      })
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm">Quota reminders</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Unmet quotas also show up among your reminders each day
          </div>
        </div>
        <Switch
          checked={prefs?.enabled ?? true}
          disabled={!prefs}
          onCheckedChange={(checked) => void update({ enabled: checked })}
          aria-label="Quota reminders"
          data-quota-prompts-switch
        />
      </div>
      {prefs?.enabled && slots.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="quota-prompt-slot" className="text-sm">
            Quota reminders go in
          </label>
          <Select
            value={current ? String(current.id) : undefined}
            onValueChange={(value) => void update({ slotId: Number(value) })}
          >
            <SelectTrigger id="quota-prompt-slot" className="w-48" data-quota-prompt-slot>
              <SelectValue placeholder="Choose a period" />
            </SelectTrigger>
            <SelectContent>
              {slots.map((slot) => (
                <SelectItem key={slot.id} value={String(slot.id)}>
                  {slot.label}
                  <span className="text-muted-foreground ml-1 text-xs">
                    {formatMinutes(parseHHMM(slot.start_time) ?? 0)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
