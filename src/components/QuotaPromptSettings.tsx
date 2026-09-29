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
import { parseHHMM, sortSlotsByStart, type TimeSlot } from '@/lib/time-slot-assign'
import { formatMinutes } from '@/lib/reminder-rule'
import { showToast } from '@/lib/toast'

/**
 * Settings → Reminder periods → Default period, and the quota-reminders switch.
 *
 * DEFAULT PERIOD (Trent, 2026-09-28): the period a reminder goes in when
 * nothing says when — a reminder added with just its words (the Reminders
 * quick add, an Apple Shortcut's title-only POST), and one whose text AI
 * enrichment finds no time cue in (`defaultReminderSlot` on the server). It is
 * also where unmet quotas prompt when a quota has not chosen a period, which
 * is where the setting started (2026-09-24, "Quota reminders go in"), so it
 * is stored in `users.quota_prompt_slot_id` (alias `default_reminder_slot_id`
 * in /api/user/preferences). It no longer hides when quota reminders are off:
 * it governs every reminder now, not just quota prompts.
 *
 * QUOTA REMINDERS: unmet quotas also appear as prompts in a reminder period
 * each day (`src/core/tasks/quota-prompts.ts`); the switch turns the whole
 * feature off (Trent wanted it easy to turn off). A quota's own editor
 * overrides the period.
 *
 * Lives under the period list because the choice is one of those periods.
 * The picker shows the RESOLVED period — an unset default, or one pointing at
 * a removed period, shows the first period of the day, which is where the
 * reminders actually go (`resolvePromptSlot`, the server's own rule).
 *
 * Saves on change like the section's other switches; only a failure speaks.
 */
export function QuotaPromptSettings() {
  const { timeSlots } = useTimeSlots()
  const { prefs, save } = useQuotaPromptPrefs()
  const slots = sortSlotsByStart(timeSlots)
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
      {slots.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <label htmlFor="default-reminder-slot" className="text-sm">
              Default period
            </label>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Where a reminder goes when you don&rsquo;t say when
            </div>
          </div>
          {/* Always controlled: '' (Radix's "no value", which shows the
              placeholder) until the prefs load, never undefined — flipping
              from undefined to an id made Radix warn "Select is changing from
              uncontrolled to controlled". */}
          <Select
            value={current ? String(current.id) : ''}
            onValueChange={(value) => void update({ slotId: Number(value) })}
          >
            <SelectTrigger
              id="default-reminder-slot"
              className="w-auto min-w-48"
              aria-label="Default period"
              data-default-reminder-slot
            >
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm">Quota reminders</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Unmet quotas also show up among your reminders each day, in the default period unless a
            quota picks its own
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
    </div>
  )
}
